'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification, globalShortcut } = require('electron');
const { parseArgs, APP_NAME, MAX_TABS } = require('./config');
const { TabPool } = require('./tab-pool');
const { createAgentApi } = require('./agent-api');
const { HandoffController, bringWindowToFront, requestWindowAttention } = require('./handoff');
const { GuideController } = require('./guide');
const { FrameHub } = require('./frame-hub');
const { RunLog } = require('./run-log');
const { NetworkHub } = require('./network-hub');
const { Recorder } = require('./recorder');
const { startHeartbeat, spawnWatchdog } = require('./watchdog');

const args = parseArgs();
let mainWindow = null;
let tray = null;
let apiInfo = null;
let tabPool = null;
let frameHub = null;
let handoffPanel = null;
let apiBroadcast = null;
let heartbeatTimer = null;
const handoff = new HandoffController();
const guide = new GuideController();
const runLog = new RunLog();
const recorder = new Recorder();
const metrics = { startedAt: Date.now() };
let networkHub = null;

// Keep agent pages alive when the window is minimized / off-screen.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// Expose Chromium DevTools Protocol for Playwright / Puppeteer / Cursor CDP clients.
app.commandLine.appendSwitch('remote-debugging-port', String(args.cdpPort));

if (args.userDataDir) {
  app.setPath('userData', args.userDataDir);
}

function iconPath(name) {
  return path.join(__dirname, '..', 'assets', name);
}

function loadAppIcon() {
  // Prefer PNG so Windows taskbar/titlebar don't stick on a cached icon.ico.
  const png = iconPath('logo-256.png');
  const ico = iconPath('icon.ico');
  if (fs.existsSync(png)) return nativeImage.createFromPath(png);
  if (fs.existsSync(ico)) return nativeImage.createFromPath(ico);
  return nativeImage.createEmpty();
}

function getAppState() {
  let parked = false;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const b = mainWindow.getBounds();
      parked = mainWindow.getOpacity() < 0.05 || b.x < -1000 || b.y < -1000;
    }
  } catch {
    /* ignore */
  }
  return {
    name: APP_NAME,
    version: app.getVersion(),
    minimized: mainWindow ? mainWindow.isMinimized() || parked : false,
    visible: mainWindow ? mainWindow.isVisible() && !parked : false,
    focused: mainWindow ? mainWindow.isFocused() : false,
    parked,
    apiPort: args.apiPort,
    cdpPort: args.cdpPort,
    maxTabs: args.maxTabs,
    userDataDir: args.userDataDir,
    sharedProfile: !args.isolateSessions,
    profilePartition: require('./config').SHARED_PARTITION,
    apiUrl: apiInfo ? apiInfo.url : null,
    cdpUrl: `http://127.0.0.1:${args.cdpPort}`,
    handoff: handoff.get(),
    guide: guide.get(),
    observability: require('./visibility-policy').observabilityNote(args.apiPort),
  };
}

function applyGuideLayout() {
  if (!tabPool) return;
  tabPool.setSidebarWidth(guide.sidebarWidth());
  // SPA shells sometimes paint before bounds settle — reflow once more.
  setTimeout(() => {
    if (tabPool) tabPool.relayoutActive();
  }, 50);
}

function completeHandoffFromUi(note = 'user clicked Hand back to Cursor') {
  if (!handoff.get().active) {
    // Idle "Done" does not auto-park — user chooses taskbar/tray minimize.
    pushUiState();
    if (apiBroadcast) apiBroadcast('handoff_done', { ok: true, active: false, idle: true, note });
    return { ok: true, active: false, idle: true, note };
  }
  const result = handoff.done({ note, source: 'ui' });
  // Persist cookies after login
  try {
    const { session } = require('electron');
    const { SHARED_PARTITION } = require('./config');
    const partition =
      (result.handoff && result.handoff.tabId && tabPool.get(result.handoff.tabId)?.partition) ||
      SHARED_PARTITION;
    session.fromPartition(partition, { cache: true }).flushStorageData();
  } catch {
    /* ignore */
  }
  // Never auto-park/hide after handoff (anti-secrecy). User may minimize themselves.
  guide.clear({ ifSource: 'handoff' });
  applyGuideLayout();
  pushUiState();
  if (apiBroadcast) apiBroadcast('handoff_done', result);
  return result;
}

function destroyHandoffPanel() {
  if (handoffPanel && !handoffPanel.isDestroyed()) {
    try {
      handoffPanel.destroy();
    } catch {
      /* ignore */
    }
  }
  handoffPanel = null;
}

