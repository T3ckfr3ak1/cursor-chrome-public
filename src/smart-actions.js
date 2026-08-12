'use strict';

/**
 * Safer page automation helpers: text clicks with dialog scoping,
 * SPA waits/retries, Material table row pick.
 */
const { evaluateJson, resolveTarget, click, waitForText, waitForNavigation } = require('./page-actions');

const DANGEROUS_LABEL =
  /^(create new release|create a new release|discard draft release|discard draft|delete|unregister|deregister|halt rollout|pause track|pause test|remove changes|send changes for review)$/i;

function normalizeLabel(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function compileMatcher(text, { exact = false, regex = false } = {}) {
  if (text instanceof RegExp) return text;
  const raw = String(text || '');
  if (regex) return new RegExp(raw, 'i');
  if (exact) {
    const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${esc}$`, 'i');
  }
  // Prefer whole-phrase match; avoid matching tiny substrings inside longer nav labels
  const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(esc, 'i');
}

/**
 * Find clickable elements by visible label, preferring open dialogs.
 */
async function findByText(wc, opts = {}) {
  const {
    text,
    exact = false,
    regex = false,
    scope = 'auto', // auto | dialog | page
    match = 'last', // first | last
    role = null, // button | link | menuitem | null
  } = opts;
  if (!text && text !== 0) {
    throw Object.assign(new Error('text required'), { code: 'BAD_REQUEST' });
  }
  const reSource = compileMatcher(text, { exact, regex }).toString();

  return evaluateJson(
    wc,
    `(() => {
      const re = ${reSource};
      const scopeMode = ${JSON.stringify(scope)};
      const matchMode = ${JSON.stringify(match)};
      const roleWant = ${JSON.stringify(role)};

      function labelOf(el) {
        return ((el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '') + '')
          .replace(/\\s+/g, ' ')
          .trim();
      }
      function visible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        const st = window.getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
        return true;
      }
      function roleOf(el) {
        const tag = (el.tagName || '').toLowerCase();
        const r = (el.getAttribute('role') || '').toLowerCase();
        if (r) return r;
        if (tag === 'button' || (tag === 'input' && /button|submit|reset/i.test(el.type || ''))) return 'button';
        if (tag === 'a') return 'link';
        return tag;
      }
      function inDialog(el) {
        return !!(
          el.closest('[role=dialog]') ||
          el.closest('mat-dialog-container') ||
          el.closest('.mat-mdc-dialog-container') ||
          el.closest('[aria-modal=true]') ||
          el.closest('.cdk-overlay-pane') ||
          el.closest('.fxs-blade') ||
          el.closest('.msportalfx-docking') ||
          el.closest('[class*="overlay"][class*="pane"]')
        );
      }

      const sel = 'button,a,[role=button],[role=menuitem],[role=link],input[type=button],input[type=submit],material-button,.mdc-button';
      const all = [...document.querySelectorAll(sel)].filter(visible);
      let candidates = all.filter((el) => re.test(labelOf(el)));
      if (roleWant) {
        candidates = candidates.filter((el) => roleOf(el) === roleWant || (roleWant === 'button' && roleOf(el) === 'button'));
      }

      const dialogHits = candidates.filter(inDialog);
      let pool = candidates;
      if (scopeMode === 'dialog') pool = dialogHits;
      else if (scopeMode === 'page') pool = candidates.filter((el) => !inDialog(el));
      else if (dialogHits.length) pool = dialogHits; // auto: prefer dialog

      if (!pool.length) {
        return {
          ok: false,
          count: 0,
          sample: candidates.slice(0, 8).map((el) => ({ text: labelOf(el).slice(0, 100), dialog: inDialog(el), role: roleOf(el) })),
        };
      }

      const el = matchMode === 'first' ? pool[0] : pool[pool.length - 1];
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return {
        ok: true,
        count: pool.length,
        text: labelOf(el).slice(0, 160),
        role: roleOf(el),
        dialog: inDialog(el),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        dangerous: ${DANGEROUS_LABEL.toString()}.test(labelOf(el)),
      };
    })()`
  );
}

async function clickByText(wc, opts = {}) {
  const found = await findByText(wc, opts);
  if (!found || !found.ok) {
    const err = new Error(`No clickable match for text: ${opts.text}`);
    err.code = 'NOT_FOUND';
    err.sample = found?.sample;
    throw err;
  }
  if (found.dangerous && !opts.confirmDangerous) {
    const err = new Error(
      `Refusing dangerous control "${found.text}" without confirmDangerous:true (Create release / Delete / Halt / etc.)`
    );
    err.code = 'DANGEROUS_CLICK';
    err.found = found;
    throw err;
  }
  const out = await click(wc, { x: found.x, y: found.y });
  return { ...out, ...found, action: 'clickByText' };
}

async function waitForStable(wc, opts = {}) {
  const {
    timeoutMs = 20000,
    quietMs = 600,
    mustInclude = null,
    mustNotInclude = ['An unexpected error has occurred'],
    loadingGone = true,
  } = opts;
  const start = Date.now();
  let lastText = '';
  let stableSince = Date.now();

  while (Date.now() - start < timeoutMs) {
    const snap = await evaluateJson(
      wc,
      `(() => {
        const text = (document.body && document.body.innerText || '');
        return {
          url: location.href,
          title: document.title,
          text: text.slice(0, 8000),
          loading: /Loading Google Play Console|^Loading\\b/m.test(text.slice(0, 200)) && text.length < 1200,
        };
      })()`
    );

    for (const bad of mustNotInclude || []) {
      if (bad && snap.text.includes(bad)) {
        const err = new Error(`Page error detected: ${bad}`);
        err.code = 'PAGE_ERROR';
        err.page = { url: snap.url, title: snap.title, snippet: snap.text.slice(0, 500) };
        throw err;
      }
    }

    if (mustInclude) {
      const ok =
        mustInclude instanceof RegExp
          ? mustInclude.test(snap.text)
          : snap.text.includes(String(mustInclude));
      if (!ok) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
    }

    if (loadingGone && snap.loading) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }

    if (snap.text === lastText) {
      if (Date.now() - stableSince >= quietMs) {
        return {
          ok: true,
          waitedMs: Date.now() - start,
          url: snap.url,
          title: snap.title,
          text: snap.text.slice(0, 2000),
        };
      }
    } else {
      lastText = snap.text;
      stableSince = Date.now();
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Object.assign(new Error('waitForStable timeout'), { code: 'TIMEOUT' });
}

async function navigateRetry(wc, url, opts = {}) {
  const {
    retries = 3,
    timeoutMs = 25000,
    mustInclude = null,
    mustNotInclude = ['An unexpected error has occurred'],
    waitUntil = 'domcontentloaded',
  } = opts;
  let lastErr = null;
  for (let i = 0; i < Math.max(1, retries); i++) {
    try {
      await wc.loadURL(url);
      await waitForNavigation(wc, { timeoutMs: Math.min(15000, timeoutMs), waitUntil }).catch(() => {});
      const stable = await waitForStable(wc, {
        timeoutMs,
        mustInclude,
        mustNotInclude,
      });
      return { ok: true, attempt: i + 1, ...stable };
    } catch (err) {
      lastErr = err;
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 800 + i * 400));
    }
  }
  throw lastErr || Object.assign(new Error('navigateRetry failed'), { code: 'NAV_FAILED' });
}

/**
 * Select a Material / HTML table row that contains given text, then click its checkbox (or the row).
 */
async function pickTableRow(wc, opts = {}) {
  const { contains, click = 'checkbox' } = opts; // checkbox | row
  if (!contains) throw Object.assign(new Error('contains required'), { code: 'BAD_REQUEST' });
  const needle = String(contains).toLowerCase();

  const found = await evaluateJson(
    wc,
    `(() => {
      const needle = ${JSON.stringify(needle)};
      const roots = [
        ...document.querySelectorAll('[role=dialog], mat-dialog-container, .mat-mdc-dialog-container, [aria-modal=true], .cdk-overlay-pane, .fxs-blade'),
        document.body,
      ];
      for (const root of roots) {
        if (!root) continue;
        const rows = [...root.querySelectorAll('tr, [role=row], mat-row')];
        const row = rows.find((r) => ((r.innerText || '').toLowerCase()).includes(needle));
        if (!row) continue;
        const cb =
          row.querySelector('input[type=checkbox]') ||
          row.querySelector('mat-checkbox input') ||
          row.querySelector('[role=checkbox]') ||
          row.querySelector('mat-checkbox, .mdc-checkbox');
        const target = ${JSON.stringify(click)} === 'row' || !cb ? row : cb;
        target.scrollIntoView({ block: 'center' });
        const r = target.getBoundingClientRect();
        return {
          ok: true,
          text: (row.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
          via: target === row ? 'row' : 'checkbox',
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
        };
      }
      return { ok: false };
    })()`
  );

  if (!found || !found.ok) {
    throw Object.assign(new Error(`Table row not found containing: ${contains}`), { code: 'NOT_FOUND' });
  }
  const out = await click(wc, { x: found.x, y: found.y });
  if (found.via === 'checkbox') {
    await evaluateJson(
      wc,
      `(() => {
        const needle = ${JSON.stringify(needle)};
        const row = [...document.querySelectorAll('tr, [role=row], mat-row')].find((r) =>
          ((r.innerText || '').toLowerCase()).includes(needle)
        );
        if (!row) return false;
        const input = row.querySelector('input[type=checkbox]');
        if (input && !input.checked) {
          input.click();
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const mat = row.querySelector('mat-checkbox');
        if (mat && !row.querySelector('input[type=checkbox]:checked')) mat.click();
        return true;
      })()`
    );
  }
  return { ...out, ...found, action: 'pickTableRow' };
}

/** Discover best file input for uploads (prefer accept matching extension). */
async function findBestFileInput(wc, { preferExt = null } = {}) {
  return evaluateJson(
    wc,
    `(() => {
      const prefer = ${JSON.stringify(preferExt || '')}.toLowerCase();
      const preferBare = prefer.replace(/^\\./, '');
      const inputs = [...document.querySelectorAll('input[type=file]')].map((el, i) => {
        const r = el.getBoundingClientRect();
        const accept = (el.accept || '').toLowerCase();
        const name = (el.name || '').toLowerCase();
        const id = (el.id || '').toLowerCase();
        let score = 1;
        if (preferBare && accept.includes(preferBare)) score += 12;
        if (prefer && accept.includes(prefer)) score += 10;
        if (accept.includes('aab') || accept.includes('apk')) score += 5;
        if (accept.includes('image') && (preferBare === 'png' || preferBare === 'jpg' || preferBare === 'jpeg' || preferBare === 'webp')) {
          score += 8;
        }
        if (r.width > 0 || r.height > 0) score += 2;
        if (name.includes('upload') || id.includes('upload') || name.includes('file')) score += 1;
        if (el.disabled) score -= 20;
        // Hidden inputs still usable via CDP setFileInputFiles
        return {
          index: i,
          accept,
          id: el.id || '',
          name: el.name || '',
          multiple: !!el.multiple,
          score,
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
        };
      });
      inputs.sort((a, b) => b.score - a.score || a.index - b.index);
      if (!inputs.length) return null;
      const best = inputs[0];
      // Prefer CSS id when unique; always return useIndex so multi-input pages stay correct
      let selector = 'input[type=file]';
      if (best.id) {
        try {
          const escaped = (window.CSS && CSS.escape) ? CSS.escape(best.id) : best.id.replace(/[^a-zA-Z0-9_-]/g, '');
          if (escaped && document.querySelectorAll('input[type=file]#' + escaped).length === 1) {
            selector = 'input[type=file]#' + escaped;
          }
        } catch (_) { /* keep generic selector + useIndex */ }
      }
      return {
        ...best,
        selector,
        useIndex: best.index,
        count: inputs.length,
      };
    })()`
  );
}

module.exports = {
  DANGEROUS_LABEL,
  findByText,
  clickByText,
  waitForStable,
  navigateRetry,
  pickTableRow,
  findBestFileInput,
  waitForText,
  normalizeLabel,
};
