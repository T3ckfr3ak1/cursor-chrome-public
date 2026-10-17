'use strict';

const { cdp } = require('./input-actions');

async function evaluateJson(wc, expression) {
  const result = await cdp(wc, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const msg =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      'evaluate failed';
    const err = new Error(msg);
    err.code = 'EVAL_ERROR';
    throw err;
  }
  return result.result?.value;
}

async function resolveTarget(wc, { selector, x, y, iframe } = {}) {
  if (typeof x === 'number' && typeof y === 'number') {
    return { x: Math.round(x), y: Math.round(y), selector: selector || null };
  }
  if (!selector) {
    const err = new Error('selector or x/y required');
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const frameSelector = iframe || null;
  const info = await evaluateJson(
    wc,
    `(() => {
      function queryDeep(sel, root = document) {
        const el = root.querySelector(sel);
        if (el) return el;
        const nodes = root.querySelectorAll('*');
        for (const n of nodes) {
          if (n.shadowRoot) {
            const hit = queryDeep(sel, n.shadowRoot);
            if (hit) return hit;
          }
        }
        return null;
      }
      let doc = document;
      let offsetX = 0, offsetY = 0;
      const frameSel = ${JSON.stringify(frameSelector)};
      if (frameSel) {
        const frameEl = queryDeep(frameSel);
        if (!frameEl) return { error: 'iframe not found' };
        const fr = frameEl.getBoundingClientRect();
        offsetX = fr.left; offsetY = fr.top;
        try {
          doc = frameEl.contentDocument || frameEl.contentWindow?.document;
        } catch (e) {
          return { error: 'cross-origin iframe (use CDP pierce / handoff)', crossOrigin: true };
        }
        if (!doc) return { error: 'iframe document unavailable' };
      }
      const el = queryDeep(${JSON.stringify(selector)}, doc);
      if (!el) return { error: 'element not found' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return {
        x: offsetX + r.left + r.width / 2,
        y: offsetY + r.top + r.height / 2,
        tag: el.tagName,
        type: (el.type || '').toLowerCase(),
        text: (el.innerText || el.value || '').slice(0, 120),
      };
    })()`
  );

  if (!info || info.error) {
    const err = new Error(info?.error || 'element not found');
    err.code = info?.crossOrigin ? 'CROSS_ORIGIN_IFRAME' : 'NOT_FOUND';
    throw err;
  }
  return { x: Math.round(info.x), y: Math.round(info.y), meta: info, selector };
}

async function click(wc, opts = {}) {
  const t = await resolveTarget(wc, opts);
  const btn = opts.button || 'left';
  const clickCount = opts.clickCount || 1;
  await cdp(wc, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: t.x,
    y: t.y,
    button: btn,
    buttons: btn === 'right' ? 2 : 1,
    clickCount,
  });
  await cdp(wc, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: t.x,
    y: t.y,
    button: btn,
    buttons: 0,
    clickCount,
  });
  // Trusted JS click so window.open / OAuth popups receive a user gesture.
  // CDP mouse events alone are often blocked by the popup blocker.
  if (opts.selector && opts.jsClick !== false) {
    try {
      await wc.executeJavaScript(
        `(() => {
          const el = document.querySelector(${JSON.stringify(opts.selector)});
          if (el && typeof el.click === 'function') { el.click(); return true; }
          const at = document.elementFromPoint(${t.x}, ${t.y});
          if (at && typeof at.click === 'function') { at.click(); return true; }
          return false;
        })()`,
        true
      );
    } catch {
      /* ignore */
    }
  } else if (opts.jsClick !== false) {
    try {
      await wc.executeJavaScript(
        `(() => {
          const at = document.elementFromPoint(${t.x}, ${t.y});
          if (at && typeof at.click === 'function') { at.click(); return true; }
          return false;
        })()`,
        true
      );
    } catch {
      /* ignore */
    }
  }
  return { ok: true, action: 'click', ...t };
}

async function hover(wc, opts = {}) {
  const t = await resolveTarget(wc, opts);
  await cdp(wc, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: t.x,
    y: t.y,
  });
  return { ok: true, action: 'hover', ...t };
}

