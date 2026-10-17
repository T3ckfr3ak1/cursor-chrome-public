/**
 * Popup ownership smoke: window.open becomes a child tab of the opener thread.
 * Run: node examples/popup-smoke.js
 */
'use strict';

const { CursorChrome } = require('../src/client');

async function main() {
  const a = new CursorChrome();
  const b = new CursorChrome();
  const ta = `popup-smoke-a-${Date.now()}`;
  const tb = `popup-smoke-b-${Date.now()}`;

  const claimA = await a.claim(ta, { url: 'https://example.com/#a' });
  const claimB = await b.claim(tb, { url: 'https://example.com/#b' });

  await a.evaluate(
    claimA.tab.id,
    `(() => {
      const btn = document.createElement('button');
      btn.id = 'o';
      btn.textContent = 'open';
      btn.onclick = () => window.open('https://example.com/#popup-a', 'p', 'width=400,height=300');
      document.body.appendChild(btn);
      return true;
    })()`
  );
  await a.click(claimA.tab.id, { selector: '#o' });
  const child = await a.waitForPopup(claimA.tab.id, { timeoutMs: 10000 });
  console.log('popup', {
    id: child.id.slice(0, 8),
    threadId: child.threadId,
    parent: child.parentTabId.slice(0, 8),
  });
  if (child.threadId !== ta) throw new Error('popup threadId mismatch');
  if (child.parentTabId !== claimA.tab.id) throw new Error('popup parent mismatch');

  // Thread B must not drive A's popup
  let blocked = false;
  try {
    await b.evaluate(child.id, '1+1');
  } catch (err) {
    blocked = err.code === 'THREAD_MISMATCH' || /belongs to thread/i.test(err.message);
    console.log('B blocked from A popup:', blocked, err.code || err.message);
  }
  if (!blocked) throw new Error('expected THREAD_MISMATCH when B drives A popup');

  const resolved = await a.resolveOverlay(claimA.tab.id);
  if (!resolved.switched || resolved.target.id !== child.id) {
    throw new Error('resolveOverlay should point at popup');
  }

  await a.close(claimA.tab.id);
  await b.close(claimB.tab.id);
  console.log('PASS popup ownership smoke');
}

main().catch((err) => {
  console.error('FAIL', err.code || '', err.message || err);
  process.exit(1);
});
