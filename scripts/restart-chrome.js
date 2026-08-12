'use strict';

/**
 * Restart Cursor-Chrome Electron (dev). Kills only processes whose command line
 * includes this repo path, then starts visible or minimized.
 *
 * Usage:
 *   node scripts/restart-chrome.js
 *   node scripts/restart-chrome.js --minimized
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const minimized = process.argv.includes('--minimized');
const hidden = process.argv.includes('--hidden');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function killCursorChrome() {
  if (process.platform !== 'win32') {
    try {
      execSync(`pkill -f "${ROOT.replace(/"/g, '')}" || true`, { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
    return;
  }
  // Match on folder name — nested powershell + full path escaping was flaky and left old instances alive.
  const ps1 = path.join(ROOT, 'scripts', '_kill-cursor-chrome.ps1');
  const script = `
Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match 'Cursor-Chrome') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  fs.writeFileSync(ps1, script, 'utf8');
  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`, { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(ps1);
  } catch {
    /* ignore */
  }
}

function health() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:9222/health', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(null);
    });
  });
}

(async () => {
  console.log('[restart] Stopping Cursor-Chrome…');
  killCursorChrome();
  await sleep(1500);

  const args = [ROOT];
  if (minimized) args.push('--minimized');
  if (hidden) args.push('--hidden');
  if (!minimized && !hidden) args.push('--visible');

  console.log('[restart] Starting', ELECTRON, args.join(' '));
  const child = spawn(ELECTRON, args, {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  for (let i = 0; i < 25; i++) {
    await sleep(400);
    const h = await health();
    if (h && h.ok) {
      console.log(`[restart] Up v${h.version} api=${h.apiUrl}`);
      process.exit(0);
    }
  }
  console.error('[restart] Timed out waiting for /health');
  process.exit(1);
})();
