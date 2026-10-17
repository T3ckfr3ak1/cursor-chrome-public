'use strict';

/**
 * External watchdog process — relaunch Cursor-Chrome if API is down.
 * Usage: node scripts/watchdog.js <apiPort> <heartbeatFile> <appRoot>
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const apiPort = Number(process.argv[2] || 9222);
const heartbeatFile = process.argv[3];
const appRoot = process.argv[4] || path.join(__dirname, '..');

function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: apiPort, path: '/health', timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function relaunch() {
  const exe = process.argv[5];
  let args = ['--minimized'];
  if (process.argv[6]) {
    try {
      const parsed = JSON.parse(process.argv[6]);
      if (Array.isArray(parsed) && parsed.length) args = parsed;
    } catch {
      /* keep default */
    }
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (exe && fs.existsSync(exe)) {
    spawn(exe, args, {
      cwd: appRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    }).unref();
    return;
  }
  const electronName = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const electronBin = path.join(appRoot, 'node_modules', 'electron', 'dist', electronName);
  if (fs.existsSync(electronBin)) {
    spawn(electronBin, [appRoot, '--minimized'], {
      cwd: appRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    }).unref();
    return;
  }
  if (process.platform === 'win32') {
    spawn(
      process.env.ComSpec || 'cmd.exe',
      ['/c', 'start', '', '/B', 'npx', '--yes', 'electron', '.', '--minimized'],
      { cwd: appRoot, detached: true, stdio: 'ignore', windowsHide: true }
    ).unref();
  }
}

async function loop() {
  let fails = 0;
  for (;;) {
    const ok = await checkHealth();
    if (ok) {
      fails = 0;
    } else {
      fails += 1;
      if (fails >= 3) {
        relaunch();
        fails = 0;
        await new Promise((r) => setTimeout(r, 15000));
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

loop();
