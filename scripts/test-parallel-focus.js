'use strict';

/**
 * Regression: human-visible tab switch must not break other threads' automation.
 * Run: node scripts/test-parallel-focus.js  (Cursor-Chrome must be up)
 */
const { CursorChrome } = require('../src/client');

async function focusTab(tabId) {
  const res = await fetch(`http://127.0.0.1:9222/tabs/${tabId}/focus`, { method: 'POST' });
  if (!res.ok) throw new Error(`focus failed ${res.status}`);
  return res.json();
}

(async () => {
  const healthChrome = new CursorChrome();
  const health = await healthChrome.health();
  if (!health?.ok) throw new Error('Cursor-Chrome not running');

  const threadA = `parallel-a-${Date.now()}`;
  const threadB = `parallel-b-${Date.now()}`;
  const markerA = `marker-a-${Math.random().toString(36).slice(2, 8)}`;
  const markerB = `marker-b-${Math.random().toString(36).slice(2, 8)}`;

  const chromeA = new CursorChrome();
  const chromeB = new CursorChrome();
  const a = await chromeA.claim(threadA, {
    url: `data:text/html,<h1 id="t">${markerA}</h1><script>window.__n=0;setInterval(()=>{window.__n++;document.title='n='+window.__n},200)</script>`,
  });
  const b = await chromeB.claim(threadB, {
    url: `data:text/html,<h1 id="t">${markerB}</h1>`,
  });

  await new Promise((r) => setTimeout(r, 600));

  // Human switches to tab B (visual only)
  await focusTab(b.tab.id);

  // Tab A must still evaluate and keep its timer running
  const textA = await chromeA.evaluate(a.tab.id, 'document.getElementById("t").textContent');
  const titleA1 = await chromeA.evaluate(a.tab.id, 'document.title');
  await new Promise((r) => setTimeout(r, 500));
  const titleA2 = await chromeA.evaluate(a.tab.id, 'document.title');

  const bodyA =
    textA && typeof textA === 'object' && 'result' in textA ? textA.result : textA;
  const t1 =
    titleA1 && typeof titleA1 === 'object' && 'result' in titleA1 ? titleA1.result : titleA1;
  const t2 =
    titleA2 && typeof titleA2 === 'object' && 'result' in titleA2 ? titleA2.result : titleA2;

  if (!String(bodyA).includes(markerA)) {
    throw new Error(`tab A body lost after focus switch: ${bodyA}`);
  }
  if (t1 === t2) {
    throw new Error(`tab A timer stalled after human focused tab B (${t1} -> ${t2})`);
  }

  // Tab B still works while A is in background
  const textB = await chromeB.evaluate(b.tab.id, 'document.getElementById("t").textContent');
  const bodyB =
    textB && typeof textB === 'object' && 'result' in textB ? textB.result : textB;
  if (!String(bodyB).includes(markerB)) {
    throw new Error(`tab B broken: ${bodyB}`);
  }

  // release() cleanup
  const relA = await chromeA.release(threadA);
  const relB = await chromeB.release(threadB);
  if (!relA.closed || !relB.closed) {
    throw new Error(`release failed a=${relA.closed} b=${relB.closed}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      version: health.version,
      checks: ['parallel-eval', 'background-timer', 'release-cleanup'],
      tabA: a.tab.id.slice(0, 8),
      tabB: b.tab.id.slice(0, 8),
      titleProgress: `${t1} -> ${t2}`,
    })
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
