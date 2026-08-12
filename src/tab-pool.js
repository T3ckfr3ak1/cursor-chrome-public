'use strict';

const { BrowserView, session } = require('electron');
const { v4: uuidv4 } = require('uuid');
const { SHARED_PARTITION } = require('./config');

function sanitizePartitionKey(id) {
  return String(id || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Pool of up to N agent-owned BrowserViews (and tracked popup BrowserWindows).
 * Default: shared persistent profile so logins/cookies survive restarts.
 *
 * Popups from window.open are adopted as child tabs with the same threadId
 * as the opener — other threads never auto-drive them; use popups() / child tabId.
 */
class TabPool {
  constructor({
    maxTabs,
    partitionPrefix = 'persist:cursor-chrome',
    sharedPartition = SHARED_PARTITION,
    isolateSessions = false,
    warmTarget = 5,
    speedMode = false,
  }) {
    this.maxTabs = maxTabs;
    this.partitionPrefix = partitionPrefix;
    this.sharedPartition = sharedPartition;
    this.isolateSessions = isolateSessions;
    this.warmTarget = Math.max(0, Math.min(warmTarget, maxTabs));
    this.speedMode = !!speedMode;
    /** @type {Map<string, object>} */
    this.tabs = new Map();
    this.activeTabId = null;
    this.hostWindow = null;
    this.onChange = null;
    this.onTabCreated = null; // (tab, wc) => void
    this.onPopup = null; // (popupPublic, parentPublic) => void
    this.chromeHeight = 88;
    /** Right instruction rail width (px). Page views layout left of this. */
    this.sidebarWidth = 0;
    /** Serialize claimOrCreate so concurrent threads cannot race warm steal / create. */
    this._claimLock = Promise.resolve();
    this.navTimeoutMs = 60000;
  }

  _withClaimLock(fn) {
    const run = this._claimLock.then(fn, fn);
    this._claimLock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async _loadUrl(wc, url, timeoutMs = this.navTimeoutMs) {
    const { preferLoginUrl } = require('./login-urls');
    const target = preferLoginUrl(url);
    const ms = Math.max(5000, Number(timeoutMs) || this.navTimeoutMs);
    await Promise.race([
      wc.loadURL(target),
      new Promise((_, reject) => {
        setTimeout(() => {
          const err = new Error(`Navigation timed out after ${ms}ms`);
          err.code = 'NAV_TIMEOUT';
          reject(err);
        }, ms);
      }),
    ]);
    return target;
  }

  setChromeHeight(px) {
    this.chromeHeight = Math.max(60, Number(px) || 88);
  }

  setSidebarWidth(px) {
    this.sidebarWidth = Math.max(0, Math.min(520, Number(px) || 0));
    this.relayoutActive();
  }

  attachWindow(win) {
    this.hostWindow = win;
  }

  _partitionFor({ threadId, isolate }) {
    const useIsolate = isolate === true || (isolate !== false && this.isolateSessions);
    if (!useIsolate) return this.sharedPartition;
    const key = sanitizePartitionKey(threadId) || uuidv4().slice(0, 8);
    return `${this.partitionPrefix}-iso-${key}`;
  }

  list() {
    return [...this.tabs.values()].map((t) => this._public(t));
  }

  get(tabId) {
    const t = this.tabs.get(tabId);
    return t ? this._public(t) : null;
  }

  getView(tabId) {
    return this.tabs.get(tabId)?.view || null;
  }

  getWebContents(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    if (tab.kind === 'popup' && tab.window && !tab.window.isDestroyed()) {
      return tab.window.webContents;
    }
    return tab.view?.webContents || null;
  }

  listPopups(parentTabId) {
    return [...this.tabs.values()]
      .filter((t) => t.parentTabId === parentTabId && t.kind === 'popup')
      .map((t) => this._public(t));
  }

  listForThread(threadId) {
    return [...this.tabs.values()]
      .filter((t) => t.threadId === threadId)
      .map((t) => this._public(t));
  }

  /**
   * Prefer newest open popup for this parent; else the parent itself.
   * Use when a click may have opened window.open and the agent should drive the child.
   */
  resolveOverlayTarget(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    const popups = [...this.tabs.values()]
      .filter((t) => t.parentTabId === tabId && t.kind === 'popup')
      .sort((a, b) => b.createdAt - a.createdAt);
    if (popups.length) return this._public(popups[0]);
    return this._public(tab);
  }

  assertThreadAccess(tabId, threadId) {
    if (!threadId) return this.get(tabId);
    const tab = this.tabs.get(tabId);
    if (!tab) {
      const err = new Error('Tab not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (tab.threadId && tab.threadId !== threadId) {
      const err = new Error(`Tab ${tabId} belongs to thread ${tab.threadId}, not ${threadId}`);
      err.code = 'THREAD_MISMATCH';
      err.tab = this._public(tab);
      throw err;
    }
    return this._public(tab);
  }

  async create({
    url = 'about:blank',
    title = null,
    threadId = null,
    show = true,
    isolate = undefined,
    warm = false,
    profile = 'shared',
    kind = 'tab',
    parentTabId = null,
  } = {}) {
    if (this.tabs.size >= this.maxTabs) {
      const evicted = await this.evictLru();
      if (!evicted && this.tabs.size >= this.maxTabs) {
        const err = new Error(`Tab limit reached (${this.maxTabs}). Release a tab first.`);
        err.code = 'TAB_LIMIT';
        throw err;
      }
    }

    const id = uuidv4();
    let partition;
    if (profile && profile !== 'shared') {
      const { partitionForProfile } = require('./profiles');
      partition = partitionForProfile(profile, threadId);
    } else {
      partition = this._partitionFor({ threadId, isolate });
    }
    const ses = session.fromPartition(partition, { cache: true });
    if (this.speedMode) {
      try {
        require('./network-hub').applySpeedMode(ses, true);
      } catch {
        /* ignore */
      }
    }

    const view = new BrowserView({
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    const tab = {
      id,
      threadId: threadId || null,
      title: title || (warm ? 'Warm' : `Agent Tab ${this.tabs.size + 1}`),
      url: 'about:blank',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      partition,
      view,
      window: null,
      kind: kind === 'popup' ? 'popup' : 'tab',
      parentTabId: parentTabId || null,
      busy: false,
      warm: !!warm,
      profile: profile || 'shared',
    };

    this._wireLifecycle(tab, view.webContents);
    this._wirePopupHandler(tab);

    this.tabs.set(id, tab);

    if (this.hostWindow) {
      try {
        this.hostWindow.addBrowserView(view);
      } catch {
        /* ignore */
      }
      if (show) this.focus(id);
      else this._park(view);
    }

    if (typeof this.onTabCreated === 'function') {
      try {
        this.onTabCreated(this._public(tab), view.webContents);
      } catch {
        /* ignore */
      }
    }

    if (url && url !== 'about:blank') {
      tab.busy = true;
      try {
        await this._loadUrl(view.webContents, url);
        tab.warm = false;
      } finally {
        tab.busy = false;
      }
    }

    this._emit();
    return this._public(tab);
  }

  _wireLifecycle(tab, wc) {
    wc.on('page-title-updated', (_e, pageTitle) => {
      tab.title = pageTitle || tab.title;
      tab.lastActiveAt = Date.now();
      this._emit();
    });

    wc.on('did-navigate', (_e, navUrl) => {
      tab.url = navUrl;
      tab.lastActiveAt = Date.now();
      tab.warm = false;
      this._emit();
    });

    wc.on('did-navigate-in-page', (_e, navUrl) => {
      tab.url = navUrl;
      tab.lastActiveAt = Date.now();
      this._emit();
    });
  }

  /**
   * Adopt window.open as a hidden child tab owned by the opener's thread.
   * Never shows the popup (avoids focus fights). Same session keeps opener/cookies.
   */
  _wirePopupHandler(parentTab) {
    const wc = parentTab.view && parentTab.view.webContents;
    if (!wc || wc.isDestroyed()) return;

    wc.setWindowOpenHandler((_details) => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        show: false,
        paintWhenInitiallyHidden: true,
        focusable: false,
        parent: this.hostWindow || undefined,
        modal: false,
        autoHideMenuBar: true,
        webPreferences: {
          session: wc.session,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      },
    }));

    wc.on('did-create-window', (childWin, details) => {
      try {
        this._adoptPopupWindow(parentTab, childWin, details || {});
      } catch (err) {
        try {
          if (childWin && !childWin.isDestroyed()) childWin.destroy();
        } catch {
          /* ignore */
        }
        console.error('[Cursor-Chrome] popup adopt failed:', err.message || err);
      }
    });
  }

  _adoptPopupWindow(parentTab, childWin, details) {
    if (!childWin || childWin.isDestroyed()) return null;

    if (this.tabs.size >= this.maxTabs) {
      const warm = [...this.tabs.values()].find((t) => t.warm && !t.threadId);
      if (warm) {
        this.close(warm.id).catch(() => {});
      }
    }
    if (this.tabs.size >= this.maxTabs) {
      try {
        childWin.destroy();
      } catch {
        /* ignore */
      }
      const err = new Error(`Tab limit reached (${this.maxTabs}); popup closed`);
      err.code = 'TAB_LIMIT';
      throw err;
    }

    try {
      childWin.setMenuBarVisibility(false);
      if (childWin.isVisible()) childWin.hide();
    } catch {
      /* ignore */
    }

    const id = uuidv4();
    const childWc = childWin.webContents;
    const tab = {
      id,
      threadId: parentTab.threadId || null,
      title: details.frameName || `Popup of ${parentTab.title || parentTab.id.slice(0, 8)}`,
      url: details.url || childWc.getURL() || 'about:blank',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      partition: parentTab.partition,
      view: null,
      window: childWin,
      kind: 'popup',
      parentTabId: parentTab.id,
      busy: false,
      warm: false,
      profile: parentTab.profile || 'shared',
    };

    this._wireLifecycle(tab, childWc);

    childWc.setWindowOpenHandler((_d) => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        show: false,
        paintWhenInitiallyHidden: true,
        focusable: false,
        parent: this.hostWindow || undefined,
        modal: false,
        autoHideMenuBar: true,
        webPreferences: {
          session: childWc.session,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      },
    }));
    childWc.on('did-create-window', (nested, nestDetails) => {
      try {
        this._adoptPopupWindow(tab, nested, nestDetails || {});
      } catch (err) {
        try {
          if (nested && !nested.isDestroyed()) nested.destroy();
        } catch {
          /* ignore */
        }
        console.error('[Cursor-Chrome] nested popup adopt failed:', err.message || err);
      }
    });

    childWin.on('closed', () => {
      if (this.tabs.get(id) === tab) {
        this.tabs.delete(id);
        if (this.activeTabId === id) this.activeTabId = null;
        this._emit();
      }
    });

    this.tabs.set(id, tab);

    if (typeof this.onTabCreated === 'function') {
      try {
        this.onTabCreated(this._public(tab), childWc);
      } catch {
        /* ignore */
      }
    }
    if (typeof this.onPopup === 'function') {
      try {
        this.onPopup(this._public(tab), this._public(parentTab));
      } catch {
        /* ignore */
      }
    }

    this._emit();
    return this._public(tab);
  }

  async ensureWarm() {
    const warmCount = [...this.tabs.values()].filter((t) => t.warm && !t.threadId).length;
    const need = this.warmTarget - warmCount;
    for (let i = 0; i < need; i++) {
      if (this.tabs.size >= this.maxTabs) break;
      await this.create({ url: 'about:blank', title: 'Warm', show: false, warm: true });
    }
    return this.stats();
  }

  takeWarmTab(threadId) {
    for (const tab of this.tabs.values()) {
      if (tab.warm && !tab.threadId) {
        tab.threadId = threadId;
        tab.warm = false;
        tab.title = `Thread ${threadId}`;
        tab.lastActiveAt = Date.now();
        this._emit();
        return this._public(tab);
      }
    }
    return null;
  }

  async claimOrCreate(threadId, { url, title, isolate, profile } = {}) {
    return this._withClaimLock(() => this._claimOrCreateInner(threadId, { url, title, isolate, profile }));
  }

  async _claimOrCreateInner(threadId, { url, title, isolate, profile } = {}) {
    let tab = this.claimForThread(threadId);
    let reused = true;
    let fromWarm = false;
    const needFreshPartition = isolate === true || (profile && profile !== 'shared');
    if (!tab && !needFreshPartition) {
      tab = this.takeWarmTab(threadId);
      fromWarm = !!tab;
      reused = false;
    }
    if (!tab) {
      tab = await this.create({
        url: url || 'about:blank',
        title,
        threadId,
        show: false,
        isolate,
        profile,
      });
      reused = false;
    } else if (url) {
      tab = await this.navigate(tab.id, url);
    } else {
      const raw = this.tabs.get(tab.id);
      if (raw) raw.lastActiveAt = Date.now();
    }
    return { tab, reused, fromWarm };
  }

  async evictLru() {
    let candidate = null;
    for (const tab of this.tabs.values()) {
      if (!(tab.warm && !tab.threadId)) continue;
      if (tab.busy) continue;
      if (!candidate || tab.lastActiveAt < candidate.lastActiveAt) candidate = tab;
    }
    if (!candidate) return false;
    await this.close(candidate.id);
    return true;
  }

  setSpeedMode(enabled) {
    this.speedMode = !!enabled;
    for (const tab of this.tabs.values()) {
      try {
        const wc = this.getWebContents(tab.id);
        if (wc) require('./network-hub').applySpeedMode(wc.session, this.speedMode);
      } catch {
        /* ignore */
      }
    }
  }

  focus(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab || !this.hostWindow) return false;

    // Popup windows stay hidden — agents drive via CDP; human uses /live?tab=
    if (tab.kind === 'popup') {
      this.activeTabId = tabId;
      tab.lastActiveAt = Date.now();
      this._emit();
      return true;
    }

    for (const other of this.tabs.values()) {
      if (other.id === tabId) continue;
      if (other.view) this._park(other.view);
    }

    try {
      this.hostWindow.addBrowserView(tab.view);
    } catch {
      /* ignore */
    }
    this._layout(tab.view);
    try {
      this.hostWindow.setTopBrowserView(tab.view);
    } catch {
      /* ignore */
    }
    this.activeTabId = tabId;
    tab.lastActiveAt = Date.now();
    this._emit();
    return true;
  }

  _park(view) {
    if (!this.hostWindow || !view) return;
    try {
      this.hostWindow.addBrowserView(view);
    } catch {
      /* ignore */
    }
    const [w, h] = this.hostWindow.getContentSize();
    const chromeH = this.chromeHeight;
    view.setBounds({
      x: -20000,
      y: chromeH,
      width: Math.max(800, w),
      height: Math.max(600, h - chromeH),
    });
    view.setAutoResize({ width: false, height: false });
  }

  _layout(view) {
    if (!this.hostWindow || !view) return;
    const [w, h] = this.hostWindow.getContentSize();
    const chromeH = this.chromeHeight;
    const side = Math.max(0, this.sidebarWidth || 0);
    const pageW = Math.max(480, w - side);
    view.setBounds({
      x: 0,
      y: chromeH,
      width: pageW,
      height: Math.max(600, h - chromeH),
    });
    view.setAutoResize({ width: false, height: false });
  }

  relayoutActive() {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (tab && tab.view) this._layout(tab.view);
    for (const other of this.tabs.values()) {
      if (other.id !== this.activeTabId && other.view) this._park(other.view);
    }
  }

  async navigate(tabId, url) {
    const wc = this.getWebContents(tabId);
    if (!wc) throw Object.assign(new Error('Tab not found'), { code: 'NOT_FOUND' });
    const tab = this.tabs.get(tabId);
    tab.busy = true;
    try {
      const target = await this._loadUrl(wc, url);
      tab.url = target;
      tab.lastActiveAt = Date.now();
      tab.warm = false;
      this._emit();
      return this._public(tab);
    } finally {
      tab.busy = false;
    }
  }

  async evaluate(tabId, expression) {
    const wc = this.getWebContents(tabId);
    if (!wc) throw Object.assign(new Error('Tab not found'), { code: 'NOT_FOUND' });
    const tab = this.tabs.get(tabId);
    if (tab) tab.lastActiveAt = Date.now();
    return wc.executeJavaScript(expression, true);
  }

  async screenshot(tabId, { format = 'png' } = {}) {
    const wc = this.getWebContents(tabId);
    if (!wc) throw Object.assign(new Error('Tab not found'), { code: 'NOT_FOUND' });
    const image = await wc.capturePage();
    return format === 'jpeg' ? image.toJPEG(80) : image.toPNG();
  }

  async close(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;

    const children = [...this.tabs.values()].filter((t) => t.parentTabId === tabId);
    for (const child of children) {
      await this.close(child.id);
    }

    if (tab.kind === 'popup' && tab.window) {
      try {
        if (!tab.window.isDestroyed()) tab.window.destroy();
      } catch {
        /* ignore */
      }
    } else if (tab.view) {
      if (this.hostWindow) {
        try {
          this.hostWindow.removeBrowserView(tab.view);
        } catch {
          /* ignore */
        }
      }
      try {
        tab.view.webContents.destroy();
      } catch {
        /* ignore */
      }
    }

    this.tabs.delete(tabId);

    if (this.activeTabId === tabId) {
      this.activeTabId = null;
      const next = [...this.tabs.values()].find((t) => t.kind !== 'popup');
      if (next) this.focus(next.id);
    }

    this._emit();
    return true;
  }

  async closeAll() {
    const ids = [...this.tabs.keys()];
    for (const id of ids) {
      await this.close(id);
    }
  }

  claimForThread(threadId) {
    let popup = null;
    for (const tab of this.tabs.values()) {
      if (tab.threadId !== threadId) continue;
      tab.lastActiveAt = Date.now();
      if (tab.kind !== 'popup') return this._public(tab);
      if (!popup) popup = tab;
    }
    return popup ? this._public(popup) : null;
  }

  setThread(tabId, threadId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    if (threadId) {
      for (const other of this.tabs.values()) {
        if (other.id !== tabId && other.threadId === threadId && other.kind !== 'popup') {
          if (tab.kind !== 'popup') {
            const err = new Error(`threadId already owns tab ${other.id}`);
            err.code = 'THREAD_TAKEN';
            throw err;
          }
        }
      }
    }
    tab.threadId = threadId;
    tab.lastActiveAt = Date.now();
    if (threadId) {
      for (const child of this.tabs.values()) {
        if (child.parentTabId === tabId) child.threadId = threadId;
      }
    }
    this._emit();
    return this._public(tab);
  }

  _public(tab) {
    return {
      id: tab.id,
      threadId: tab.threadId,
      title: tab.title,
      url: tab.url,
      createdAt: tab.createdAt,
      lastActiveAt: tab.lastActiveAt,
      busy: tab.busy,
      warm: !!tab.warm,
      profile: tab.profile || 'shared',
      active: tab.id === this.activeTabId,
      partition: tab.partition,
      kind: tab.kind || 'tab',
      parentTabId: tab.parentTabId || null,
      popupCount: [...this.tabs.values()].filter((t) => t.parentTabId === tab.id).length,
    };
  }

  _emit() {
    if (typeof this.onChange === 'function') {
      this.onChange(this.list(), this.activeTabId);
    }
  }

  stats() {
    const warm = [...this.tabs.values()].filter((t) => t.warm && !t.threadId).length;
    const popups = [...this.tabs.values()].filter((t) => t.kind === 'popup').length;
    return {
      used: this.tabs.size,
      max: this.maxTabs,
      available: this.maxTabs - this.tabs.size,
      warm,
      warmTarget: this.warmTarget,
      popups,
      speedMode: this.speedMode,
      activeTabId: this.activeTabId,
    };
  }
}

module.exports = { TabPool };
