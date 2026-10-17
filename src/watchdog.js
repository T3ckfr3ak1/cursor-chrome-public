'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Watchdog: if agent API dies, relaunch Cursor-Chrome minimized.
 * Runs as a detached Node side process (never Electron.exe — that opens windows).
 */
function writeHeartbeat(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), pid: process.pid }), 'utf8');
  } catch {
    /* ignore */
  }
}

function startHeartbeat(file, everyMs = 5000) {
  writeHeartbeat(file);
  return setInterval(() => writeHeartbeat(file), everyMs);
}

function resolveNodeBinary() {
  if (process.env.npm_node_execpath && fs.existsSync(process.env.npm_node_execpath)) {
    return process.env.npm_node_execpath;
  }
  // Prefer PATH "node" over Electron's process.execPath (which is electron.exe).
  return 'node';
}

function spawnWatchdog({ appRoot, heartbeatFile, apiPort = 9222, relaunch }) {
  const script = path.join(appRoot, 'scripts', 'watchdog.js');
  if (!fs.existsSync(script)) return null;
  const packaged = !!relaunch && relaunch.packaged;
  const bin = packaged ? process.execPath : resolveNodeBinary();
  const env = { ...process.env };
  if (packaged) env.ELECTRON_RUN_AS_NODE = '1';
  const relaunchExe = relaunch && relaunch.exe ? relaunch.exe : '';
  const relaunchArgs = JSON.stringify((relaunch && relaunch.args) || ['--minimized']);
  const child = spawn(
    bin,
    [script, String(apiPort), heartbeatFile, appRoot, relaunchExe, relaunchArgs],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
      env,
    }
  );
  child.unref();
  return child.pid;
}

module.exports = { writeHeartbeat, startHeartbeat, spawnWatchdog, resolveNodeBinary };
