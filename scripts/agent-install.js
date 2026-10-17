'use strict';

/**
 * Full automatic install for Cursor agents (and humans).
 *
 * Run from a clone of https://github.com/T3ckfr3ak1/cursor-chrome-public
 *
 *   node scripts/agent-install.js
 *   npm run install:agent
 *
 * Flags:
 *   --no-start       skip launching Cursor-Chrome
 *   --no-startup     skip Windows login autostart
 *   --no-skill       skip copying skill into ~/.cursor/skills
 *   --visible        start visible (default: minimized)
 *   --json           machine-readable summary on stdout
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, spawnSync, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = new Set(process.argv.slice(2));
const wantJson = args.has('--json');
const noStart = args.has('--no-start');
const noStartup = args.has('--no-startup');
const noSkill = args.has('--no-skill');
const visible = args.has('--visible');

const result = {
  ok: false,
  root: ROOT,
  platform: process.platform,
  steps: [],
  health: null,
  skillPath: null,
  clientPath: path.join(ROOT, 'src', 'client.js'),
  apiUrl: 'http://127.0.0.1:9222',
  errors: [],
};

function log(msg) {
  if (!wantJson) console.log(msg);
}

function step(name, ok, detail) {
  result.steps.push({ name, ok, detail: detail || null });
  log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function run(cmd, opts = {}) {
  const r = spawnSync(cmd, {
    cwd: opts.cwd || ROOT,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
    stdio: wantJson ? 'pipe' : 'inherit',
  });
  if (r.status !== 0 && !opts.allowFail) {
    const err = (r.stderr || r.stdout || `exit ${r.status}`).toString().trim().slice(0, 500);
    throw new Error(err || `${cmd} failed`);
  }
  return r;
}

function which(bin) {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      encoding: 'utf8',
      shell: true,
    });
    return r.status === 0 ? (r.stdout || '').split(/\r?\n/)[0].trim() : null;
  } catch {
    return null;
  }
}

function healthCheck(timeoutMs = 12000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get('http://127.0.0.1:9222/health', { timeout: 1500 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            if (j && j.ok) return resolve(j);
          } catch {
            /* retry */
          }
          if (Date.now() - started > timeoutMs) return resolve(null);
          setTimeout(tryOnce, 400);
        });
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) return resolve(null);
        setTimeout(tryOnce, 400);
      });
      req.on('timeout', () => {
        req.destroy();
        if (Date.now() - started > timeoutMs) return resolve(null);
        setTimeout(tryOnce, 400);
      });
    };
    tryOnce();
  });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function installSkill() {
  const skillSrc = path.join(ROOT, '.cursor', 'skills', 'cursor-chrome');
  const skillAlt = path.join(ROOT, 'docs'); // protocol still useful
  const dest = path.join(os.homedir(), '.cursor', 'skills', 'cursor-chrome');
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (fs.existsSync(skillSrc)) {
    copyDir(skillSrc, dest);
    // Ensure protocol is present even if skill folder is thin
    const protoSrc = path.join(ROOT, 'docs', 'THREAD-PROTOCOL.md');
    if (fs.existsSync(protoSrc)) {
      fs.copyFileSync(protoSrc, path.join(dest, 'THREAD-PROTOCOL.md'));
    }
    const skillMd = path.join(ROOT, '.cursor', 'skills', 'cursor-chrome', 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      fs.copyFileSync(skillMd, path.join(dest, 'SKILL.md'));
    }
  } else {
    // Build a minimal skill from docs for public clone that only ships docs/
    fs.mkdirSync(dest, { recursive: true });
    const skillBody = `---
name: cursor-chrome
description: >-
  Drive Cursor-Chrome local agent browser (API :9222, CDP :9223). Prefer when user
  says cursor chrome / cursor-chrome or needs minimized multi-tab agent browsing.
---

# Cursor-Chrome

Install root: ${ROOT.replace(/\\/g, '/')}

Client: \`${path.join(ROOT, 'src', 'client.js').replace(/\\/g, '/')}\`

Health: GET http://127.0.0.1:9222/health

Full protocol: read THREAD-PROTOCOL.md in this folder (synced from repo docs).
`;
    fs.writeFileSync(path.join(dest, 'SKILL.md'), skillBody, 'utf8');
    const proto = path.join(ROOT, 'docs', 'THREAD-PROTOCOL.md');
    if (fs.existsSync(proto)) {
      fs.copyFileSync(proto, path.join(dest, 'THREAD-PROTOCOL.md'));
    }
  }
  if (fs.existsSync(skillAlt)) {
    /* docs already copied when present */
  }
  result.skillPath = dest;
  return dest;
}

function launchApp() {
  const electronExe =
    process.platform === 'win32'
      ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
      : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');

  const modeFlag = visible ? [] : ['--minimized'];
  if (fs.existsSync(electronExe)) {
    const child = spawn(electronExe, [ROOT, ...modeFlag], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return 'electron-dist';
  }
  // Fallback npm start detached
  const child = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', visible ? 'start' : 'start:minimized'],
    {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      shell: true,
      windowsHide: true,
    }
  );
  child.unref();
  return 'npm-start';
}

