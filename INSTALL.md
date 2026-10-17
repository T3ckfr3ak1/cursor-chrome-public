# Install Cursor-Chrome (for Cursor AI agents)

> **BINDING FOR AGENTS.**  
> User messages like **"install this"**, **"hey install this"**, **"set this up"**,  
> or pasting https://github.com/T3ckfr3ak1/cursor-chrome-public mean:  
> **run the install end-to-end and prove `/health` is ok.**  
> Do not answer with manual steps only. Execute.

Public repo: https://github.com/T3ckfr3ak1/cursor-chrome-public

---

## Goal

Leave a **running, full-featured Cursor-Chrome** on the machine:

| Deliverable | Where |
|-------------|--------|
| App dependencies | `node_modules/` (esp. electron) |
| Agent API up | `GET http://127.0.0.1:9222/health` → `"ok": true` |
| Cursor skill | `~/.cursor/skills/cursor-chrome/` |
| Node client | `src/client.js` (report absolute path) |

---

## Path A — Repo already open in Cursor

Working directory = clone root (`package.json` + `src/main.js` present).

**Run one command (prefer this):**

```bash
npm run install:agent
```

Equivalents:

```bash
node scripts/agent-install.js
```

Windows:

```bat
scripts\install.bat
```

### What that command does

1. Checks Node **18+** and npm on PATH  
2. `npm install`  
3. Refreshes logo assets when the generator exists  
4. Syncs skill → `~/.cursor/skills/cursor-chrome/`  
5. (Windows) optional login autostart  
6. Starts the app **minimized** (unless already healthy)  
7. Probes `GET http://127.0.0.1:9222/health`

### Prove it

```bash
curl -s http://127.0.0.1:9222/health
```

Or Node:

```js
const r = await fetch('http://127.0.0.1:9222/health');
console.log(await r.json());
```

Then tell the user (example):

```text
Cursor-Chrome is installed and running.
Health: ok, version X.Y.Z
Client: C:\Users\…\cursor-chrome\src\client.js
API: http://127.0.0.1:9222
```

---

## Path B — User only dropped the GitHub URL

Nothing is cloned into the current workspace yet.

### Windows (preferred one-liner)

```powershell
irm https://raw.githubusercontent.com/T3ckfr3ak1/cursor-chrome-public/main/scripts/remote-bootstrap.ps1 | iex
```

This:

1. Clones into `%USERPROFILE%\cursor-chrome` (override: `$env:CURSOR_CHROME_HOME`)  
2. Runs `scripts/agent-install.js`  
3. Leaves API on :9222  

### git + node (any OS)

```bash
git clone https://github.com/T3ckfr3ak1/cursor-chrome-public.git "$HOME/cursor-chrome"
cd "$HOME/cursor-chrome"
npm run install:agent
```

After Path B, suggest opening `$HOME/cursor-chrome` (or the Windows path) as the Cursor workspace for later automation.

---

## Path C — Upgrade / reinstall existing install

```bash
cd "<existing-install-root>"
git pull   # if it is a git clone
npm run install:agent
```

---

## install:agent flags

| Flag | Meaning |
|------|---------|
| `--no-start` | deps + skill only; don't launch |
| `--no-startup` | skip Windows login autostart |
| `--no-skill` | skip ~/.cursor/skills copy |
| `--visible` | start window visible (not minimized) |
| `--json` | machine-readable result |

```bash
node scripts/agent-install.js --json
```

---

## Requirements

- **Node.js 18+** and **npm** on PATH  
- **Git** for Path B  
- Free localhost ports **9222** (API) and **9223** (CDP)  
- **Windows 10/11** is primary; Electron also builds on macOS/Linux  

Never expose 9222/9223 on a network interface. See [SECURITY.md](SECURITY.md).

---

## Failures — fix and continue (do not abandon)

| Symptom | Agent action |
|---------|----------------|
| `node` / `npm` missing | Tell user to install Node 18 LTS from nodejs.org; re-run install after |
| `npm install` / electron download fails | Retry once; check disk space + network; re-run `npm install` |
| Health timeout | `npm run start:minimized` or `start-minimized.bat`, wait 10s, recheck `/health` |
| Port already in use / already ok | Use existing instance if `/health` is already ok |
| PowerShell `irm` blocked | Fall back to `git clone` + Path A |
| Antivirus quarantines electron | User may need allowlist; still re-try start after |

Do **not** build an NSIS installer (`npm run dist`) unless the user explicitly wants a desktop `.exe` package.

---

## After install — drive pages

1. Read [docs/THREAD-PROTOCOL.md](docs/THREAD-PROTOCOL.md)  
2. Use client:

```js
const { CursorChrome } = require('<ABS_INSTALL_ROOT>/src/client.js');
const chrome = new CursorChrome();
const { tab } = await chrome.claim('unique-thread-id', { url: 'https://example.com' });
```

3. Prefer live frames: `GET /tabs/:id/frame.jpg` via client helpers  
4. Logins / 2FA → `chrome.handoff(tab.id, { wait: true })`  

---

## Related files agents should know

| File | Why |
|------|-----|
| `AGENTS.md` | Short binding entry (this install + drive) |
| `.cursorrules` | Always-on Cursor rules dump of the same policy |
| `.cursor/rules/install-cursor-chrome.mdc` | alwaysApply rule in-repo |
| `scripts/agent-install.js` | Implementation of install:agent |
| `scripts/remote-bootstrap.ps1` | URL → full install (Windows) |
| `docs/THREAD-PROTOCOL.md` | Driving the browser after install |
