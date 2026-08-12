'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

async function waitForLatestFrame(frameHub, tabId, timeoutMs = 2500) {
  await frameHub.ensure(tabId, { sticky: true, everyNthFrame: 1, quality: 55 });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = frameHub.latest(tabId);
    if (frame) return frame;
    await new Promise((r) => setTimeout(r, 40));
  }
  return frameHub.latest(tabId);
}

/**
 * Local control plane for Cursor agents.
 * REST + WebSocket on localhost so up to 20 threads can drive tabs in parallel.
 */
function createAgentApi({
  tabPool,
  getAppState,
  onCommand,
  handoff,
  guide,
  frameHub,
  runLog,
  networkHub,
  recorder,
  metrics,
}) {
  const app = express();
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: '8mb' }));

  const clients = new Set();

  function broadcast(event, data) {
    const payload = JSON.stringify({ event, data, ts: Date.now() });
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  tabPool.onChange = (tabs, activeTabId) => {
    broadcast('tabs', { tabs, activeTabId, pool: tabPool.stats() });
  };

  const { registerPowerRoutes, handleWsCommand } = require('./routes-power');
  registerPowerRoutes(app, {
    tabPool,
    frameHub,
    runLog,
    networkHub,
    recorder,
    handoff,
    getAppState,
    onCommand,
    metrics,
  });

  app.get('/health', async (_req, res) => {
    const state = getAppState();
    let cdp = null;
    try {
      const { probeChromiumCdp } = require('./input-actions');
      cdp = await probeChromiumCdp(state.cdpPort || 9223, { timeoutMs: 600 });
    } catch (err) {
      cdp = { ok: false, error: err.message || String(err) };
    }
    res.json({
      ok: true,
      app: 'Cursor-Chrome',
      ...state,
      handoff: handoff ? handoff.get() : null,
      guide: guide ? guide.get() : null,
      pool: tabPool.stats(),
      cdp,
      security: {
        bind: '127.0.0.1',
        auth: 'none-local-only',
        note: 'Agent API and CDP are loopback-only. Do not expose ports publicly.',
      },
      observability: require('./visibility-policy').observabilityNote(state.apiPort || 9222),
    });
  });

  app.get('/status', (_req, res) => {
    res.json({
      ok: true,
      app: 'Cursor-Chrome',
      ...getAppState(),
      pool: tabPool.stats(),
      tabs: tabPool.list(),
      handoff: handoff ? handoff.get() : null,
      guide: guide ? guide.get() : null,
      live: 'http://127.0.0.1:' + (getAppState().apiPort || 9222) + '/live',
    });
  });

  const liveHtml = path.join(__dirname, '..', 'ui', 'live.html');
  app.get(['/live', '/live.html'], (_req, res) => res.sendFile(liveHtml));

  app.get('/tabs', (_req, res) => {
    res.json({ tabs: tabPool.list(), pool: tabPool.stats() });
  });

  app.get('/tabs/:id/popups', (req, res) => {
    try {
      const { enforceThreadAccess } = require('./thread-guard');
      const tab = enforceThreadAccess(tabPool, req.params.id, req);
      if (!tab) return res.status(404).json({ error: 'Tab not found' });
      res.json({
        parent: tab,
        popups: tabPool.listPopups(req.params.id),
        overlayTarget: tabPool.resolveOverlayTarget(req.params.id),
      });
    } catch (err) {
      res.status(err.code === 'THREAD_MISMATCH' ? 403 : 404).json({ error: err.message, code: err.code });
    }
  });

  app.get('/tabs/:id/overlays', async (req, res) => {
    try {
      const { enforceThreadAccess } = require('./thread-guard');
      const tab = enforceThreadAccess(tabPool, req.params.id, req);
      if (!tab) return res.status(404).json({ error: 'Tab not found' });
      const wc = tabPool.getWebContents(req.params.id);
      let inPage = { dialogs: [], count: 0 };
      if (wc) {
        inPage = await wc.executeJavaScript(`(() => {
          const sel = '[role=dialog],mat-dialog-container,.mat-mdc-dialog-container,[aria-modal=true],.cdk-overlay-pane,.fxs-blade';
          const els = Array.from(document.querySelectorAll(sel)).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 40 && r.height > 40;
          });
          return {
            count: els.length,
            dialogs: els.slice(0, 12).map((el) => ({
              tag: el.tagName,
              role: el.getAttribute('role'),
              text: ((el.innerText || '').replace(/\\s+/g, ' ').trim()).slice(0, 120),
            })),
          };
        })()`);
      }
      res.json({
        tab,
        inPage,
        popups: tabPool.listPopups(req.params.id),
        overlayTarget: tabPool.resolveOverlayTarget(req.params.id),
      });
    } catch (err) {
      res
        .status(err.code === 'THREAD_MISMATCH' ? 403 : err.code === 'NOT_FOUND' ? 404 : 500)
        .json({ error: err.message, code: err.code });
    }
  });

  app.post('/tabs/:id/resolve-overlay', (req, res) => {
    try {
      const { enforceThreadAccess } = require('./thread-guard');
      const tab = enforceThreadAccess(tabPool, req.params.id, req);
      if (!tab) return res.status(404).json({ error: 'Tab not found' });
      const target = tabPool.resolveOverlayTarget(req.params.id);
      res.json({ parent: tab, target, switched: target && target.id !== tab.id });
    } catch (err) {
      res.status(err.code === 'THREAD_MISMATCH' ? 403 : 404).json({ error: err.message, code: err.code });
    }
  });

  app.post('/tabs', async (req, res) => {
    try {
      const { url, title, threadId, show } = req.body || {};
      const existing = threadId ? tabPool.claimForThread(threadId) : null;
      if (existing) {
        return res.json({ tab: existing, reused: true });
      }
      const tab = await tabPool.create({ url, title, threadId, show: show !== false });
      if (frameHub) {
        frameHub.ensure(tab.id, { sticky: true, everyNthFrame: 1, quality: 55 }).catch(() => {});
      }
      broadcast('tab_created', tab);
      res.status(201).json({ tab, reused: false });
    } catch (err) {
      res.status(err.code === 'TAB_LIMIT' ? 409 : 500).json({ error: err.message, code: err.code });
    }
  });

  app.get('/tabs/:id', (req, res) => {
    const tab = tabPool.get(req.params.id);
    if (!tab) return res.status(404).json({ error: 'Tab not found' });
    res.json({ tab, stream: frameHub ? frameHub.meta(req.params.id) : null });
  });

  app.post('/tabs/:id/focus', (req, res) => {
    const ok = tabPool.focus(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Tab not found' });
    res.json({ ok: true, tab: tabPool.get(req.params.id) });
  });

  app.post('/tabs/:id/navigate', async (req, res) => {
    try {
      const { enforceThreadAccess } = require('./thread-guard');
      enforceThreadAccess(tabPool, req.params.id, req);
      const { url } = req.body || {};
      if (!url) return res.status(400).json({ error: 'url required' });
      const tab = await tabPool.navigate(req.params.id, url);
      res.json({ tab });
    } catch (err) {
      const status =
        err.code === 'THREAD_MISMATCH' ? 403 : err.code === 'NOT_FOUND' ? 404 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  app.post('/tabs/:id/evaluate', async (req, res) => {
    try {
      const { enforceThreadAccess } = require('./thread-guard');
      enforceThreadAccess(tabPool, req.params.id, req);
      const { expression } = req.body || {};
      if (typeof expression !== 'string') {
        return res.status(400).json({ error: 'expression string required' });
      }
      const result = await tabPool.evaluate(req.params.id, expression);
      res.json({ result });
    } catch (err) {
      const status =
        err.code === 'THREAD_MISMATCH' ? 403 : err.code === 'NOT_FOUND' ? 404 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  /**
   * Simulate file drag-and-drop (or set <input type="file">).
   * Body: { files: string[], selector?: string, x?: number, y?: number, mode?: 'auto'|'input'|'drop' }
   */
  app.post('/tabs/:id/drop-files', async (req, res) => {
    try {
      const { dropFiles } = require('./input-actions');
      const wc = tabPool.getWebContents(req.params.id);
      if (!wc) return res.status(404).json({ error: 'Tab not found' });
      const result = await dropFiles(wc, req.body || {});
      res.json({ ok: true, ...result });
    } catch (err) {
      const status =
        err.code === 'NOT_FOUND' ? 404 : err.code === 'BAD_REQUEST' ? 400 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  /** Alias matching common agent wording */
  app.post('/tabs/:id/drag-drop-files', async (req, res) => {
    try {
      const { dropFiles } = require('./input-actions');
      const wc = tabPool.getWebContents(req.params.id);
      if (!wc) return res.status(404).json({ error: 'Tab not found' });
      const result = await dropFiles(wc, { ...(req.body || {}), mode: (req.body && req.body.mode) || 'drop' });
      res.json({ ok: true, ...result });
    } catch (err) {
      const status =
        err.code === 'NOT_FOUND' ? 404 : err.code === 'BAD_REQUEST' ? 400 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  app.get('/tabs/:id/frame.jpg', async (req, res) => {
    try {
      if (!frameHub) return res.status(500).json({ error: 'Frame hub unavailable' });
      const frame = await waitForLatestFrame(frameHub, req.params.id);
      if (!frame) return res.status(503).json({ error: 'No frame yet — page may still be loading' });
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      const last = frameHub.meta(req.params.id).lastFrameAt || Date.now();
      res.setHeader('X-Frame-Age-Ms', String(Date.now() - last));
      res.send(frame);
    } catch (err) {
      res.status(err.code === 'NOT_FOUND' ? 404 : 500).json({ error: err.message });
    }
  });

  app.get('/tabs/:id/mjpeg', async (req, res) => {
    try {
      if (!frameHub) return res.status(500).json({ error: 'Frame hub unavailable' });
      await frameHub.ensure(req.params.id, { sticky: true, everyNthFrame: 1, quality: 55 });
      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Connection: 'keep-alive',
      });
      frameHub.addMjpeg(req.params.id, res);
    } catch (err) {
      if (!res.headersSent) res.status(err.code === 'NOT_FOUND' ? 404 : 500).json({ error: err.message });
    }
  });

  app.post('/tabs/:id/stream/start', async (req, res) => {
    try {
      if (!frameHub) return res.status(500).json({ error: 'Frame hub unavailable' });
      await frameHub.ensure(req.params.id, {
        sticky: true,
        everyNthFrame: 1,
        quality: (req.body && req.body.quality) || 55,
      });
      res.json({ ok: true, stream: frameHub.meta(req.params.id), live: `/live?tab=${req.params.id}` });
    } catch (err) {
      res.status(err.code === 'NOT_FOUND' ? 404 : 500).json({ error: err.message });
    }
  });

  app.post('/tabs/:id/stream/stop', async (req, res) => {
    if (!frameHub) return res.status(500).json({ error: 'Frame hub unavailable' });
    await frameHub.stop(req.params.id);
    res.json({ ok: true });
  });

  app.post('/tabs/:id/screenshot', async (req, res) => {
    try {
      if (frameHub) {
        const live = await waitForLatestFrame(frameHub, req.params.id, 800);
        if (live) {
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('X-Source', 'live-screencast');
          return res.send(live);
        }
      }
      const format = (req.body && req.body.format) || 'png';
      const buf = await tabPool.screenshot(req.params.id, { format });
      res.setHeader('Content-Type', format === 'jpeg' ? 'image/jpeg' : 'image/png');
      res.setHeader('X-Source', 'capturePage');
      res.send(buf);
    } catch (err) {
      res.status(err.code === 'NOT_FOUND' ? 404 : 500).json({ error: err.message });
    }
  });

  app.post('/tabs/:id/thread', (req, res) => {
    try {
      const { threadId } = req.body || {};
      const tab = tabPool.setThread(req.params.id, threadId || null);
      if (!tab) return res.status(404).json({ error: 'Tab not found' });
      res.json({ tab });
    } catch (err) {
      res.status(err.code === 'THREAD_TAKEN' ? 409 : 500).json({ error: err.message, code: err.code });
    }
  });

  app.delete('/tabs/:id', async (req, res) => {
    if (frameHub) await frameHub.stop(req.params.id);
    const ok = await tabPool.close(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Tab not found' });
    broadcast('tab_closed', { id: req.params.id });
    res.json({ ok: true });
  });

  app.delete('/tabs', async (_req, res) => {
    if (frameHub) await frameHub.stopAll();
    await tabPool.closeAll();
    res.json({ ok: true });
  });

  app.post('/window/minimize', async (_req, res) => {
    const { AGENT_BLOCKED } = require('./visibility-policy');
    res.status(403).json(AGENT_BLOCKED);
  });

  app.post('/window/hide', async (_req, res) => {
    const { AGENT_BLOCKED } = require('./visibility-policy');
    res.status(403).json(AGENT_BLOCKED);
  });

  app.post('/window/show', async (_req, res) => {
    const result = await onCommand('show');
    res.json({
      ok: true,
      source: 'agent-background',
      focusStolen: false,
      note: 'Agent show does not raise Cursor-Chrome over other windows. Humans watch via taskbar / tray / Ctrl+Shift+C / /live.',
      ...result,
    });
  });

  app.post('/window/restore', async (_req, res) => {
    const result = await onCommand('restore');
    res.json({ ok: true, focusStolen: false, ...result });
  });

  app.post('/window/front', async (req, res) => {
    const { tabId, threadId } = req.body || {};
    const result = await onCommand('front', { tabId, threadId });
    res.json({
      ok: true,
      source: 'agent-background',
      focusStolen: false,
      note: 'Agent front switches the active tab only — it does not steal OS focus or use always-on-top.',
      ...result,
    });
  });

  app.post('/window/park', async (_req, res) => {
    const { AGENT_BLOCKED } = require('./visibility-policy');
    res.status(403).json(AGENT_BLOCKED);
  });

  app.get('/handoff', (_req, res) => {
    res.json(handoff ? handoff.get() : { active: false });
  });

  app.get('/guide', (_req, res) => {
    res.json(guide ? guide.get() : { open: false });
  });

  app.post('/guide', (req, res) => {
    if (!guide) return res.status(500).json({ error: 'Guide not available' });
    try {
      const body = req.body || {};
      const state = guide.set({
        ...body,
        source: body.source || 'agent',
        open: body.open !== undefined ? body.open : true,
      });
      broadcast('guide', state);
      res.json({ ok: true, guide: state });
    } catch (err) {
      res.status(err.code === 'GUIDE_BUSY' ? 409 : 500).json({
        error: err.message,
        code: err.code,
        guide: err.guide || (guide && guide.get()),
      });
    }
  });

  app.post('/guide/clear', (_req, res) => {
    if (!guide) return res.status(500).json({ error: 'Guide not available' });
    const state = guide.clear();
    broadcast('guide', state);
    res.json({ ok: true, guide: state });
  });

  app.post('/guide/close', (_req, res) => {
    if (!guide) return res.status(500).json({ error: 'Guide not available' });
    const state = guide.close();
    broadcast('guide', state);
    res.json({ ok: true, guide: state });
  });

  app.post('/guide/open', (_req, res) => {
    if (!guide) return res.status(500).json({ error: 'Guide not available' });
    const state = guide.open();
    broadcast('guide', state);
    res.json({ ok: true, guide: state });
  });

  app.post('/guide/block', (req, res) => {
    if (!guide) return res.status(500).json({ error: 'Guide not available' });
    const state = guide.block(req.body || {});
    broadcast('guide', state);
    res.json({ ok: true, guide: state });
  });

  app.post('/guide/unblock', (_req, res) => {
    if (!guide) return res.status(500).json({ error: 'Guide not available' });
    const state = guide.clearBlocked();
    broadcast('guide', state);
    res.json({ ok: true, guide: state });
  });

  app.post('/guide/steps/:id', (req, res) => {
    if (!guide) return res.status(500).json({ error: 'Guide not available' });
    const raw = req.params.id;
    const indexOrId = /^\d+$/.test(raw) ? Number(raw) : raw;
    const result = guide.setStep(indexOrId, { done: !!(req.body && req.body.done) });
    if (!result.ok) return res.status(404).json(result);
    broadcast('guide', result.guide);
    res.json(result);
  });

  app.post('/handoff', async (req, res) => {
    try {
      if (!handoff) return res.status(500).json({ error: 'Handoff not available' });
      const {
        tabId = null,
        threadId = null,
        url = null,
        reason = 'login',
        message = 'Finish login / verification in Cursor-Chrome, then click Done.',
        after = 'minimize',
        wait = false,
        timeoutMs = 300000,
      } = req.body || {};

      let tab = null;
      if (tabId) tab = tabPool.get(tabId);
      else if (threadId) tab = tabPool.claimForThread(threadId);

      if (!tab && threadId) {
        tab = await tabPool.create({
          url: url || 'about:blank',
          title: 'Handoff',
          threadId,
          show: true,
        });
      }
      if (!tab) return res.status(400).json({ error: 'tabId or threadId required (and tab must exist)' });

      if (url) {
        tab = await tabPool.navigate(tab.id, url);
      }

      tabPool.focus(tab.id);
      if (frameHub) {
        frameHub.ensure(tab.id, { sticky: true, everyNthFrame: 1, quality: 60 }).catch(() => {});
      }
      const state = handoff.start({
        tabId: tab.id,
        threadId: threadId || tab.threadId,
        reason,
        message,
        after,
        force: !!(req.body && req.body.force),
      });

      await onCommand('front', { tabId: tab.id, handoff: state });

      if (wait) {
        const result = await handoff.wait(timeoutMs);
        return res.json({
          started: state,
          ...result,
          tab: tabPool.get(tab.id),
        });
      }

      res.json({ ok: true, handoff: state, tab: tabPool.get(tab.id) });
    } catch (err) {
      const status =
        err.code === 'HANDOFF_BUSY' ? 409 : err.code === 'TAB_LIMIT' ? 409 : 500;
      res.status(status).json({
        error: err.message,
        code: err.code,
        handoff: err.handoff || (handoff && handoff.get()),
      });
    }
  });

  app.post('/handoff/done', async (req, res) => {
    if (!handoff) return res.status(500).json({ error: 'Handoff not available' });
    const { note = null } = req.body || {};
    const result = handoff.done({ note, source: 'api' });
    // Persist cookies right after login handoff
    try {
      const { session } = require('electron');
      const { SHARED_PARTITION } = require('./config');
      const partition =
        (result.handoff && result.handoff.tabId && tabPool.get(result.handoff.tabId)?.partition) ||
        SHARED_PARTITION;
      await session.fromPartition(partition, { cache: true }).flushStorageData();
    } catch {
      /* ignore */
    }
    if (result.after === 'minimize' || result.after === 'hide') {
      // Agents may not stealth after handoff. Human parks via taskbar/tray only.
      result.afterForcedStay = true;
      result.after = 'stay';
    }
    broadcast('handoff_done', result);
    res.json(result);
  });

  app.post('/handoff/wait', async (req, res) => {
    if (!handoff) return res.status(500).json({ error: 'Handoff not available' });
    const timeoutMs = (req.body && req.body.timeoutMs) || 300000;
    if (!handoff.get().active) {
      return res.json({ ok: false, active: false, error: 'No handoff in progress' });
    }
    const result = await handoff.wait(timeoutMs);
    res.json(result);
  });

  app.post('/claim', async (req, res) => {
    try {
      const { threadId, url, title, isolate, profile } = req.body || {};
      if (!threadId) return res.status(400).json({ error: 'threadId required' });

      const { tab, reused, fromWarm } = await tabPool.claimOrCreate(threadId, {
        url,
        title,
        isolate,
        profile,
      });

      let live = null;
      if (frameHub) {
        await frameHub.ensure(tab.id, { sticky: true, everyNthFrame: 1, quality: 55 });
        live = {
          frame: `/tabs/${tab.id}/frame.jpg`,
          mjpeg: `/tabs/${tab.id}/mjpeg`,
          viewer: `/live?tab=${tab.id}`,
        };
      }

      if (runLog) {
        runLog.add({
          tabId: tab.id,
          threadId,
          type: 'claim',
          detail: { reused, fromWarm, url: tab.url },
        });
      }

      // Auto auth hint (non-blocking)
      let auth = null;
      try {
        const wc = tabPool.getWebContents(tab.id);
        if (wc && url) auth = await require('./page-actions').detectAuthWall(wc);
      } catch {
        /* ignore */
      }

      res.json({
        tab,
        reused,
        fromWarm: !!fromWarm,
        popups: tabPool.listPopups(tab.id),
        overlayTarget: tabPool.resolveOverlayTarget(tab.id),
        pool: tabPool.stats(),
        live,
        auth,
        profile: {
          partition: tab.partition,
          shared: tab.partition === require('./config').SHARED_PARTITION,
          name: tab.profile,
          userDataDir: getAppState().userDataDir,
        },
      });
    } catch (err) {
      res.status(err.code === 'TAB_LIMIT' ? 409 : 500).json({ error: err.message, code: err.code });
    }
  });

  /** Clear cookies for the shared profile (or a tab's partition). */
  app.post('/session/clear', async (req, res) => {
    try {
      const { session } = require('electron');
      const { SHARED_PARTITION } = require('./config');
      const tabId = req.body && req.body.tabId;
      const partition =
        (tabId && tabPool.get(tabId)?.partition) ||
        (req.body && req.body.partition) ||
        SHARED_PARTITION;
      const ses = session.fromPartition(partition, { cache: true });
      await ses.clearStorageData();
      await ses.clearCache();
      res.json({ ok: true, partition });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/session/flush', async (req, res) => {
    try {
      const { session } = require('electron');
      const { SHARED_PARTITION } = require('./config');
      const partition =
        (req.body && req.body.partition) ||
        (req.body && req.body.tabId && tabPool.get(req.body.tabId)?.partition) ||
        SHARED_PARTITION;
      await session.fromPartition(partition, { cache: true }).flushStorageData();
      res.json({ ok: true, partition });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const streamWss = new WebSocketServer({ server, path: '/stream' });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(
      JSON.stringify({
        event: 'hello',
        data: {
          app: 'Cursor-Chrome',
          pool: tabPool.stats(),
          tabs: tabPool.list(),
          handoff: handoff ? handoff.get() : null,
        },
        ts: Date.now(),
      })
    );

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        ws.send(JSON.stringify({ event: 'error', data: { error: 'invalid json' } }));
        return;
      }

      try {
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ event: 'pong', ts: Date.now() }));
          return;
        }
        if (msg.type === 'claim') {
          const { tab, reused, fromWarm } = await tabPool.claimOrCreate(msg.threadId, {
            url: msg.url,
            title: msg.title,
            isolate: msg.isolate,
            profile: msg.profile,
          });
          if (frameHub) {
            frameHub.ensure(tab.id, { sticky: true, everyNthFrame: 1, quality: 55 }).catch(() => {});
          }
          ws.send(JSON.stringify({ event: 'claimed', data: { tab, reused, fromWarm }, ts: Date.now() }));
          return;
        }
        // Pipelined power commands
        if (
          ['act', 'click', 'type', 'snapshot', 'navigate', 'evaluate', 'hover', 'scroll'].includes(msg.type)
        ) {
          const result = await handleWsCommand(msg, { tabPool, frameHub });
          ws.send(JSON.stringify({ event: 'result', data: result, id: msg.id, ts: Date.now() }));
          return;
        }
        if (msg.type === 'navigate' && msg.tabId) {
          const tab = await tabPool.navigate(msg.tabId, msg.url);
          ws.send(JSON.stringify({ event: 'navigated', data: { tab }, ts: Date.now() }));
          return;
        }
        if (msg.type === 'evaluate') {
          const result = await tabPool.evaluate(msg.tabId, msg.expression);
          ws.send(JSON.stringify({ event: 'evaluated', data: { result }, ts: Date.now() }));
          return;
        }
        ws.send(JSON.stringify({ event: 'error', data: { error: `unknown type: ${msg.type}` } }));
      } catch (err) {
        ws.send(JSON.stringify({ event: 'error', data: { error: err.message, code: err.code }, id: msg.id }));
      }
    });

    ws.on('close', () => clients.delete(ws));
  });

  streamWss.on('connection', (ws) => {
    let subscribed = null;
    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'subscribe' && msg.tabId && frameHub) {
          if (subscribed) frameHub.release(subscribed);
          await frameHub.ensure(msg.tabId, { sticky: true, everyNthFrame: 1, quality: 55 });
          frameHub.addWs(msg.tabId, ws);
          subscribed = msg.tabId;
          ws.send(JSON.stringify({ event: 'subscribed', tabId: msg.tabId }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ event: 'error', error: err.message }));
      }
    });
  });

  function listen(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve({ port, url: `http://127.0.0.1:${port}` });
      });
    });
  }

  return { app, server, listen, broadcast };
}

module.exports = { createAgentApi };