async function main() {
  log('=== Cursor-Chrome agent install ===');
  log(`Root: ${ROOT}`);

  // Prerequisites
  const nodeV = process.versions.node;
  step('node', true, `v${nodeV}`);
  if (Number(nodeV.split('.')[0]) < 18) {
    result.errors.push('Node.js 18+ required');
    step('node-version', false, 'need Node 18+');
    return fail();
  }

  if (!which('npm')) {
    result.errors.push('npm not found on PATH');
    step('npm', false, 'not found');
    return fail();
  }
  step('npm', true, which('npm'));

  // Dependencies
  try {
    if (!fs.existsSync(path.join(ROOT, 'node_modules', 'electron'))) {
      log('Installing npm dependencies (this can take a few minutes)…');
      run('npm install');
    } else {
      log('node_modules present — running npm install to ensure lock is satisfied…');
      run('npm install');
    }
    step('npm-install', true);
  } catch (e) {
    result.errors.push(String(e.message || e));
    step('npm-install', false, String(e.message || e));
    return fail();
  }

  // Assets (non-fatal if sharp fails — repo ships prebuilt assets)
  try {
    if (fs.existsSync(path.join(ROOT, 'scripts', 'generate-logo.js'))) {
      run('node scripts/generate-logo.js', { allowFail: true });
    }
    step('assets', true, 'generated or already present');
  } catch (e) {
    step('assets', true, 'skipped');
  }

  // Skill + protocol for every Cursor thread
  if (!noSkill) {
    try {
      // Prefer full docs:sync when available
      if (fs.existsSync(path.join(ROOT, 'scripts', 'sync-agent-docs.js'))) {
        try {
          run('node scripts/sync-agent-docs.js');
        } catch {
          installSkill();
        }
      } else {
        installSkill();
      }
      // Always ensure skill ends up in ~/.cursor/skills
      if (!result.skillPath) installSkill();
      step('skill', true, result.skillPath || path.join(os.homedir(), '.cursor', 'skills', 'cursor-chrome'));
    } catch (e) {
      result.errors.push(String(e.message || e));
      step('skill', false, String(e.message || e));
    }
  }

  // Windows autostart (optional)
  if (!noStartup && process.platform === 'win32') {
    try {
      run('node scripts/install-startup.js install');
      step('startup', true, 'Windows login minimized launch');
    } catch (e) {
      step('startup', false, String(e.message || e));
    }
  } else {
    step('startup', true, noStartup ? 'skipped' : 'non-windows');
  }

  // Private monorepo: auto-install git hooks for remote maintain
  if (fs.existsSync(path.join(ROOT, 'scripts', 'install-git-hooks.js'))) {
    try {
      run('node scripts/install-git-hooks.js', { allowFail: true });
      step('git-hooks', true, 'post-commit maintain remotes');
    } catch {
      step('git-hooks', true, 'skipped');
    }
  }

  // Launch + health
  if (!noStart) {
    try {
      const existing = await healthCheck(1500);
      if (existing && existing.ok) {
        result.health = existing;
        step('launch', true, 'already running');
      } else {
        const how = launchApp();
        step('launch', true, how);
        result.health = await healthCheck(20000);
        if (!result.health) {
          step('health', false, 'API did not come up on :9222 within 20s');
          result.errors.push('health timeout — try start-minimized.bat manually');
        } else {
          step('health', true, `v${result.health.version || '?'}`);
        }
      }
    } catch (e) {
      step('launch', false, String(e.message || e));
      result.errors.push(String(e.message || e));
    }
  } else {
    step('launch', true, 'skipped');
  }

  result.ok = result.errors.length === 0 && result.steps.every((s) => s.ok || s.name === 'startup');
  // softer: ok if npm install + skill ok
  const critical = result.steps.filter((s) => ['npm-install', 'node'].includes(s.name));
  result.ok = critical.every((s) => s.ok) && result.errors.filter((e) => !/health timeout/.test(e)).length === 0;

  log('');
  log('=== Install complete ===');
  log(`Client: ${result.clientPath}`);
  log(`API:    ${result.apiUrl}/health`);
  if (result.skillPath) log(`Skill:  ${result.skillPath}`);
  log('');
  log('Cursor agents should:');
  log('  1. GET http://127.0.0.1:9222/health');
  log(`  2. const { CursorChrome } = require(${JSON.stringify(result.clientPath.replace(/\\/g, '/'))})`);
  log('  3. claim a unique threadId and drive the browser');
  log('Full protocol: docs/THREAD-PROTOCOL.md');

  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
  process.exit(result.ok ? 0 : 1);
}

function fail() {
  result.ok = false;
  if (wantJson) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(1);
}

main().catch((e) => {
  result.errors.push(String(e.message || e));
  console.error(e);
  if (wantJson) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(1);
});
