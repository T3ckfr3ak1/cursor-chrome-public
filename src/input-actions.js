'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

/**
 * Shared CDP debugger access for a WebContents.
 * Leaves the session attached (FrameHub may also use it for screencast).
 */
async function cdp(wc, method, params = {}) {
  if (!wc || wc.isDestroyed()) {
    const err = new Error('Tab not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  // Retry attach once — FrameHub/screencast may share the debugger; Windows can race on close.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3');
      }
      return await wc.debugger.sendCommand(method, params);
    } catch (err) {
      const msg = String(err.message || err);
      if (msg.includes('Already attached')) {
        try {
          return await wc.debugger.sendCommand(method, params);
        } catch (e2) {
          if (attempt === 1) throw e2;
        }
      } else if (/detached|not attached|Target closed|Inspected target navigated/i.test(msg) && attempt === 0) {
        try {
          if (wc.debugger.isAttached()) wc.debugger.detach();
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, 40));
        continue;
      } else {
        throw err;
      }
    }
  }
  const err = new Error('CDP attach failed');
  err.code = 'CDP_FAILED';
  throw err;
}

/**
 * Best-effort probe of Chromium remote-debugging port (not the agent API).
 * Does not throw; returns { ok, latencyMs?, browser?, webSocketDebuggerUrl?, error? }.
 */
function probeChromiumCdp(port, { timeoutMs = 800 } = {}) {
  const p = Number(port) || 9223;
  const started = Date.now();
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: p,
        path: '/json/version',
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 8192) body = body.slice(0, 8192);
        });
        res.on('end', () => {
          const latencyMs = Date.now() - started;
          if (res.statusCode !== 200) {
            return resolve({
              ok: false,
              port: p,
              latencyMs,
              error: `HTTP ${res.statusCode}`,
            });
          }
          try {
            const j = JSON.parse(body);
            resolve({
              ok: true,
              port: p,
              latencyMs,
              browser: j.Browser || j.browser || null,
              protocolVersion: j['Protocol-Version'] || j.protocolVersion || null,
              webSocketDebuggerUrl: j.webSocketDebuggerUrl || null,
            });
          } catch (e) {
            resolve({ ok: false, port: p, latencyMs, error: 'invalid json' });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, port: p, latencyMs: Date.now() - started, error: 'timeout' });
    });
    req.on('error', (err) => {
      resolve({
        ok: false,
        port: p,
        latencyMs: Date.now() - started,
        error: err.message || String(err),
      });
    });
  });
}

