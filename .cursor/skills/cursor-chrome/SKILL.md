---
name: cursor-chrome
description: >-
  Install and drive Cursor-Chrome (local agent Chromium). Use when the user says
  "install this", "hey install this", "set this up", pastes
  github.com/T3ckfr3ak1/cursor-chrome-public, or says "use cursor chrome" /
  "cursor-chrome" / agent browser / handoff / Play Console upload.
  Prefer Cursor-Chrome over IDE browser. Install: INSTALL.md + npm run install:agent.
  Drive: THREAD-PROTOCOL.md beside this skill.
  Anti-secrecy: agents cannot hide/minimize (403); humans park via taskbar/tray only.
---

# Cursor-Chrome

## Install first (if user asked to install / drop the GitHub link)

Do **not** explain and stop. Execute:

- Clone open as workspace → `npm run install:agent`
- URL only (Windows) →  
  `irm https://raw.githubusercontent.com/T3ckfr3ak1/cursor-chrome-public/main/scripts/remote-bootstrap.ps1 | iex`
- Prove: `GET http://127.0.0.1:9222/health` → `"ok": true`

Canonical: repo `INSTALL.md` + `AGENTS.md` + `.cursorrules`.

---

**Drive protocol** (same folder): [THREAD-PROTOCOL.md](THREAD-PROTOCOL.md)  
If this skill was installed by `npm run install:agent`, client path is under the install root’s `src/client.js`.

If anything conflicts for browser control, **THREAD-PROTOCOL.md wins**.

---

## Quick start (every thread after install)

1. Health: `GET http://127.0.0.1:9222/health` — if down, run install or `start-minimized.bat` from the install root
2. Claim your tab (stable `threadId`, max 20 global tabs)
3. Drive via client or REST; **do not raise the window** — leave it parked; human watches via taskbar / `/live`
4. **Multi-thread:** unique `threadId` per Cursor chat; drive only your `tab.id`; one handoff at a time; pass `threadId` on `guide()`
5. **Popups:** `window.open` → child tab with same `threadId`. Use `listPopups` / `resolveOverlay`; never drive another thread’s popup. In-page dialogs stay on the same tabId.

```js
// Use absolute path on the user's machine after install (often %USERPROFILE%/cursor-chrome)
const { CursorChrome } = require('REPLACE/src/client.js');
const chrome = new CursorChrome();
const { tab, live } = await chrome.claim('YOUR_THREAD_ID', { url: 'https://example.com' });
await chrome.navigate(tab.id, 'https://…');
const title = await chrome.evaluate(tab.id, 'document.title');
const jpeg = await chrome.liveFrame(tab.id); // realtime paint, not a fresh snapshot
```

---

## Capabilities checklist

| Need | How |
|------|-----|
| Open / navigate | `claim` · `navigate` · warm pool auto |
| Read DOM / run JS | `evaluate` · `snapshot` · `act` |
| Precise input | `click` / `type` / `hover` / `scroll` / `press` / `wait` (+ `iframe`) |
| Smart SPA actions | `clickText` · `pickRow` · `navigateRetry` · `waitStable` |
| See UI (pixels) | `liveFrame` / `GET …/frame.jpg` · co-watch `/live` |
| Login / 2FA / CAPTCHA | `handoff({ wait:true })` · `autoHandoff` · `authCheck` |
| Human instruction rail | `guide({ title, steps, body })` · `guideBlock` · `guideClear` · `guideStep` |
| Upload AAB / files | `dropFiles({ files:[absolutePath], selector })` (folders OK) |
| Bring window forward | **Human only:** taskbar · tray · **Ctrl+Shift+C** · `/live` (agent `front`/`watch` do not steal focus) |
| Minimize without stopping agents | Taskbar minimize (parks; work continues) |
| Speed / warm / metrics | `speedMode` · `warm` · `metrics` · `log` |
| Profiles / session | `claim({ profile })` · `exportSession` / `importSession` |
| Recorder / picker | `recordStart` · `pickerStart` · `playbook` |
| MCP tools | `npm run mcp` → `mcp/server.js` |
| Playwright | CDP `http://127.0.0.1:9223` |
| Remembered logins | Shared persistent profile (default) — cookies survive restarts |

**Logins:** default shared profile `persist:cursor-chrome-profile` in `%LOCALAPPDATA%\Cursor-Chrome`. Hand off once to sign in; later threads reuse the session. Clear only with `chrome.clearSession()` if the user asks.

**Focus / always-on-top:** Agents must **never** yank Cursor-Chrome over other windows. Do not rely on `front` / `watch` / `show` for visibility — they no longer steal OS focus. Handoff only flashes the taskbar + notification. Humans raise the window themselves.

---

## Handoff

```js
await chrome.handoff(tab.id, {
  reason: 'login',
  message: 'Sign in, then click Hand back to Cursor.',
  after: 'minimize',
  wait: true,
  timeoutMs: 900000,
});
```

User UI: toolbar shows green **AI Controlled** while the agent drives; during handoff it becomes **Hand back to Cursor** (also tray / **Ctrl+Shift+H**).  
Default wait is **15 minutes** (server hard-cap **2 hours**). Never type passwords yourself.

---

## Instruction sidebar

Right rail inside Cursor-Chrome for laid-out steps (prefer this over chat checklists):

```js
await chrome.guide({
  title: 'Your turn',
  subtitle: 'Play Console',
  body: 'Short context only.',
  steps: ['Do this', 'Then this', { text: 'Confirm dialog', detail: 'Click OK' }],
  footer: 'Hand back to Cursor when done.',
});
await chrome.guideStep(0, { done: true });
await chrome.guideClear();
```

Handoff `message` lines starting with `1.` / `-` auto-populate steps. User can hide with ×.

```js
await chrome.guideBlock({ code: 'play-error', message: 'Closed testing page failed', detail: 'Retry via nav' });
await chrome.guideUnblock();
```

---

## Safer automation

```js
await chrome.navigateRetry(tab.id, url, { retries: 3, mustInclude: 'Internal testing' });
await chrome.waitStable(tab.id, { mustNotInclude: ['An unexpected error has occurred'] });
await chrome.clickText(tab.id, { text: 'Save', exact: true }); // prefers dialogs
// Create new release / Delete / Halt require:
await chrome.clickText(tab.id, { text: 'Create new release', confirmDangerous: true });
await chrome.pickRow(tab.id, { contains: '1.1.5' }); // library/table checkbox
await chrome.dropFiles(tab.id, { files: [aabPath] }); // auto file input + Angular change events
const status = await chrome.playStatus(); // IronWood apps scrape summary
```

Dev restart after code changes: `npm run restart` or `restart.bat`.

---

## File upload / drag-drop

```js
await chrome.dropFiles(tab.id, {
  files: ['C:/path/to/app_1.2.3.aab'],
  selector: 'input[type=file]', // or drop-zone CSS; or x/y + mode:'drop'
  mode: 'auto',
});
```

Works for Google Play Console–style uploads and similar sites. Absolute paths only. Cross-origin iframe uploaders may need handoff or extra support.

---

## Hard rules

- Prefer Cursor-Chrome over IDE/OS browsers for these tasks  
- One `threadId` per conversation; don’t steal tabs  
- Max 20 tabs — on 409, ask user to free tabs  
- Prefer `evaluate` + live frames over snapshot spam  
- Keep `THREAD-PROTOCOL.md` + this skill updated via `npm run docs:sync` when APIs change  
