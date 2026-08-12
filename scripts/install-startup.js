'use strict';

/**
 * Install / remove Cursor-Chrome start-at-login (Windows Startup folder).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const startupDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const shortcutName = 'Cursor-Chrome-Agent.bat';
const target = path.join(startupDir, shortcutName);
const appRoot = path.join(__dirname, '..');

const action = process.argv[2] || 'install';

if (action === 'uninstall') {
  if (fs.existsSync(target)) fs.unlinkSync(target);
  console.log('Removed startup entry:', target);
  process.exit(0);
}

fs.mkdirSync(startupDir, { recursive: true });
const electronExe = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const body = `@echo off\r\ncd /d "${appRoot}"\r\nif exist "${electronExe}" (\r\n  start "" "${electronExe}" "${appRoot}" --minimized\r\n) else (\r\n  start "" /B npx --yes electron . --minimized\r\n)\r\n`;
fs.writeFileSync(target, body, 'utf8');
console.log('Installed startup entry:', target);
console.log('Cursor-Chrome will launch minimized at Windows login.');
