'use strict';

/**
 * Install / remove Cursor-Chrome start-at-login.
 * Windows: Startup folder batch file.
 * Linux: XDG autostart desktop entry (Cinnamon, MATE, GNOME).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const appRoot = path.join(__dirname, '..');
const action = process.argv[2] || 'install';

function windowsStartupTarget() {
  return path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'Cursor-Chrome-Agent.bat'
  );
}

function linuxAutostartTarget() {
  return path.join(os.homedir(), '.config', 'autostart', 'cursor-chrome.desktop');
}

function firstExisting(candidates) {
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function windowsLaunchLine() {
  const installed = firstExisting([
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Cursor-Chrome', 'Cursor-Chrome.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Cursor-Chrome', 'Cursor-Chrome.exe'),
  ]);
  if (installed) return `start "" "${installed}" --minimized`;
  const electronExe = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(electronExe)) return `start "" "${electronExe}" "${appRoot}" --minimized`;
  return 'start "" /B npx --yes electron . --minimized';
}

function linuxExec() {
  const installed = firstExisting([
    '/opt/Cursor-Chrome/cursor-chrome',
    '/usr/bin/cursor-chrome',
    path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron'),
  ]);
  if (!installed) return `bash -lc 'cd "${appRoot}" && npx electron . --minimized'`;
  if (installed.endsWith(`${path.sep}electron`) || installed.endsWith('/electron')) {
    return `"${installed}" "${appRoot}" --minimized`;
  }
  return `"${installed}" --minimized`;
}

if (process.platform === 'win32') {
  const target = windowsStartupTarget();
  if (action === 'uninstall') {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    console.log('Removed startup entry:', target);
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const body = `@echo off\r\ncd /d "${appRoot}"\r\n${windowsLaunchLine()}\r\n`;
  fs.writeFileSync(target, body, 'utf8');
  console.log('Installed startup entry:', target);
  console.log('Cursor-Chrome will launch minimized at Windows login.');
  process.exit(0);
}

if (process.platform === 'linux') {
  const target = linuxAutostartTarget();
  if (action === 'uninstall') {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    console.log('Removed autostart entry:', target);
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const body = `[Desktop Entry]
Type=Application
Version=1.0
Name=Cursor-Chrome
Comment=Agent browser for Cursor
Exec=${linuxExec()}
Terminal=false
Categories=Network;
X-GNOME-Autostart-enabled=true
`;
  fs.writeFileSync(target, body, 'utf8');
  console.log('Installed autostart entry:', target);
  console.log('Cursor-Chrome will launch minimized at desktop login.');
  process.exit(0);
}

console.error(`startup install is not implemented for ${process.platform}`);
process.exit(1);
