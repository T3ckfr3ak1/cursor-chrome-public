'use strict';

/**
 * Regression: inactive BrowserViews must not cover the active viewport;
 * guide open/close must reflow.
 * Run: node scripts/test-park-layout.js  (Cursor-Chrome must be up)
 */
const { CursorChrome } = require('../src/client');

async function focus(tabId) {
  const res = await fetch(`http://127.0.0.1:9222/tabs/${tabId}/focus`, { method: 'POST' });
  if (!res.ok) throw new Error(`focus failed ${res.status}`);
  return res.json();
}

(async () => {
  const chrome = new CursorChrome();
  const health = await chrome.health();
  if (!health?.ok) throw new Error('Cursor-Chrome not running');

  const a = await chrome.claim('park-test-a', { url: 'about:blank' });
  const b = await chrome.claim('park-test-b', { url: 'about:blank' });

  await focus(b.tab.id);
  await focus(a.tab.id);
  await chrome.front({ tabId: a.tab.id });

  const status = await chrome.status();
  if (status.pool?.activeTabId !== a.tab.id) {
    throw new Error(`Expected active ${a.tab.id}, got ${status.pool?.activeTabId}`);
  }

  await chrome.guide({ title: 'Park test', steps: ['ok'], body: 'layout check' });
  const g1 = await chrome.getGuide();
  if (!g1.open) throw new Error('guide should be open');

  await chrome.guideBlock({
    code: 'test',
    message: 'Blocked banner check',
    detail: 'detail line',
  });
  const g2 = await chrome.getGuide();
  if (!g2.blocked?.message) throw new Error('blocked missing');

  await chrome.guideClear();
  const g3 = await chrome.getGuide();
  if (g3.open) throw new Error('guide should clear');

  // Dangerous click must refuse without confirm
  await chrome.navigate(a.tab.id, 'data:text/html,<button>Create new release</button>');
  await new Promise((r) => setTimeout(r, 400));
  let refused = false;
  try {
    await chrome.clickText(a.tab.id, { text: 'Create new release', exact: true });
  } catch (e) {
    refused = /dangerous|DANGEROUS/i.test(String(e.message || e));
  }
  if (!refused) throw new Error('expected DANGEROUS_CLICK refusal');

  console.log(
    JSON.stringify({
      ok: true,
      version: health.version,
      activeTabId: a.tab.id,
      checks: ['park-focus', 'guide-layout', 'guide-block', 'dangerous-click-guard'],
    })
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