function resolvePaths(files) {
  const list = Array.isArray(files) ? files : files ? [files] : [];
  if (!list.length) {
    const err = new Error('files array required (absolute paths or folders)');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  const resolved = [];
  const addFile = (abs) => {
    const st = fs.statSync(abs);
    if (st.isFile()) resolved.push(abs);
    else if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) {
        const child = path.join(abs, name);
        try {
          if (fs.statSync(child).isFile()) resolved.push(child);
        } catch {
          /* skip */
        }
      }
    } else {
      const err = new Error(`Not a file or folder: ${abs}`);
      err.code = 'BAD_REQUEST';
      throw err;
    }
  };
  for (const f of list) {
    const abs = path.resolve(String(f));
    if (!fs.existsSync(abs)) {
      const err = new Error(`Path not found: ${abs}`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    addFile(abs);
  }
  if (!resolved.length) {
    const err = new Error('No files found to drop');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  return resolved;
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.aab': 'application/octet-stream',
    '.apk': 'application/vnd.android.package-archive',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.svg': 'image/svg+xml',
  };
  return map[ext] || 'application/octet-stream';
}

function dragDataFor(files) {
  // CDP Input.DragDataItem fields: mimeType, data?, title?, baseURL? (no `name`)
  return {
    items: files.map((f) => ({
      mimeType: mimeFor(f),
      title: path.basename(f),
    })),
    files,
    dragOperationsMask: 1, // Copy
  };
}

async function queryElementInfo(wc, selector, { index = null } = {}) {
  await cdp(wc, 'DOM.enable');
  await cdp(wc, 'Runtime.enable');
  const evalResult = await cdp(wc, 'Runtime.evaluate', {
    expression: `(() => {
      const sel = ${JSON.stringify(selector)};
      const idx = ${index == null ? 'null' : Number(index)};
      let el = null;
      if (idx != null && Number.isFinite(idx)) {
        const all = document.querySelectorAll(sel);
        el = all[idx] || null;
      } else {
        el = document.querySelector(sel);
      }
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        type: (el.type || '').toLowerCase(),
        isFileInput: el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file',
        multiple: !!(el.multiple),
        accept: el.accept || '',
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        width: r.width,
        height: r.height,
      };
    })()`,
    returnByValue: true,
  });
  return evalResult?.result?.value || null;
}

/**
 * Notify Angular / React / plain listeners that a file input changed.
 * DOM.setFileInputFiles alone often leaves Material / CDK controls blank.
 */
async function notifyFileInputChanged(wc, selector, index = null) {
  await cdp(wc, 'Runtime.enable');
  const result = await cdp(wc, 'Runtime.evaluate', {
    expression: `(() => {
      const sel = ${JSON.stringify(selector || 'input[type=file]')};
      const idx = ${index == null ? 'null' : Number(index)};
      let el = null;
      if (idx != null && Number.isFinite(idx)) {
        el = document.querySelectorAll(sel)[idx] || null;
      } else {
        el = document.querySelector(sel);
      }
      if (!el) return { ok: false, reason: 'not-found' };
      try { el.focus(); } catch (_) {}
      const fire = (type, init) => {
        try {
          el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, composed: true, ...init }));
        } catch (_) {}
      };
      // Angular listens to input + change; composed helps pierce some shadow hosts
      fire('input');
      fire('change');
      try {
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: 'insertFromPaste',
          data: null,
        }));
      } catch (_) {}
      // Nudge Angular Material file chips that watch blur / click sequence
      try {
        el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      } catch (_) {}
      const n = (el.files && el.files.length) || 0;
      return {
        ok: true,
        fileCount: n,
        names: n ? Array.from(el.files).map((f) => f.name) : [],
      };
    })()`,
    returnByValue: true,
    awaitPromise: false,
  });
  return result?.result?.value || { ok: false };
}

/**
 * Set files on an <input type=file>, preferring indexed query when many inputs exist.
 * Always fires change/input after CDP set so Angular Material / SPA upload UIs react.
 */
async function setFileInputFiles(wc, selector, files, { index = null } = {}) {
  const sel = selector || 'input[type=file]';
  await cdp(wc, 'DOM.enable');
  const { root } = await cdp(wc, 'DOM.getDocument', { depth: -1, pierce: true });
  let nodeId = null;
  let usedIndex = index;

  if (index != null && Number.isFinite(Number(index))) {
    const { nodeIds } = await cdp(wc, 'DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: sel,
    });
    nodeId = nodeIds && nodeIds[Number(index)];
    usedIndex = Number(index);
  } else {
    // When selector is generic and many nodes, prefer first visible via querySelector
    const q = await cdp(wc, 'DOM.querySelector', {
      nodeId: root.nodeId,
      selector: sel,
    });
    nodeId = q.nodeId;
  }

  if (!nodeId) {
    const err = new Error(`No element matches selector: ${sel}${usedIndex != null ? ` [${usedIndex}]` : ''}`);
    err.code = 'NOT_FOUND';
    throw err;
  }

  await cdp(wc, 'DOM.setFileInputFiles', { nodeId, files });
  const notified = await notifyFileInputChanged(wc, sel, usedIndex);

  // Second path if page still shows 0 files — retry notify after microtask
  if (!notified.ok || notified.fileCount === 0) {
    await new Promise((r) => setTimeout(r, 50));
    await notifyFileInputChanged(wc, sel, usedIndex);
  }

  return {
    mode: 'file-input',
    selector: sel,
    files,
    index: usedIndex != null ? usedIndex : null,
    notified,
  };
}

async function dispatchFileDrop(wc, x, y, files) {
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  let data = dragDataFor(files);

  const send = async (type, payload) =>
    cdp(wc, 'Input.dispatchDragEvent', { type, x: px, y: py, data: payload });

  try {
    await send('dragEnter', data);
  } catch {
    data = { items: [], files, dragOperationsMask: 1 };
    await send('dragEnter', data);
  }
  await send('dragOver', data);
  await send('drop', data);
  return { mode: 'drag-drop', x: px, y: py, files };
}

/**
 * Intercept Chromium file chooser so OS picker never opens (agent hang).
 * Caller triggers click that would open the dialog; we set files via CDP.
 *
 * @param {Electron.WebContents} wc
 * @param {string[]} files absolute paths
 * @param {{ clickText?: string, clickSelector?: string, timeoutMs?: number }} [opts]
 */