async function scroll(wc, { deltaX = 0, deltaY = 600, selector, x, y } = {}) {
  let px = x;
  let py = y;
  if (selector || (px == null && py == null)) {
    if (selector) {
      const t = await resolveTarget(wc, { selector, x, y });
      px = t.x;
      py = t.y;
    } else {
      px = 400;
      py = 300;
    }
  }
  await cdp(wc, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(px),
    y: Math.round(py),
    deltaX,
    deltaY,
  });
  return { ok: true, action: 'scroll', x: px, y: py, deltaX, deltaY };
}

async function typeText(wc, opts = {}) {
  const text = opts.text ?? opts.value ?? '';
  if (opts.selector) {
    await click(wc, opts);
    if (opts.clear !== false) {
      // Select-all + backspace via key events (Ctrl+A)
      await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    }
  }
  if (opts.selector && opts.insertViaEval) {
    await evaluateJson(
      wc,
      `(() => {
        const el = document.querySelector(${JSON.stringify(opts.selector)});
        if (!el) return false;
        el.focus();
        el.value = ${JSON.stringify(String(text))};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`
    );
    return { ok: true, action: 'type', method: 'eval', selector: opts.selector };
  }
  for (const ch of String(text)) {
    await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
    await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', text: ch });
  }
  if (opts.pressEnter) {
    await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  return { ok: true, action: 'type', chars: String(text).length };
}

async function pressKey(wc, { key, code, modifiers = 0 } = {}) {
  const k = key || 'Enter';
  await cdp(wc, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: k,
    code: code || k,
    modifiers,
    windowsVirtualKeyCode: k === 'Enter' ? 13 : undefined,
  });
  await cdp(wc, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: k,
    code: code || k,
    modifiers,
    windowsVirtualKeyCode: k === 'Enter' ? 13 : undefined,
  });
  return { ok: true, action: 'press', key: k };
}

async function waitForSelector(wc, { selector, timeoutMs = 15000, iframe, state = 'visible' } = {}) {
  if (!selector) throw Object.assign(new Error('selector required'), { code: 'BAD_REQUEST' });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const t = await resolveTarget(wc, { selector, iframe });
      if (state === 'visible' || state === 'attached') return { ok: true, waitedMs: Date.now() - start, ...t };
    } catch (err) {
      if (err.code === 'CROSS_ORIGIN_IFRAME') throw err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Object.assign(new Error(`Timeout waiting for ${selector}`), { code: 'TIMEOUT' });
}

async function waitForText(wc, { text, timeoutMs = 15000, regex = false } = {}) {
  if (!text) throw Object.assign(new Error('text required'), { code: 'BAD_REQUEST' });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await evaluateJson(
      wc,
      regex
        ? `(() => { try { return new RegExp(${JSON.stringify(String(text))}, 'i').test(document.body && document.body.innerText || ''); } catch { return false; } })()`
        : `document.body && document.body.innerText.includes(${JSON.stringify(text)})`
    );
    if (found) return { ok: true, waitedMs: Date.now() - start, text };
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Object.assign(new Error(`Timeout waiting for text: ${text}`), { code: 'TIMEOUT' });
}

async function waitForNavigation(wc, { timeoutMs = 20000, waitUntil = 'domcontentloaded' } = {}) {
  const start = Date.now();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error('Navigation timeout'), { code: 'TIMEOUT' }));
    }, timeoutMs);
    const onDone = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      wc.removeListener('did-finish-load', onDone);
      wc.removeListener('dom-ready', onDone);
      wc.removeListener('did-navigate', onDone);
    };
    if (waitUntil === 'load') wc.once('did-finish-load', onDone);
    else if (waitUntil === 'commit') wc.once('did-navigate', onDone);
    else wc.once('dom-ready', onDone);
  });
  return { ok: true, waitedMs: Date.now() - start, waitUntil };
}

async function snapshot(wc, { maxNodes = 400 } = {}) {
  const data = await evaluateJson(
    wc,
    `(() => {
      const max = ${Number(maxNodes) || 400};
      const interesting = 'a,button,input,textarea,select,summary,[role],[onclick],h1,h2,h3,label,li';
      const nodes = [];
      const walk = (root, shadow = false) => {
        root.querySelectorAll(interesting).forEach((el) => {
          if (nodes.length >= max) return;
          const r = el.getBoundingClientRect();
          if (r.width < 1 && r.height < 1) return;
          const style = window.getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none') return;
          nodes.push({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || undefined,
            type: el.type || undefined,
            name: (el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || '').slice(0, 80) || undefined,
            text: (el.innerText || el.value || '').trim().slice(0, 100) || undefined,
            href: el.href || undefined,
            id: el.id || undefined,
            testId: el.getAttribute('data-testid') || undefined,
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            shadow,
          });
        });
        root.querySelectorAll('*').forEach((el) => {
          if (el.shadowRoot) walk(el.shadowRoot, true);
        });
      };
      walk(document);
      return {
        title: document.title,
        url: location.href,
        nodes,
      };
    })()`
  );
  return data;
}

