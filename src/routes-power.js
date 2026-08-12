'use strict';

const path = require('path');
const page = require('./page-actions');
const { dropFiles } = require('./input-actions');
const { exportSession, importSession, PROFILES } = require('./profiles');
const { PICKER_SCRIPT } = require('./recorder');
const { SHARED_PARTITION } = require('./config');

function statusCode(err) {
  if (err.code === 'NOT_FOUND') return 404;
  if (err.code === 'BAD_REQUEST') return 400;
  if (err.code === 'THREAD_MISMATCH') return 403;
  if (
    err.code === 'TAB_LIMIT' ||
    err.code === 'HANDOFF_BUSY' ||
    err.code === 'GUIDE_BUSY' ||
    err.code === 'THREAD_TAKEN' ||
    err.code === 'CROSS_ORIGIN_IFRAME' ||
    err.code === 'DANGEROUS_CLICK' ||
    err.code === 'PAGE_ERROR'
  ) {
    return 409;
  }
  if (err.code === 'TIMEOUT' || err.code === 'NAV_TIMEOUT') return 408;
  return 500;
}

/**
 * Register power-user routes onto the Express app.
 */
function registerPowerRoutes(app, ctx) {
  const {
    tabPool,
    frameHub,
    runLog,
    networkHub,
    recorder,
    handoff,
    getAppState,
    onCommand,
    metrics,
  } = ctx;

  const touch = (tabId, threadId, type, detail) => {
    if (runLog) runLog.add({ tabId, threadId, type, detail });
    if (recorder) recorder.push(tabId, { type, ...detail });
  };

  const { enforceThreadAccess } = require('./thread-guard');
  const guard = (req) => enforceThreadAccess(tabPool, req.params.id, req);

  const wcOf = (id) => {
    const wc = tabPool.getWebContents(id);
    if (!wc) {
      const err = new Error('Tab not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    return wc;
  };

  app.get('/metrics', (_req, res) => {
    const pool = tabPool.stats();
    const frameStats = {};
    for (const t of tabPool.list()) {
      frameStats[t.id] = frameHub ? frameHub.meta(t.id) : null;
    }
    res.json({
      ok: true,
      ts: Date.now(),
      uptimeMs: metrics?.startedAt ? Date.now() - metrics.startedAt : null,
      pool,
      frames: frameStats,
      downloads: networkHub ? networkHub.listDownloads(10) : [],
      logSize: runLog ? runLog.entries.length : 0,
      speedMode: pool.speedMode,
      profiles: Object.keys(PROFILES),
      ...getAppState(),
    });
  });

  app.get('/log', (req, res) => {
    res.json({
      entries: runLog
        ? runLog.list({
            threadId: req.query.threadId,
            tabId: req.query.tabId,
            limit: Number(req.query.limit || 100),
          })
        : [],
    });
  });

  app.delete('/log', (_req, res) => {
    if (runLog) runLog.clear();
    res.json({ ok: true });
  });

  app.post('/speed-mode', (req, res) => {
    const enabled = !!(req.body && req.body.enabled);
    tabPool.setSpeedMode(enabled);
    res.json({ ok: true, speedMode: enabled, pool: tabPool.stats() });
  });

  app.post('/warm', async (_req, res) => {
    const pool = await tabPool.ensureWarm();
    res.json({ ok: true, pool });
  });

  app.post('/tabs/:id/act', async (req, res) => {
    try {
      const wc = wcOf(req.params.id);
      const tab = tabPool.get(req.params.id);
      const result = await page.act(wc, req.body || {}, {
        getFrameMeta: () => (frameHub ? frameHub.meta(req.params.id) : null),
      });
      touch(req.params.id, tab?.threadId, 'act', { steps: result.steps?.length });
      if (result.auth?.likely && req.body?.autoHandoff) {
        result.suggestedHandoff = true;
      }
      res.json(result);
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code });
    }
  });

  app.post('/tabs/:id/snapshot', async (req, res) => {
    try {
      const data = await page.snapshot(wcOf(req.params.id), req.body || {});
      res.json(data);
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code });
    }
  });

  app.post('/tabs/:id/click', async (req, res) => {
    try {
      guard(req);
      const body = req.body || {};
      const wc = wcOf(req.params.id);
      let out;
      if (body.text || body.clickText) {
        const smart = require('./smart-actions');
        out = await smart.clickByText(wc, {
          ...body,
          text: body.text || body.clickText,
        });
      } else {
        out = await page.click(wc, body);
      }
      touch(req.params.id, tabPool.get(req.params.id)?.threadId, 'click', out);
      res.json(out);
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code, sample: err.sample, found: err.found });
    }
  });

  app.post('/tabs/:id/click-text', async (req, res) => {
    try {
      guard(req);
      const smart = require('./smart-actions');
      const out = await smart.clickByText(wcOf(req.params.id), req.body || {});
      touch(req.params.id, tabPool.get(req.params.id)?.threadId, 'clickByText', out);
      res.json(out);
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code, sample: err.sample, found: err.found });
    }
  });

  app.post('/tabs/:id/pick-row', async (req, res) => {
    try {
      guard(req);
      const smart = require('./smart-actions');
      const out = await smart.pickTableRow(wcOf(req.params.id), req.body || {});
      touch(req.params.id, tabPool.get(req.params.id)?.threadId, 'pickTableRow', out);
      res.json(out);
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code });
    }
  });

  app.post('/tabs/:id/navigate-retry', async (req, res) => {
    try {
      guard(req);
      const smart = require('./smart-actions');
      const { url, ...opts } = req.body || {};
      if (!url) return res.status(400).json({ error: 'url required' });
      const out = await smart.navigateRetry(wcOf(req.params.id), url, opts);
      const tab = tabPool.get(req.params.id);
      if (tab) {
        tab.url = out.url || url;
        tab.lastActiveAt = Date.now();
      }
      touch(req.params.id, tab?.threadId, 'navigateRetry', { url, attempt: out.attempt });
      res.json(out);
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code, page: err.page });
    }
  });

  app.post('/tabs/:id/type', async (req, res) => {
    try {
      guard(req);
      const out = await page.typeText(wcOf(req.params.id), req.body || {});
      touch(req.params.id, tabPool.get(req.params.id)?.threadId, 'type', {
        selector: req.body?.selector,
        chars: out.chars,
      });
      res.json(out);
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code });
    }
  });

  app.post('/tabs/:id/hover', async (req, res) => {
    try {
      res.json(await page.hover(wcOf(req.params.id), req.body || {}));
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code });
    }
  });

  app.post('/tabs/:id/scroll', async (req, res) => {
    try {
      res.json(await page.scroll(wcOf(req.params.id), req.body || {}));
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code });
    }
  });

  app.post('/tabs/:id/press', async (req, res) => {
    try {
      res.json(await page.pressKey(wcOf(req.params.id), req.body || {}));
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code });
    }
  });

  app.post('/tabs/:id/wait', async (req, res) => {
    try {
      const body = req.body || {};
      const wc = wcOf(req.params.id);
      let out;
      if (body.stable || body.waitForStable) {
        const smart = require('./smart-actions');
        out = await smart.waitForStable(wc, body.stable || body.waitForStable || body);
      } else if (body.selector) out = await page.waitForSelector(wc, body);
      else if (body.text) out = await page.waitForText(wc, body);
      else if (body.navigation) out = await page.waitForNavigation(wc, body);
      else if (body.urlIncludes || body.status) {
        if (!networkHub) return res.status(500).json({ error: 'network hub unavailable' });
        out = await networkHub.waitForResponse(req.params.id, body);
      } else if (body.download) {
        if (!networkHub) return res.status(500).json({ error: 'network hub unavailable' });
        out = await networkHub.waitForDownload(body);
      } else {
        return res.status(400).json({
          error: 'Provide stable, selector, text, navigation, urlIncludes, or download',
        });
      }
      res.json(out);
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code, page: err.page });
    }
  });

  app.get('/tabs/:id/network', (req, res) => {
    res.json({ requests: networkHub ? networkHub.list(req.params.id, Number(req.query.limit || 50)) : [] });
  });

  app.get('/downloads', (req, res) => {
    res.json({ downloads: networkHub ? networkHub.listDownloads(Number(req.query.limit || 50)) : [] });
  });

  app.post('/tabs/:id/auth-check', async (req, res) => {
    try {
      const auth = await page.detectAuthWall(wcOf(req.params.id));
      res.json({ auth });
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code });
    }
  });

  app.post('/tabs/:id/auto-handoff', async (req, res) => {
    try {
      const tab = tabPool.get(req.params.id);
      const auth = await page.detectAuthWall(wcOf(req.params.id));
      if (!auth.likely) return res.json({ ok: true, handedOff: false, auth });
      if (!handoff) return res.status(500).json({ error: 'Handoff unavailable', auth });
      const message =
        (req.body && req.body.message) ||
        `Sign-in / verification detected (${auth.hint || 'login'}). Hand back to Cursor when done.`;
      tabPool.focus(req.params.id);
      const state = handoff.start({
        tabId: req.params.id,
        threadId: tab?.threadId,
        reason: 'auto-auth',
        message,
        after: (req.body && req.body.after) || 'minimize',
      });
      await onCommand('front', { tabId: req.params.id, handoff: state });
      touch(req.params.id, tab?.threadId, 'auto-handoff', auth);
      if (req.body && req.body.wait) {
        const result = await handoff.wait((req.body && req.body.timeoutMs) || 300000);
        return res.json({ ok: true, handedOff: true, auth, ...result });
      }
      res.json({ ok: true, handedOff: true, auth, handoff: state });
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code });
    }
  });

  app.post('/window/watch', async (req, res) => {
    const { tabId, threadId, message, stealVisible } = req.body || {};
    // Background-only by default: do not flip human-visible tab across concurrent threads.
    if (stealVisible) {
      if (tabId) tabPool.focus(tabId);
      else if (threadId) {
        const t = tabPool.claimForThread(threadId);
        if (t) tabPool.focus(t.id);
      }
    }
    await onCommand('front', { tabId, threadId, stealVisible: !!stealVisible });
    res.json({
      ok: true,
      watching: true,
      focusStolen: false,
      visibleSwitched: !!stealVisible,
      message: message || 'Active tab selected (window not raised)',
      note: stealVisible
        ? 'Visible tab switched for human co-watch.'
        : 'Agent watch does not switch the visible tab. Pass stealVisible:true only when the human asked to watch this thread. Prefer /live?tab=',
      activeTabId: tabPool.activeTabId,
      popups: tabId ? tabPool.listPopups(tabId) : [],
    });
  });

  app.post('/tabs/:id/picker/start', async (req, res) => {
    try {
      const result = await page.evaluateJson(wcOf(req.params.id), PICKER_SCRIPT);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code });
    }
  });

  app.get('/tabs/:id/picker/result', async (req, res) => {
    try {
      const pick = await page.evaluateJson(wcOf(req.params.id), 'window.__ccLastPick || null');
      res.json({ pick });
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code });
    }
  });

  app.post('/tabs/:id/record/start', (req, res) => {
    if (!recorder) return res.status(500).json({ error: 'recorder unavailable' });
    const tab = tabPool.get(req.params.id);
    const rec = recorder.start(req.params.id, tab?.threadId || null);
    res.json({ ok: true, recording: rec });
  });

  app.post('/tabs/:id/record/stop', (req, res) => {
    if (!recorder) return res.status(500).json({ error: 'recorder unavailable' });
    const rec = recorder.stop(req.params.id);
    res.json({ ok: true, recording: rec, playbook: recorder.toPlaybook(req.params.id) });
  });

  app.get('/tabs/:id/record', (req, res) => {
    if (!recorder) return res.json({ recording: null, playbook: null });
    res.json({ recording: recorder.get(req.params.id), playbook: recorder.toPlaybook(req.params.id) });
  });

  app.post('/tabs/:id/playbook', async (req, res) => {
    try {
      const steps =
        (req.body && req.body.steps) ||
        (recorder && recorder.toPlaybook(req.params.id)?.steps) ||
        [];
      const wc = wcOf(req.params.id);
      const results = [];
      for (const step of steps) {
        if (step.navigate) {
          await wc.loadURL(step.navigate);
          results.push({ navigate: step.navigate });
        } else if (step.click) results.push(await page.click(wc, step.click));
        else if (step.type) results.push(await page.typeText(wc, step.type));
        else if (step.hover) results.push(await page.hover(wc, step.hover));
        else if (step.scroll) results.push(await page.scroll(wc, step.scroll));
        else if (step.waitForSelector) results.push(await page.waitForSelector(wc, step));
        else if (step.dropFiles) results.push(await dropFiles(wc, step.dropFiles));
        else if (step.act) results.push(await page.act(wc, step.act));
        else results.push({ skipped: step });
      }
      res.json({ ok: true, results });
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code });
    }
  });

  app.get('/profiles', (_req, res) => {
    res.json({ profiles: PROFILES, activeDefault: SHARED_PARTITION });
  });

  app.post('/session/export', async (req, res) => {
    try {
      const partition = (req.body && req.body.partition) || SHARED_PARTITION;
      const out = await exportSession(partition, req.body && req.body.path);
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/session/import', async (req, res) => {
    try {
      const filePath = req.body && req.body.path;
      if (!filePath) return res.status(400).json({ error: 'path required' });
      const partition = (req.body && req.body.partition) || SHARED_PARTITION;
      res.json(await importSession(filePath, partition));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Enhance drop-files recording
  app.post('/tabs/:id/drop-files-logged', async (req, res) => {
    try {
      const result = await dropFiles(wcOf(req.params.id), req.body || {});
      touch(req.params.id, tabPool.get(req.params.id)?.threadId, 'dropFiles', {
        files: result.files,
        mode: result.mode,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(statusCode(err)).json({ error: err.message, code: err.code });
    }
  });
}

/**
 * Handle JSON commands on the /ws control socket (pipelined agent channel).
 */
async function handleWsCommand(msg, ctx) {
  const { tabPool, frameHub } = ctx;
  const type = msg.type;
  const tabId = msg.tabId;
  const wc = tabId ? tabPool.getWebContents(tabId) : null;

  if (type === 'act' && wc) return page.act(wc, msg.body || {}, { getFrameMeta: () => frameHub?.meta(tabId) });
  if (type === 'click' && wc) return page.click(wc, msg);
  if (type === 'type' && wc) return page.typeText(wc, msg);
  if (type === 'snapshot' && wc) return page.snapshot(wc, msg);
  if (type === 'navigate' && tabId) return tabPool.navigate(tabId, msg.url);
  if (type === 'evaluate' && wc) return { result: await page.evaluateJson(wc, msg.expression) };
  throw Object.assign(new Error(`unknown or invalid ws command: ${type}`), { code: 'BAD_REQUEST' });
}

module.exports = { registerPowerRoutes, handleWsCommand };