async function dropFilesViaChooser(wc, files, opts = {}) {
  files = resolvePaths(files);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 12000;

  await cdp(wc, 'Page.enable');
  await cdp(wc, 'Page.setInterceptFileChooserDialog', { enabled: true });

  const choosePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        wc.debugger.removeListener('message', onMessage);
      } catch {
        /* ignore */
      }
      reject(new Error(`File chooser not opened within ${timeoutMs}ms`));
    }, timeoutMs);

    function onMessage(_event, method, params) {
      if (method !== 'Page.fileChooserOpened') return;
      clearTimeout(timer);
      try {
        wc.debugger.removeListener('message', onMessage);
      } catch {
        /* ignore */
      }
      resolve(params || {});
    }

    try {
      wc.debugger.on('message', onMessage);
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });

  // Fire the click that would open the native chooser (viewport-safe: always scroll first).
  // Prefer coords from caller after scrolling a drawer control into view.
  const clickText = opts.clickText || null;
  const clickSelector = opts.clickSelector || null;
  const preferX = typeof opts.x === 'number' ? opts.x : null;
  const preferY = typeof opts.y === 'number' ? opts.y : null;
  let clickResult = { ok: false };

  if (preferX != null && preferY != null) {
    try {
      await cdp(wc, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: preferX,
        y: preferY,
        button: 'left',
        clickCount: 1,
      });
      await cdp(wc, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: preferX,
        y: preferY,
        button: 'left',
        clickCount: 1,
      });
      clickResult = { ok: true, text: 'xy', x: preferX, y: preferY };
    } catch (e) {
      clickResult = { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  if (!clickResult.ok) {
    const clicked = await cdp(wc, 'Runtime.evaluate', {
      expression: `(() => {
        var clickText = ${JSON.stringify(clickText)};
        var clickSelector = ${JSON.stringify(clickSelector)};
        var roots = Array.from(document.querySelectorAll('[role=dialog],[aria-modal=true],.cdk-overlay-pane'));
        if (!roots.length) roots = [document.body];
        var root = roots[roots.length - 1];
        function visible(e) {
          var r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < (window.innerHeight || 2000);
        }
        function scoreText(t) {
          t = (t || '').trim();
          if (/^Upload$/i.test(t)) return 100;
          if (/^Upload /i.test(t) && t.length < 40) return 90;
          if (/Browse|Choose file|Select file|From device|Computer/i.test(t) && t.length < 60) return 80;
          if (/add_photo|file_upload/i.test(t)) return 75;
          return 0;
        }
        var el = null;
        if (clickSelector) {
          try { el = root.querySelector(clickSelector) || document.querySelector(clickSelector); } catch (_) {}
        }
        if (!el && clickText) {
          var re = new RegExp(clickText, 'i');
          var cands = Array.from(root.querySelectorAll('button,a,[role=button],span,label,div,input,material-button'));
          el = cands
            .map(function (e) {
              var t = ((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.value || '')).trim().replace(/\\s+/g, ' ');
              return { e: e, t: t, s: scoreText(t) || (re.test(t) && t.length < 100 ? 50 : 0) };
            })
            .filter(function (x) { return x.s > 0 && visible(x.e); })
            .sort(function (a, b) { return b.s - a.s; })[0];
          el = el && el.e;
        }
        if (!el) {
          var best = null;
          var bestS = 0;
          Array.from(root.querySelectorAll('button,a,[role=button],span,label,material-button')).forEach(function (e) {
            if (!visible(e)) return;
            var t = ((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')).trim().replace(/\\s+/g, ' ');
            var s = scoreText(t);
            if (s > bestS) { bestS = s; best = e; }
          });
          el = best;
        }
        if (!el) return { ok: false, dialogs: roots.length };
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        var rect = el.getBoundingClientRect();
        try { el.click(); } catch (_) {}
        return {
          ok: true,
          text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 60),
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
        };
      })()`,
      returnByValue: true,
      awaitPromise: false,
    });
    clickResult = clicked?.result?.value || clicked?.result || { ok: false };
  }

  if (!clickResult.ok) {
    try {
      await cdp(wc, 'Page.setInterceptFileChooserDialog', { enabled: false });
    } catch {
      /* ignore */
    }
    const err = new Error('Could not find Upload control to intercept');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const params = await choosePromise;
  const backendNodeId = params.backendNodeId;
  if (!backendNodeId) {
    try {
      await cdp(wc, 'Page.setInterceptFileChooserDialog', { enabled: false });
    } catch {
      /* ignore */
    }
    const err = new Error('File chooser opened without backendNodeId');
    err.code = 'CDP_FAILED';
    throw err;
  }

  await cdp(wc, 'DOM.setFileInputFiles', { backendNodeId, files });
  await notifyFileInputChanged(wc, 'input[type=file]', null);

  try {
    await cdp(wc, 'Page.setInterceptFileChooserDialog', { enabled: false });
  } catch {
    /* ignore */
  }

  return {
    mode: 'file-chooser-intercept',
    files,
    click: clickResult,
    backendNodeId,
  };
}

/**
 * Drop / attach files in the page.
 * - file inputs → DOM.setFileInputFiles + Angular-friendly change/input events
 * - multi-input pages honor useIndex / opts.index
 * - drop zones / coords → CDP Input.dispatchDragEvent sequence
 * - mode: 'chooser' → intercept OS file picker (no hang)
 *
 * @param {Electron.WebContents} wc
 * @param {{ files: string[], selector?: string, x?: number, y?: number,
 *   mode?: 'auto'|'input'|'drop'|'chooser', index?: number, useIndex?: number,
 *   clickText?: string, clickSelector?: string }} opts
 */
async function dropFiles(wc, opts = {}) {
  const files = resolvePaths(opts.files);
  const mode = opts.mode || 'auto';

  if (mode === 'chooser' || opts.interceptChooser) {
    return dropFilesViaChooser(wc, files, {
      clickText: opts.clickText,
      clickSelector: opts.clickSelector,
      timeoutMs: opts.timeoutMs,
      x: opts.x,
      y: opts.y,
    });
  }

  let selector = opts.selector || null;
  let x = opts.x;
  let y = opts.y;
  let index =
    opts.index != null
      ? Number(opts.index)
      : opts.useIndex != null
        ? Number(opts.useIndex)
        : null;
  if (index != null && !Number.isFinite(index)) index = null;

  // Auto-pick a file input when caller only passed files
  if (!selector && (typeof x !== 'number' || typeof y !== 'number') && mode !== 'drop') {
    const { findBestFileInput } = require('./smart-actions');
    const preferExt = path.extname(files[0] || '').toLowerCase() || null;
    const best = await findBestFileInput(wc, { preferExt });
    if (best && best.selector) {
      selector = best.selector;
      if (index == null && best.useIndex != null) index = best.useIndex;
      if (mode === 'auto' || mode === 'input') {
        try {
          const result = await setFileInputFiles(wc, selector, files, { index });
          return {
            ...result,
            autoDetected: true,
            accept: best.accept,
            count: best.count,
          };
        } catch {
          /* fall through */
        }
      }
    }
  }

  if (selector) {
    const info = await queryElementInfo(wc, selector, { index });
    if (!info) {
      // Fallback: re-score file inputs; always keep useIndex
      if (mode !== 'drop') {
        const { findBestFileInput } = require('./smart-actions');
        const best = await findBestFileInput(wc, {
          preferExt: path.extname(files[0] || '').toLowerCase() || null,
        });
        if (best) {
          const fallbackIndex =
            index != null ? index : best.useIndex != null ? best.useIndex : null;
          const result = await setFileInputFiles(
            wc,
            best.selector || 'input[type=file]',
            files,
            { index: fallbackIndex }
          );
          return {
            ...result,
            autoDetected: true,
            note: 'fallback scored file input',
            accept: best.accept,
            count: best.count,
          };
        }
      }
      const err = new Error(`No element matches selector: ${selector}`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    if (mode !== 'drop' && (mode === 'input' || info.isFileInput)) {
      return setFileInputFiles(wc, selector, files, { index });
    }

    x = typeof x === 'number' ? x : info.x;
    y = typeof y === 'number' ? y : info.y;
  }

  if (typeof x !== 'number' || typeof y !== 'number') {
    // Last resort: best file input (not always node 0)
    try {
      const { findBestFileInput } = require('./smart-actions');
      const best = await findBestFileInput(wc, {
        preferExt: path.extname(files[0] || '').toLowerCase() || null,
      });
      const sel = (best && best.selector) || 'input[type=file]';
      const idx =
        index != null
          ? index
          : best && best.useIndex != null
            ? best.useIndex
            : null;
      const result = await setFileInputFiles(wc, sel, files, { index: idx });
      return {
        ...result,
        autoDetected: true,
        note: 'last-resort scored file input',
        accept: best && best.accept,
        count: best && best.count,
      };
    } catch {
      /* ignore */
    }
    // Try chooser intercept as final resort (click Upload safely)
    try {
      return await dropFilesViaChooser(wc, files, {
        clickText: opts.clickText || 'Upload',
        timeoutMs: opts.timeoutMs || 10000,
      });
    } catch {
      /* ignore */
    }
    const err = new Error('Provide selector (drop zone or file input) or x/y coordinates');
    err.code = 'BAD_REQUEST';
    throw err;
  }

  return dispatchFileDrop(wc, x, y, files);
}

/**
 * Also expose a JS-level DataTransfer drop for pages that only listen to DOM events
 * (fallback after CDP drag). Uses File objects via CDP-backed path when possible.
 */
async function dropFilesDomFallback(wc, selector, files) {
  // Prefer CDP drag for real FileList; this only fires empty drag events as a listener nudge.
  await cdp(wc, 'Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      for (const type of ['dragenter', 'dragover', 'drop']) {
        const ev = new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
        el.dispatchEvent(ev);
      }
      return true;
    })()`,
    returnByValue: true,
  });
}

module.exports = {
  cdp,
  dropFiles,
  dropFilesViaChooser,
  setFileInputFiles,
  dispatchFileDrop,
  resolvePaths,
  dropFilesDomFallback,
  notifyFileInputChanged,
  probeChromiumCdp,
  mimeFor,
};