function pushUiState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('ui:state', {
    ...getAppState(),
    pool: tabPool ? tabPool.stats() : null,
    tabs: tabPool ? tabPool.list() : [],
    activeTabId: tabPool ? tabPool.activeTabId : null,
    handoff: handoff.get(),
    guide: guide.get(),
  });
}

handoff.onChange = (state) => {
  // Keep chrome height fixed — handoff uses the toolbar button only (no floating banner).
  if (tabPool) tabPool.setChromeHeight(88);
  if (state.active) {
    guide.fromHandoff({
      message: state.message,
      tabId: state.tabId,
      threadId: state.threadId,
      reason: state.reason,
    });
  } else {
    guide.clear({ ifSource: 'handoff' });
  }
  applyGuideLayout();
  pushUiState();
  if (apiBroadcast) apiBroadcast('handoff', state);
  if (!state.active) destroyHandoffPanel();
};

guide.onChange = () => {
  applyGuideLayout();
  pushUiState();
  if (apiBroadcast) apiBroadcast('guide', guide.get());
};

function notifyHandoff(state) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: 'Cursor-Chrome — your turn',
      body: state.message || 'Finish this step in the browser, then click Done.',
      icon: loadAppIcon(),
    });
    n.on('click', () => {
      bringWindowToFront(mainWindow);
    });
    n.show();
  } catch {
    /* ignore */
  }
  try {
    if (tray) tray.displayBalloon?.({
      title: 'Cursor-Chrome — your turn',
      content: state.message || 'Click Done when finished.',
    });
  } catch {
    /* ignore */
  }
}

function parkWindowOffscreen() {
  // Only user-initiated parking (taskbar minimize / tray). Never called from agent API.
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow._cursorParking) return;
  mainWindow._cursorParking = true;
  try {
    // Always remain on the taskbar — never secretive.
    mainWindow.setSkipTaskbar(false);
    if (mainWindow.isMinimized()) mainWindow.restore();
    // Off-screen + transparent (not OS-minimize) so agents + live frames keep running.
    // User can click the taskbar icon anytime to watch.
    mainWindow.setOpacity(0);
    mainWindow.setPosition(-12000, -12000);
    mainWindow.showInactive();
  } catch {
    /* ignore */
  } finally {
    setTimeout(() => {
      if (mainWindow) mainWindow._cursorParking = false;
    }, 250);
  }
  updateTrayTooltip();
  pushUiState();
}

function updateTrayTooltip() {
  if (!tray) return;
  try {
    const stats = tabPool ? tabPool.stats() : { used: 0 };
    const parked = isParked();
    const hid = mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible();
    const mode = hid ? 'tray-only (user hid)' : parked ? 'parked — click taskbar to watch' : 'on desktop';
    tray.setToolTip(
      `${APP_NAME} · ${stats.used}/${args.maxTabs || MAX_TABS} tabs · ${mode} · Ctrl+Shift+C · anti-secrecy: agents cannot hide`
    );
  } catch {
    /* ignore */
  }
}

async function unparkForWatch() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow._cursorUnparking) return;
  mainWindow._cursorUnparking = true;
  try {
    await bringWindowToFront(mainWindow);
    if (tabPool) {
      if (tabPool.activeTabId) tabPool.focus(tabPool.activeTabId);
      else tabPool.relayoutActive();
    }
  } finally {
    setTimeout(() => {
      if (mainWindow) mainWindow._cursorUnparking = false;
    }, 250);
  }
  updateTrayTooltip();
  pushUiState();
}

function isParked() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    const b = mainWindow.getBounds();
    return mainWindow.getOpacity() < 0.05 || b.x < -1000 || b.y < -1000;
  } catch {
    return false;
  }
}

async function createWindow() {
  const icon = loadAppIcon();
  const startHidden = args.hidden;
  const startMinimized = args.minimized && !args.visible;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#0a0a0b',
    show: false,
    icon,
    skipTaskbar: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  tabPool.attachWindow(mainWindow);

  mainWindow.on('resize', () => {
    if (!isParked()) tabPool.relayoutActive();
  });

  // Taskbar / title-bar minimize → park (agents keep working; taskbar icon stays)
  mainWindow.on('minimize', () => {
    setImmediate(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow._cursorUnparking) return;
      parkWindowOffscreen();
    });
  });

  // Taskbar click restores/focuses → bring on-screen so you can watch
  mainWindow.on('restore', () => {
    if (mainWindow._cursorParking) return;
    unparkForWatch();
  });

  mainWindow.on('focus', () => {
    if (mainWindow._cursorParking) return;
    if (isParked()) unparkForWatch();
    else {
      tabPool.relayoutActive();
      pushUiState();
    }
  });

  mainWindow.on('hide', () => pushUiState());
  mainWindow.on('show', () => {
    if (!isParked()) tabPool.relayoutActive();
    pushUiState();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));

  if (startHidden) {
    mainWindow.hide();
  } else if (startMinimized) {
    // Show once so Windows creates a taskbar button, then park.
    mainWindow.showInactive();
    parkWindowOffscreen();
  } else {
    mainWindow.show();
  }

  pushUiState();
}

