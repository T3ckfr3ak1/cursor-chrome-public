'use strict';

/**
 * Lightweight Node client for Cursor agent threads.
 * Each thread should use a unique threadId so tabs stay isolated (max 20).
 *
 * Usage:
 *   const { CursorChrome } = require('./client');
 *   const chrome = new CursorChrome();
 *   const { tab } = await chrome.claim('thread-3', { url: 'https://example.com' });
 *   await chrome.handoff(tab.id, { reason: 'login', wait: true });
 */

class CursorChrome {
  constructor({ baseUrl = 'http://127.0.0.1:9222' } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    /** @type {string|null} Set by claim(); sent on mutating calls for ownership checks. */
    this.threadId = null;
  }

  _threadBody(extra = {}) {
    if (!this.threadId) return extra;
    return { threadId: this.threadId, ...extra };
  }

  _threadQuery(path) {
    if (!this.threadId) return path;
    const join = path.includes('?') ? '&' : '?';
    return `${path}${join}threadId=${encodeURIComponent(this.threadId)}`;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @param {{ timeoutMs?: number|null }} [opts] timeoutMs null = no client abort (handoff waits)
   */
  async _req(method, path, body, opts = {}) {
    const timeoutMs = opts.timeoutMs;
    const ctrl =
      timeoutMs != null && Number(timeoutMs) > 0 ? new AbortController() : null;
    let timer = null;
    if (ctrl) {
      timer = setTimeout(() => ctrl.abort(), Number(timeoutMs));
    }
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl ? ctrl.signal : undefined,
      });
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const data = await res.json();
        if (!res.ok) {
          const err = new Error(data.error || res.statusText);
          err.code = data.code || null;
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      }
      if (!res.ok) throw new Error(await res.text());
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs}ms: ${method} ${path}`);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  status() {
    return this._req('GET', '/status', undefined, { timeoutMs: 8000 });
  }

  health() {
    return this._req('GET', '/health', undefined, { timeoutMs: 8000 });
  }

  metrics() {
    return this._req('GET', '/metrics');
  }

  claim(threadId, { url, title, isolate, profile } = {}) {
    this.threadId = threadId;
    return this._req(
      'POST',
      '/claim',
      { threadId, url, title, isolate, profile },
      { timeoutMs: 90000 }
    );
  }

  createTab(opts) {
    return this._req('POST', '/tabs', opts || {});
  }

  listTabs() {
    return this._req('GET', '/tabs');
  }

  /** Child window.open tabs owned by this parent (same threadId). */
  listPopups(tabId) {
    return this._req('GET', this._threadQuery(`/tabs/${tabId}/popups`));
  }

  /** In-page dialogs + window.open children for this tab. */
  overlays(tabId) {
    return this._req('GET', this._threadQuery(`/tabs/${tabId}/overlays`));
  }

  /**
   * After a click that may open window.open, resolve the tab to drive next
   * (newest popup if any, else the parent).
   */
  resolveOverlay(tabId) {
    return this._req('POST', `/tabs/${tabId}/resolve-overlay`, this._threadBody());
  }

  /** Poll until a child popup appears for this parent tab. */
  async waitForPopup(tabId, { timeoutMs = 15000, intervalMs = 250 } = {}) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
      last = await this.listPopups(tabId);
      if (last.popups && last.popups.length) {
        return last.popups.sort((a, b) => b.createdAt - a.createdAt)[0];
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    const err = new Error(`No popup opened for tab ${tabId} within ${timeoutMs}ms`);
    err.code = 'TIMEOUT';
    err.data = last;
    throw err;
  }

  navigate(tabId, url) {
    return this._req('POST', `/tabs/${tabId}/navigate`, this._threadBody({ url }));
  }

  evaluate(tabId, expression) {
    return this._req('POST', `/tabs/${tabId}/evaluate`, this._threadBody({ expression }));
  }

  async screenshot(tabId, { format = 'png' } = {}) {
    return this._req('POST', `/tabs/${tabId}/screenshot`, { format });
  }

  close(tabId) {
    return this._req('DELETE', `/tabs/${tabId}`);
  }

  hide() {
    // Agents: blocked server-side (403).
    return this._req('POST', '/window/hide');
  }

  /** Background-safe. Does NOT raise the OS window or steal focus. */
  show() {
    return this._req('POST', '/window/show');
  }

  minimize() {
    // Agents: blocked server-side (403). Humans minimize via taskbar/tray.
    return this._req('POST', '/window/minimize');
  }

  /**
   * Switch active tab only. Does NOT raise Cursor-Chrome over other apps.
   * Humans watch via taskbar / tray / Ctrl+Shift+C / /live.
   */
  front({ tabId, threadId } = {}) {
    return this._req('POST', '/window/front', { tabId, threadId });
  }

  /**
   * Select tab for live frames. Does NOT unpark, steal OS focus, or flip the
   * human-visible tab unless stealVisible:true (avoid multi-thread confusion).
   */
  watch({ tabId, threadId, message, stealVisible = false } = {}) {
    return this._req('POST', '/window/watch', {
      tabId,
      threadId: threadId || this.threadId,
      message,
      stealVisible,
    });
  }

  /** Latest realtime screencast frame (JPEG buffer). */
  async liveFrame(tabId) {
    return this._req('GET', `/tabs/${tabId}/frame.jpg`);
  }

  startStream(tabId, opts) {
    return this._req('POST', `/tabs/${tabId}/stream/start`, opts || {});
  }

  liveViewerUrl(tabId) {
    return `${this.baseUrl}/live?tab=${encodeURIComponent(tabId)}`;
  }

  getHandoff() {
    return this._req('GET', '/handoff');
  }

  /**
   * Hand control to the human for login / 2FA / CAPTCHA.
   * Brings Cursor-Chrome to the front on the right tab, shows Done banner.
   * If wait:true, blocks until user clicks Done (or timeout).
   * Default timeout is 15 minutes; server caps at 2 hours.
   * Client does not abort the fetch early (request lives until server responds).
   */
  handoff(tabId, {
    threadId,
    url,
    reason = 'login',
    message = 'Finish login / verification in Cursor-Chrome, then click Done.',
    after = 'stay',
    wait = true,
    timeoutMs = 900000,
  } = {}) {
    return this._req(
      'POST',
      '/handoff',
      {
        tabId,
        threadId,
        url,
        reason,
        message,
        after: 'stay', // agents cannot request post-handoff hide/minimize
        wait,
        timeoutMs,
      },
      { timeoutMs: null }
    );
  }

  handoffDone(note) {
    return this._req('POST', '/handoff/done', { note }, { timeoutMs: 15000 });
  }

  waitHandoff(timeoutMs = 900000) {
    return this._req('POST', '/handoff/wait', { timeoutMs }, { timeoutMs: null });
  }

  /**
   * Show / update the right-side instruction rail (structured steps for the human).
   * @param {{ title?: string, subtitle?: string, body?: string, footer?: string,
   *   steps?: Array<string|{text:string,done?:boolean,detail?:string}>,
   *   open?: boolean, tabId?: string, threadId?: string, width?: number }} opts
   */
  guide(opts = {}) {
    return this._req('POST', '/guide', opts);
  }

  getGuide() {
    return this._req('GET', '/guide');
  }

  guideClear() {
    return this._req('POST', '/guide/clear', {});
  }

  guideClose() {
    return this._req('POST', '/guide/close', {});
  }

  guideOpen() {
    return this._req('POST', '/guide/open', {});
  }

  guideStep(idOrIndex, { done = true } = {}) {
    return this._req('POST', `/guide/steps/${encodeURIComponent(idOrIndex)}`, { done });
  }

  guideBlock(opts = {}) {
    return this._req('POST', '/guide/block', opts);
  }

  guideUnblock() {
    return this._req('POST', '/guide/unblock', {});
  }

  /**
   * Snapshot Play Console status for IronWood apps (best-effort scrape).
   * Uses navigateRetry + waitForStable under the hood.
   */
  async playStatus(opts = {}) {
    const { PlayStatus } = require('./play-status');
    return new PlayStatus(this).run(opts);
  }

  autoHandoff(tabId, opts = {}) {
    return this._req('POST', `/tabs/${tabId}/auto-handoff`, opts);
  }

  authCheck(tabId) {
    return this._req('POST', `/tabs/${tabId}/auth-check`, {});
  }

  /**
   * Drag-and-drop files onto a drop zone, or set a file input.
   * Fires Angular-friendly change/input events after DOM.setFileInputFiles.
   * Multi-input pages: pass index/useIndex or let auto-detect score the best input.
   * mode: 'chooser' intercepts the OS file dialog (no hang) — pass clickText e.g. 'Upload'.
   * @param {string} tabId
   * @param {{ files: string[], selector?: string, x?: number, y?: number,
   *   mode?: 'auto'|'input'|'drop'|'chooser', index?: number, useIndex?: number,
   *   clickText?: string, clickSelector?: string }} opts
   */
  dropFiles(tabId, opts) {
    return this._req('POST', `/tabs/${tabId}/drop-files`, opts || {}, { timeoutMs: 120000 });
  }

  /** Force CDP drag-drop sequence (even if target looks like an input). */
  dragDropFiles(tabId, opts) {
    return this._req('POST', `/tabs/${tabId}/drag-drop-files`, opts || {}, {
      timeoutMs: 120000,
    });
  }

  clearSession(opts) {
    return this._req('POST', '/session/clear', opts || {});
  }

  flushSession(opts) {
    return this._req('POST', '/session/flush', opts || {});
  }

  exportSession(opts) {
    return this._req('POST', '/session/export', opts || {});
  }

  importSession(opts) {
    return this._req('POST', '/session/import', opts || {});
  }

  profiles() {
    return this._req('GET', '/profiles');
  }

  /** Multi-step agent action DSL. */
  act(tabId, body) {
    return this._req('POST', `/tabs/${tabId}/act`, this._threadBody(body || {}));
  }

  snapshot(tabId, opts) {
    return this._req('POST', `/tabs/${tabId}/snapshot`, this._threadBody(opts || {}));
  }

  click(tabId, opts) {
    return this._req('POST', `/tabs/${tabId}/click`, this._threadBody(opts || {}));
  }

  /** Safer text click: prefers open dialogs; refuses Create/Delete/Halt unless confirmDangerous. */
  clickText(tabId, opts) {
    const body = typeof opts === 'string' ? { text: opts } : opts || {};
    return this._req('POST', `/tabs/${tabId}/click-text`, this._threadBody(body));
  }

  pickRow(tabId, opts) {
    return this._req('POST', `/tabs/${tabId}/pick-row`, this._threadBody(opts || {}));
  }

  navigateRetry(tabId, url, opts = {}) {
    return this._req('POST', `/tabs/${tabId}/navigate-retry`, this._threadBody({ url, ...opts }));
  }

  waitStable(tabId, opts = {}) {
    return this._req('POST', `/tabs/${tabId}/wait`, this._threadBody({ stable: opts }));
  }

  type(tabId, opts) {
    return this._req('POST', `/tabs/${tabId}/type`, this._threadBody(opts || {}));
  }

  hover(tabId, opts) {
    return this._req('POST', `/tabs/${tabId}/hover`, opts || {});
  }

  scroll(tabId, opts) {
    return this._req('POST', `/tabs/${tabId}/scroll`, opts || {});
  }

  press(tabId, opts) {
    return this._req('POST', `/tabs/${tabId}/press`, opts || {});
  }

  wait(tabId, opts) {
    return this._req('POST', `/tabs/${tabId}/wait`, opts || {});
  }

  network(tabId, limit = 50) {
    return this._req('GET', `/tabs/${tabId}/network?limit=${limit}`);
  }

  downloads(limit = 50) {
    return this._req('GET', `/downloads?limit=${limit}`);
  }

  speedMode(enabled) {
    return this._req('POST', '/speed-mode', { enabled: !!enabled });
  }

  warm() {
    return this._req('POST', '/warm', {});
  }

  log(opts = {}) {
    const q = new URLSearchParams();
    if (opts.threadId) q.set('threadId', opts.threadId);
    if (opts.tabId) q.set('tabId', opts.tabId);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return this._req('GET', `/log${qs ? `?${qs}` : ''}`);
  }

  clearLog() {
    return this._req('DELETE', '/log');
  }

  pickerStart(tabId) {
    return this._req('POST', `/tabs/${tabId}/picker/start`, {});
  }

  pickerResult(tabId) {
    return this._req('GET', `/tabs/${tabId}/picker/result`);
  }

  recordStart(tabId) {
    return this._req('POST', `/tabs/${tabId}/record/start`, {});
  }

  recordStop(tabId) {
    return this._req('POST', `/tabs/${tabId}/record/stop`, {});
  }

  record(tabId) {
    return this._req('GET', `/tabs/${tabId}/record`);
  }

  playbook(tabId, steps) {
    return this._req('POST', `/tabs/${tabId}/playbook`, steps ? { steps } : {});
  }

  /** Password-friendly Google / Microsoft / Dropbox login entry URLs */
  loginUrl(provider) {
    const { LOGIN_URLS } = require('./login-urls');
    return LOGIN_URLS[provider] || null;
  }
}

module.exports = { CursorChrome };
