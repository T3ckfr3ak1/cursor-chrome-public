/**
 * Concurrent multi-thread smoke test for Cursor-Chrome.
 * Run with Cursor-Chrome up:
 *   node examples/multi-thread-smoke.js
 */
'use strict';

const { CursorChrome } = require('../src/client');

async function runThread(n) {
  const chrome = new CursorChrome();
  const threadId = `smoke-thread-${n}-${Date.now()}`;
  const marker = `smoke-${n}-${Math.random().toString(36).slice(2, 8)}`;
  const { tab, reused, fromWarm } = await chrome.claim(threadId, {
    url: `https://example.com/#${marker}`,
    title: `Smoke ${n}`,
  });
  const hashRaw = await chrome.evaluate(tab.id, 'location.hash');
  const titleRaw = await chrome.evaluate(tab.id, 'document.title');
  const hash = String(
    hashRaw && typeof hashRaw === 'object' && 'result' in hashRaw ? hashRaw.result : hashRaw || ''
  );
  const title = String(
    titleRaw && typeof titleRaw === 'object' && 'result' in titleRaw ? titleRaw.result : titleRaw || ''
  );
  // Reclaim same thread → must reuse same tab id
  const again = await chrome.claim(threadId);
  if (again.tab.id !== tab.id || !again.reused) {
    throw new Error(`[${threadId}] reclaim failed reused=${again.reused} same=${again.tab.id === tab.id}`);
  }
  return {
    threadId,
    tabId: tab.id,
    reused,
    fromWarm,
    hash,
    title,
    ok: hash.includes(marker) || hash.includes(`smoke-${n}`),
  };
}

async function main() {
  const chrome = new CursorChrome();
  const health = await chrome.health();
  if (!health || health.ok !== true) throw new Error('Cursor-Chrome health failed');
  console.log('health ok; pool', health.pool || (await chrome.status()).pool);
  console.log('focus policy', {
    steal: health.observability && health.observability.agentCanStealFocus,
    aot: health.observability && health.observability.agentCanAlwaysOnTop,
  });

  const N = 6;
  console.log(`Claiming ${N} threads in parallel…`);
  const results = await Promise.all(Array.from({ length: N }, (_, i) => runThread(i + 1)));
  for (const r of results) {
    console.log(
      `  ${r.threadId.slice(0, 28)} tab=${r.tabId.slice(0, 8)} warm=${r.fromWarm} hash=${r.hash} ok=${r.ok}`
    );
    if (!r.ok) throw new Error(`hash mismatch for ${r.threadId}`);
  }

  const ids = new Set(results.map((r) => r.tabId));
  if (ids.size !== N) throw new Error(`expected ${N} unique tabs, got ${ids.size}`);

  // Handoff busy: start one, second different thread must 409
  const a = results[0];
  const b = results[1];
  await chrome.handoff(a.tabId, {
    threadId: a.threadId,
    reason: 'smoke',
    message: '1. Ignore — smoke test handoff\n2. Will be cleared automatically',
    wait: false,
  });
  let busy = false;
  try {
    await chrome.handoff(b.tabId, {
      threadId: b.threadId,
      reason: 'smoke',
      message: 'should fail',
      wait: false,
    });
  } catch (err) {
    busy = err.code === 'HANDOFF_BUSY' || /HANDOFF_BUSY|already active/i.test(err.message);
    console.log('handoff busy ok:', busy, err.code || err.message);
  }
  await chrome.handoffDone('smoke cleanup');
  if (!busy) throw new Error('expected HANDOFF_BUSY for second thread');

  // Guide busy with threadIds
  await chrome.guide({
    title: 'Smoke A',
    threadId: a.threadId,
    tabId: a.tabId,
    steps: ['noop'],
  });
  let guideBusy = false;
  try {
    await chrome.guide({
      title: 'Smoke B',
      threadId: b.threadId,
      tabId: b.tabId,
      steps: ['noop'],
    });
  } catch (err) {
    guideBusy = err.code === 'GUIDE_BUSY' || /GUIDE_BUSY|Guide busy/i.test(err.message);
    console.log('guide busy ok:', guideBusy, err.code || err.message);
  }
  await chrome.guideClear();
  if (!guideBusy) throw new Error('expected GUIDE_BUSY for second thread');

  // Cleanup smoke tabs
  for (const r of results) {
    await chrome.close(r.tabId).catch(() => {});
  }

  const after = await chrome.status();
  console.log('PASS multi-thread smoke. pool', after.pool);
}

main().catch((err) => {
  console.error('FAIL', err.code || '', err.message || err);
  process.exit(1);
});