async function detectAuthWall(wc) {
  return evaluateJson(
    wc,
    `(() => {
      const text = (document.body && document.body.innerText || '').toLowerCase();
      const hasPassword = !!document.querySelector('input[type=password]');
      const hints = ['sign in', 'log in', 'login', 'verify', '2fa', 'two-factor', 'captcha', 'one-time code', 'otp'];
      const hit = hints.find((h) => text.includes(h));
      const title = (document.title || '').toLowerCase();
      return {
        likely: !!(hasPassword || hit || title.includes('sign in') || title.includes('login')),
        hasPassword,
        hint: hit || null,
        url: location.href,
        title: document.title,
      };
    })()`
  );
}

/**
 * One-shot agent turn: navigate/wait/click/type/eval/snapshot/frame meta.
 */
async function act(wc, body = {}, helpers = {}) {
  const out = { ok: true, steps: [] };
  const log = (step, data) => out.steps.push({ step, ...data });

  if (body.navigate) {
    await wc.loadURL(body.navigate);
    if (body.wait !== false) {
      const w = await waitForNavigation(wc, {
        timeoutMs: body.timeoutMs || 20000,
        waitUntil: body.waitUntil || 'domcontentloaded',
      });
      log('navigate', { url: body.navigate, ...w });
    } else log('navigate', { url: body.navigate });
  }
  if (body.waitForSelector) {
    const w = await waitForSelector(wc, {
      selector: body.waitForSelector,
      timeoutMs: body.timeoutMs || 15000,
      iframe: body.iframe,
    });
    log('waitForSelector', w);
  }
  if (body.waitForText) {
    const w = await waitForText(wc, {
      text: typeof body.waitForText === 'object' ? body.waitForText.text : body.waitForText,
      timeoutMs: body.timeoutMs || 15000,
      regex: !!(typeof body.waitForText === 'object' && body.waitForText.regex),
    });
    log('waitForText', w);
  }
  if (body.waitForStable) {
    const smart = require('./smart-actions');
    const w = await smart.waitForStable(
      wc,
      typeof body.waitForStable === 'object' ? body.waitForStable : {}
    );
    log('waitForStable', w);
  }
  if (body.hover) {
    log('hover', await hover(wc, typeof body.hover === 'string' ? { selector: body.hover } : body.hover));
  }
  if (body.clickText || body.clickByText) {
    const smart = require('./smart-actions');
    const opts = body.clickText || body.clickByText;
    log(
      'clickByText',
      await smart.clickByText(wc, typeof opts === 'string' ? { text: opts } : opts)
    );
  }
  if (body.click) {
    log('click', await click(wc, typeof body.click === 'string' ? { selector: body.click } : body.click));
  }
  if (body.pickTableRow) {
    const smart = require('./smart-actions');
    log('pickTableRow', await smart.pickTableRow(wc, body.pickTableRow));
  }
  if (body.type) {
    log('type', await typeText(wc, body.type));
  }
  if (body.scroll) {
    log('scroll', await scroll(wc, body.scroll));
  }
  if (body.evaluate) {
    const result = await evaluateJson(wc, body.evaluate);
    log('evaluate', { result });
    out.evaluate = result;
  }
  if (body.snapshot !== false && body.snapshot !== 'none') {
    out.snapshot = await snapshot(wc, { maxNodes: body.maxNodes || 400 });
    log('snapshot', { nodes: out.snapshot.nodes?.length || 0 });
  }
  if (body.authCheck) {
    out.auth = await detectAuthWall(wc);
    log('authCheck', out.auth);
  }
  if (helpers.getFrameMeta) {
    out.frame = helpers.getFrameMeta();
  }
  out.url = wc.getURL();
  out.title = wc.getTitle();
  return out;
}

module.exports = {
  evaluateJson,
  resolveTarget,
  click,
  hover,
  scroll,
  typeText,
  pressKey,
  waitForSelector,
  waitForText,
  waitForNavigation,
  snapshot,
  detectAuthWall,
  act,
};