function createTray() {
  const icon = loadAppIcon();
  const trayIcon = icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  updateTrayTooltip();
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show / watch (always available)',
      click: () => unparkForWatch(),
    },
    {
      label: 'Minimize to taskbar park (USER only — agents keep running)',
      click: () => parkWindowOffscreen(),
    },
    {
      label: 'Hand back to Cursor',
      click: () => completeHandoffFromUi('user clicked tray: Hand back to Cursor'),
    },
    {
      label: 'Hide to tray only (USER choice — click tray to return)',
      click: () => {
        if (mainWindow) {
          mainWindow.hide();
          updateTrayTooltip();
          pushUiState();
        }
      },
    },
    { type: 'separator' },
    {
      label: `Live view (always openable)`,
      click: () => shell.openExternal(`http://127.0.0.1:${args.apiPort}/live`),
    },
    {
      label: `Agent API: http://127.0.0.1:${args.apiPort}`,
      click: () => shell.openExternal(`http://127.0.0.1:${args.apiPort}/status`),
    },
    {
      label: `CDP: http://127.0.0.1:${args.cdpPort}`,
      click: () => shell.openExternal(`http://127.0.0.1:${args.cdpPort}/json/version`),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => unparkForWatch());
  tray.on('click', () => unparkForWatch());
}

