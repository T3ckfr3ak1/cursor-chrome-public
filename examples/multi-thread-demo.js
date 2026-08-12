/**
 * Example: many Cursor threads each claiming their own Cursor-Chrome tab.
 * Browser stays in background (agents do not steal focus).
 *
 * Run Cursor-Chrome first (start-minimized.bat), then:
 *   node examples/multi-thread-demo.js
 */

const { CursorChrome } = require('../src/client');

async function runThread(n) {
  const chrome = new CursorChrome();
  const threadId = `cursor-thread-${n}`;
  const { tab, reused } = await chrome.claim(threadId, {
    url: `https://example.com/#thread-${n}`,
    title: `Thread ${n}`,
  });
  const title = await chrome.evaluate(tab.id, 'document.title');
  console.log(`[${threadId}] tab=${tab.id.slice(0, 8)} reused=${reused} title=${title}`);
  return tab.id;
}

async function main() {
  const chrome = new CursorChrome();
  const status = await chrome.status();
  console.log('Cursor-Chrome online:', status.apiUrl || status.apiPort, 'pool', status.pool);
  // Do not chrome.front/show/watch — leave window where the human parked it.

  const count = 8;
  const ids = await Promise.all(Array.from({ length: count }, (_, i) => runThread(i + 1)));

  console.log(`Drove ${ids.length} tabs simultaneously in the background.`);
  const after = await chrome.status();
  console.log('Pool:', after.pool);
  console.log('Prefer: node examples/multi-thread-smoke.js for assertion coverage.');
}

main().catch((err) => {
  console.error(err.message || err);
  console.error('Is Cursor-Chrome running? Try start-minimized.bat');
  process.exit(1);
});