function registerIpc() {
  ipcMain.handle('ui:get-state', () => ({
    ...getAppState(),
    pool: tabPool.stats(),
    tabs: tabPool.list(),
    activeTabId: tabPool.activeTabId,
    handoff: handoff.get(),
    guide: guide.get(),
  }));

  ipcMain.handle('ui:create-tab', async (_e, opts) => {
    const tab = await tabPool.create(opts || {});
    pushUiState();
    return tab;
  });

  ipcMain.handle('ui:focus-tab', (_e, id) => {
    tabPool.focus(id);
    pushUiState();
    return tabPool.get(id);
  });

  ipcMain.handle('ui:close-tab', async (_e, id) => {
    await tabPool.close(id);
    pushUiState();
    return true;
  });

  ipcMain.handle('ui:navigate', async (_e, { id, url }) => {
    const tab = await tabPool.navigate(id, url);
    pushUiState();
    return tab;
  });

  ipcMain.handle('ui:minimize', () => {
    parkWindowOffscreen();
    return true;
  });

  ipcMain.handle('ui:hide', () => {
    if (mainWindow) mainWindow.hide();
    return true;
  });

  ipcMain.handle('ui:show', async () => {
    await unparkForWatch();
    return true;
  });

  ipcMain.handle('ui:handoff-done', (_e, note) => {
    return completeHandoffFromUi(note || 'user clicked Hand back to Cursor');
  });

  ipcMain.handle('ui:guide-close', () => {
    const g = guide.close();
    applyGuideLayout();
    pushUiState();
    if (apiBroadcast) apiBroadcast('guide', g);
    return g;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    unparkForWatch();
  });

  app.whenReady().then(async () => {
    const downloadDir = path.join(app.getPath('userData'), 'downloads');
    networkHub = new NetworkHub({ downloadDir });

    tabPool = new TabPool({
      maxTabs: args.maxTabs || MAX_TABS,
      isolateSessions: !!args.isolateSessions,
      warmTarget: 5,
    });
    tabPool.onTabCreated = (tab, wc) => {
      if (networkHub) networkHub.attachWebContents(tab.id, wc);
    };
    tabPool.onPopup = (popup, parent) => {
      if (apiBroadcast) apiBroadcast('popup_opened', { popup, parent });
      console.log(
        `[Cursor-Chrome] popup ${popup.id.slice(0, 8)} from ${parent.id.slice(0, 8)} thread=${popup.threadId || '-'}`
      );
    };
    frameHub = new FrameHub({
      getWebContents: (id) => tabPool.getWebContents(id),
    });
    registerIpc();

    const api = createAgentApi({
      tabPool,
      getAppState,
      handoff,
      guide,
      frameHub,
      runLog,
      networkHub,
      recorder,
      metrics,
      onCommand: async (cmd, payload = {}) => {
        if (!mainWindow) return {};
        // Anti-secrecy: agents never hide/minimize/park.
        // Focus-steal policy: agents never unpark/always-on-top/focus OS window.
        // Humans watch via taskbar / tray / Ctrl+Shift+C. Handoff only soft-nudges.
        if (cmd === 'minimize' || cmd === 'hide' || cmd === 'park') {
          const { AGENT_BLOCKED } = require('./visibility-policy');
          return AGENT_BLOCKED;
        }
        if (cmd === 'show' || cmd === 'restore') {
          // Soft no-op for OS z-order: keep working in background.
          pushUiState();
          updateTrayTooltip();
          return {
            ok: true,
            focusStolen: false,
            note: 'Agent show/restore does not bring Cursor-Chrome to the front. Use taskbar, tray, or Ctrl+Shift+C to watch.',
          };
        }
        if (cmd === 'front') {
          // Default: do NOT flip the human-visible tab (prevents multi-thread popup confusion).
          // Handoff or stealVisible:true may switch activeTabId for the human.
          const stealVisible = !!(payload.stealVisible || payload.handoff);
          if (stealVisible) {
            if (payload.tabId) tabPool.focus(payload.tabId);
            else if (payload.threadId) {
              const t = tabPool.claimForThread(payload.threadId);
              if (t) tabPool.focus(t.id);
            }
          }
          if (payload.handoff) {
            await requestWindowAttention(mainWindow);
            notifyHandoff(payload.handoff);
          }
          pushUiState();
          updateTrayTooltip();
          return {
            ok: true,
            tabId: tabPool.activeTabId,
            handoff: handoff.get(),
            focusStolen: false,
            visibleSwitched: stealVisible,
            note: payload.handoff
              ? 'Handoff nudged without always-on-top; visible tab switched for human.'
              : stealVisible
                ? 'Visible tab switched (stealVisible).'
                : 'Agent front does not switch the visible tab or raise the OS window.',
          };
        }
        pushUiState();
        updateTrayTooltip();
        return {};
      },
    });

    apiInfo = await api.listen(args.apiPort);
    apiBroadcast = api.broadcast;
    console.log(`[Cursor-Chrome] Agent API → ${apiInfo.url}`);
    console.log(`[Cursor-Chrome] Live view → ${apiInfo.url}/live`);
    console.log(`[Cursor-Chrome] CDP      → http://127.0.0.1:${args.cdpPort}`);
    console.log(`[Cursor-Chrome] Max tabs  → ${args.maxTabs}`);

    const heartbeatFile = path.join(app.getPath('userData'), 'heartbeat.json');
    heartbeatTimer = startHeartbeat(heartbeatFile, 5000);
    try {
      spawnWatchdog({
        appRoot: path.join(__dirname, '..'),
        heartbeatFile,
        apiPort: args.apiPort,
      });
    } catch {
      /* optional */
    }

    await createWindow();
    createTray();

    globalShortcut.register('CommandOrControl+Shift+C', () => {
      unparkForWatch();
    });
    globalShortcut.register('CommandOrControl+Shift+H', () => {
      if (handoff.get().active) {
        completeHandoffFromUi('user pressed Ctrl+Shift+H');
      } else {
        unparkForWatch();
      }
    });

    console.log('[Cursor-Chrome] Watch hotkey → Ctrl+Shift+C (or click the taskbar icon)');

    await tabPool.create({ url: 'about:blank', title: 'Ready', threadId: null, show: true });
    tabPool.ensureWarm().catch(() => {});
    pushUiState();
  });
}

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* ignore */
  }
  if (heartbeatTimer) clearInterval(heartbeatTimer);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('before-quit', async () => {
  // Flush cookies/localStorage so logins persist on disk
  try {
    const { session } = require('electron');
    const { SHARED_PARTITION } = require('./config');
    const shared = session.fromPartition(SHARED_PARTITION, { cache: true });
    await shared.flushStorageData();
    if (tabPool) {
      const seen = new Set();
      for (const t of tabPool.list()) {
        if (!t.partition || seen.has(t.partition)) continue;
        seen.add(t.partition);
        await session.fromPartition(t.partition, { cache: true }).flushStorageData();
      }
    }
  } catch {
    /* ignore */
  }
  if (frameHub) await frameHub.stopAll();
  if (tabPool) await tabPool.closeAll();
});
