# Cursor-Chrome — Thread Protocol

> **Canonical instructions for every Cursor thread that uses this browser.**  
> Path: `C:\dev\Cursor\Cursor-Chrome\docs\THREAD-PROTOCOL.md`  
> Skill mirror: `C:\Users\joewu\.cursor\skills\cursor-chrome\SKILL.md`  
> Maintainers: when you change API/behavior, update this file **and** run `npm run docs:sync`.

Last synced: see `docs/API.generated.md` header after `docs:sync`.

---

## 0. Mission

Cursor-Chrome is a private Chromium shell Cursor owns completely:

- Up to **20** concurrent agent tabs (one per thread)
- Runs **parked / off-desktop** while agents work
- **Realtime live frames** (not one-shot snapshots)
- **Human handoff** for logins / 2FA / CAPTCHA
- **File drag-and-drop** (AAB uploads, etc.)
- REST `http://127.0.0.1:9222` + CDP `http://127.0.0.1:9223`

Prefer Cursor-Chrome over the IDE browser when the user says **use cursor chrome** / **cursor-chrome** / wants parallel minimized browser control.

---

## 1. First actions (every thread)

1. **Read** this protocol (or the skill that mirrors it).
2. **Health-check** `GET http://127.0.0.1:9222/health` (or `/status`).
3. If down, start:

```powershell
Start-Process -FilePath "C:\dev\Cursor\Cursor-Chrome\start-minimized.bat" -WorkingDirectory "C:\dev\Cursor\Cursor-Chrome"
```

4. Poll `/health` for up to ~10s (do **not** blindly sleep 3s once if already up).
5. **Claim a tab** with a stable unique `threadId` for this chat.
6. Drive that tab only. Never steal another thread’s tab.

```js
const { CursorChrome } = require('C:/dev/Cursor/Cursor-Chrome/src/client.js');
const chrome = new CursorChrome(); // http://127.0.0.1:9222
const threadId = 'cursor-thread-<stable-id>'; // reuse for whole conversation
const { tab, live, reused } = await chrome.claim(threadId, { url: 'https://example.com' });
```

---

## 2. Client API (preferred)

Module: `C:/dev/Cursor/Cursor-Chrome/src/client.js`

| Method | Purpose |
|--------|---------|
| `status()` / `health()` / `metrics()` | Status, liveness, pool metrics |
| `claim(threadId, { url, title, profile, isolate })` | Get/create tab (+ warm pool) + live stream |
| `navigate` / `evaluate` / `act` / `snapshot` | Page control + a11y snapshot + DSL |
| `click` / `type` / `hover` / `scroll` / `press` / `wait` | Precise input + waits |
| `clickText` / `pickRow` / `navigateRetry` / `waitStable` | Dialog-scoped text clicks, table pick, SPA retries |
| `liveFrame(tabId)` | Latest live JPEG (Buffer) |
| `dropFiles` / `dragDropFiles` | File input or CDP drag-drop (folders OK; auto-detects file input) |
| `front` / `watch` / `minimize` | Tab select only / human park — **agents never steal OS focus** |
| `handoff` / `autoHandoff` / `authCheck` | Human takeover + auth-wall detect |
| `guide` / `guideBlock` / `guideClear` / `guideStep` / `playStatus` | Right-rail instructions + Play scrape |
| `network` / `downloads` | Request + download tracking |
| `exportSession` / `importSession` / `profiles` | Session backup + named profiles |
| `pickerStart` / `recordStart` / `playbook` | Element picker + recorder |
| `close(tabId)` | Release tab |

Generated method list: `docs/API.generated.md`.

---

## 3. REST surface

Base: `http://127.0.0.1:9222`

### Lifecycle
- `GET /health` — cheap liveness + Chromium CDP probe (`cdp.ok`) + security note
- `GET /status` — pool, tabs, handoff, live URL
- `GET /metrics` — pool, frames, downloads, speed mode, uptime
- `POST /claim` `{ threadId, url?, title?, profile?, isolate? }` → `{ tab, reused, fromWarm, live, auth }`
- `POST /warm` — refill warm tab pool
- `POST /speed-mode` `{ enabled }`
- `GET /tabs` · `POST /tabs` · `GET /tabs/:id` · `DELETE /tabs/:id` · `DELETE /tabs`

### Page control
- `POST /tabs/:id/navigate` `{ url }`
- `POST /tabs/:id/evaluate` `{ expression }`
- `POST /tabs/:id/act` — multi-step DSL
- `POST /tabs/:id/snapshot` — a11y/text tree
- `POST /tabs/:id/click|type|hover|scroll|press|wait`
- `POST /tabs/:id/focus` · `POST /tabs/:id/thread`

### Vision (realtime)
- `GET /tabs/:id/frame.jpg` — **use this** (live screencast buffer)
- `GET /tabs/:id/mjpeg` — continuous MJPEG
- `GET /live?tab=:id` — human co-watch UI
- `POST /tabs/:id/stream/start` · `POST /tabs/:id/stream/stop`
- `POST /tabs/:id/screenshot` — serves live frame when streaming
- `ws://127.0.0.1:9222/stream` → `{"type":"subscribe","tabId":"..."}` (binary JPEGs)
- `ws://127.0.0.1:9222/ws` — events + pipelined `{type:"act"|"click"|"type"|…}`

### Files / network
- `POST /tabs/:id/drop-files` `{ files: string[], selector?, x?, y?, mode?, index?, useIndex? }` — CDP set + Angular input/change
- `POST /tabs/:id/drag-drop-files`
- `GET /tabs/:id/network` · `GET /downloads`

### Window
- `POST /window/minimize` — park off-screen (keeps live frames working)
- `POST /window/hide` · `/show` · `/restore`
- `POST /window/front` `{ tabId?, threadId? }` — active tab only; **does not raise OS window**
- `POST /window/watch` — same (no unpark / no focus steal)

### Handoff
- `GET /handoff`
- `POST /handoff` `{ tabId?, threadId?, url?, reason?, message?, after?, wait?, timeoutMs? }`
- `POST /handoff/done` `{ note? }`
- `POST /handoff/wait` `{ timeoutMs? }`
- `POST /tabs/:id/auto-handoff` · `POST /tabs/:id/auth-check`
- `POST /tabs/:id/click` · `POST /tabs/:id/click-text` `{ text, exact?, scope?, confirmDangerous? }`
- `POST /tabs/:id/pick-row` `{ contains, click? }`
- `POST /tabs/:id/navigate-retry` `{ url, retries?, mustInclude? }`
- `POST /tabs/:id/wait` `{ stable? | selector? | text? | … }`
- `GET /guide` · `POST /guide` · `POST /guide/clear` · `POST /guide/close` · `POST /guide/open`
- `POST /guide/block` · `POST /guide/unblock`
- `POST /guide/steps/:id` `{ done: true }` — mark a step complete (index or step id)

### Profiles / session / power
- `GET /profiles` · `POST /session/export` · `POST /session/import`
- `GET /log` · `DELETE /log`
- `POST /tabs/:id/picker/start` · `GET /tabs/:id/picker/result`
- `POST /tabs/:id/record/start|stop` · `POST /tabs/:id/playbook`

### CDP / MCP
- `http://127.0.0.1:9223` — Playwright: `chromium.connectOverCDP(...)`
- MCP: `node C:/dev/Cursor/Cursor-Chrome/mcp/server.js` (`npm run mcp`)

Generated route list: `docs/API.generated.md`.

---

## 4. Playbooks

### A. Browse + extract
1. `claim` → `navigate` → `evaluate` / `snapshot` / `act`  
2. Use `liveFrame` only when pixels matter  
3. **Do not** call `front` / `watch` / `show` to raise the window — leave it parked; human watches via taskbar or `/live`

### B. Login / 2FA / CAPTCHA
1. `authCheck` or `autoHandoff`, or detect via evaluate/live frame  
2. For Google, prefer password-friendly entry (auto-rewritten on navigate):  
   `chrome.loginUrl('google')` → ServiceLogin (avoids passkey-first traps)  
3. Tell user a handoff is waiting (taskbar flash / notification — **no always-on-top**)  
4. `await chrome.handoff(tab.id, { reason:'login', wait:true, after:'minimize', message:'…' })`  
   Numbered lines in `message` auto-fill the **right instruction sidebar**. Prefer also calling `guide()` for richer layout.  
5. User clicks **Hand back to Cursor** (toolbar turns from green **AI Controlled** → clickable hand-back / tray / **Ctrl+Shift+H**)  
6. Resume automation — **never type passwords**

**Focus rule:** Never call `chrome.front()`, `chrome.watch()`, or `chrome.show()` to yank the window over other apps. Those APIs are background-safe no-ops for OS z-order. Only the human raises Cursor-Chrome (taskbar / tray / Ctrl+Shift+C).

### B2. Instruction sidebar (right rail)
When the human needs clear in-browser steps (handoff or co-watching), **do not dump a wall of checklist text into chat**. Push the rail:

```js
await chrome.guide({
  title: 'Play Console',
  subtitle: 'IronGuard closed testing',
  body: 'One short paragraph of context.',
  steps: [
    'Open Closed testing → Create new release',
    { text: 'Add 1.1.5 from library', detail: 'Target SDK 37' },
    'Save → Submit for review',
  ],
  footer: 'Click Hand back to Cursor when finished.',
});
// later:
await chrome.guideStep(0, { done: true });
await chrome.guideClear(); // when done
```

Handoff messages with `1. …` / `- …` lines are parsed into steps automatically. User can hide the rail with ×.

Use `guideBlock({ code, message, detail })` when Play returns an unexpected error or a confirm is needed — don’t leave the human staring at a blank checklist.

### B3. Safer automation defaults
- Prefer `navigateRetry` + `waitStable` for Play Console SPAs (retries; fails on “unexpected error”).
- Prefer `clickText` over broad `evaluate` label clicks; it scopes to open dialogs and **refuses** Create/Delete/Halt/Pause unless `confirmDangerous: true`.
- Prefer `pickRow({ contains })` for library/table checkboxes.
- `dropFiles({ files })` auto-detects `input[type=file]` (prefers matching `accept`, `.aab`/images), keeps multi-input `useIndex`, and fires Angular `input`/`change` after CDP set.
- `playStatus()` scrapes IronGuard / Ironbat / IronSync home + tracks + publishing into a verdict list.
- After code changes in this repo: `npm run restart` (or `restart.bat`).

---

### C. Upload AAB / files (Play Console, etc.)
1. Navigate to upload UI (handoff for login first if needed)  
2. Prefer `dropFiles({ files })` (auto-detects file input + change events); else selector + optional `index`; else `x,y`  
3. Absolute Windows path required (folders expand to files):

```js
await chrome.dropFiles(tab.id, {
  files: ['C:/Users/joewu/My Drive/Cursor/Latest Installer/App/app_1.2.3.aab'],
  // selector / index optional when a matching input[type=file] exists
});
// SPA UIs often still need a follow-up click on "Add" / upload confirm after files attach
```

4. Confirm via `evaluate` (filename text / success toast) or live frame  
5. Same-origin iframes: pass `iframe: 'iframe#…'` on click/type. Cross-origin → hand off.

### D. Multi-thread (≤20 concurrent Cursor chats)

**Ready for parallel threads** when each chat uses a **stable unique `threadId`**.

| Rule | Detail |
|------|--------|
| Claim | `chrome.claim(threadId, { url? })` — serialized server-side; same id reuses its tab |
| Cap | Max **20** tabs globally |
| Pressure | Only unused **warm** tabs are evicted. Claimed tabs are never auto-closed → `409 TAB_LIMIT` |
| Drive | Always use **your** `tab.id` for navigate/evaluate/click/frames — never another thread’s |
| Focus | Do not call `front`/`watch`/`show` to raise the window (background-safe) |
| Handoff | **One** handoff at a time. Second thread gets `409 HANDOFF_BUSY` until Hand back |
| Guide | Pass `threadId` on `guide()`. Another thread’s open guide → `409 GUIDE_BUSY` unless `force:true` |
| Cookies | Default shared profile — logins are shared across threads (usually what you want for Play) |
| Isolate | `claim(id, { isolate: true })` or `{ profile: 'work' }` skips warm shared tabs |

On `409 TAB_LIMIT`, close idle tabs (`DELETE /tabs/:id`) or ask the human to free slots.

Smoke: `node examples/multi-thread-smoke.js`

### D2. Popups & overlays (multi-thread safe)

Three different “popup” kinds — handle each differently:

| Kind | What it is | How agents drive it |
|------|------------|---------------------|
| **In-page dialog** | Material/CDK/Azure blade in the **same** document | Same `tab.id`; `clickText` prefers dialog/overlay scope |
| **`window.open`** | Real browser popup (OAuth etc.) | Adopted as a **child tab** (`kind:'popup'`) with the **same `threadId`** as the opener. Drive the **child** `tab.id`, not another thread’s tab |
| **OS file chooser** | Native dialog | Use `dropFiles` / chooser intercept on **your** tab only |

**Rules for concurrent threads**
1. Always pass/use your `threadId` (client sets this on `claim()` and sends it on mutate calls). Wrong thread → `403 THREAD_MISMATCH`.
2. After a click that may open `window.open`, call `chrome.resolveOverlay(tab.id)` or `chrome.listPopups(tab.id)` and continue on the returned child id.
3. Never assume the human-visible tab is yours — use `/live?tab=<yourTabId>` or frames for **your** id. `watch`/`front` do **not** flip the visible tab unless `stealVisible:true` or handoff.
4. Popups stay **hidden** (no focus fight); paint via `liveFrame(popupTabId)`.
5. Closing a parent tab closes its popup children.

```js
const { tab } = await chrome.claim('cursor-thread-A', { url });
await chrome.clickText(tab.id, { text: 'Sign in with Google' });
await new Promise((r) => setTimeout(r, 800));
const { target, switched } = await chrome.resolveOverlay(tab.id);
const driveId = target.id; // popup if opened, else parent
await chrome.type(driveId, { selector: 'input[type=email]', text: '…' }); // still never type passwords for real logins — hand off
```

Inspect: `GET /tabs/:id/overlays` · `GET /tabs/:id/popups` · WS event `popup_opened`.

### E. Watch anytime (taskbar)
- **Click the Cursor-Chrome taskbar icon** → window comes to the front (human only)  
- **Minimize** → parks off-desktop; **agents keep working without stealing focus**  
- Also: tray, **Ctrl+Shift+C**, or `http://127.0.0.1:9222/live`  
- `chrome.watch({ tabId })` does **not** raise the window — use it only to select the active tab for frames

### F. Speed mode
- `chrome.speedMode(true)` blocks images/media/fonts for faster navigation  
- Turn off before visual verification / uploads that need assets

---

## 5. Hard rules

1. Cursor-Chrome only — no OS Chrome/Edge, no `Start-Process http`, no IDE browser unless user asks for the panel.  
2. One `threadId` per conversation; reuse it. Never drive another thread’s `tabId`.  
3. Max 20 tabs globally (`409 TAB_LIMIT` when full — claimed tabs are never auto-evicted).  
4. Prefer `evaluate` + `frame.jpg` over slow snapshot loops; use `act`/`snapshot` for structured control.  
5. Hand off for secrets / 2FA / CAPTCHA / bank confirms — **one handoff at a time** (`409 HANDOFF_BUSY` otherwise).  
6. File paths must exist and be absolute.  
7. After handoff Done, assume session cookies are set; continue on the **same** tab.  
8. **Logins persist** in the shared profile (`persist:cursor-chrome-profile` under `%LOCALAPPDATA%\Cursor-Chrome`). Do not clear sessions unless the user asks (`POST /session/clear`).  
9. If API changes in code, update this protocol + skill via `npm run docs:sync`.  
10. Pass `threadId` on `guide()` so concurrent chats don’t overwrite each other (`409 GUIDE_BUSY`).

---

## 5b. Remembered logins (persistent profile)

By default **all tabs share one persistent browser profile**. Cookies, localStorage, and Google/Play Console sessions survive app restarts, new tabs, and parked mode.

- On disk: `%LOCALAPPDATA%\Cursor-Chrome` · partition `persist:cursor-chrome-profile`
- Named profiles: `shared` | `work` | `personal` | `isolated` via `claim(..., { profile })`
- Session export/import: `exportSession` / `importSession`
- Flushed to disk after handoff Done and on quit
- Optional isolation: `claim(threadId, { isolate: true })` or `--isolate-sessions`
- Clear only if asked: `chrome.clearSession()` / `POST /session/clear`

---

## 6. Launchers

| Script | Behavior |
|--------|----------|
| `start-minimized.bat` | Parked off-desktop, agents + live frames active |
| `start-hidden.bat` | Tray-only hide |
| `start.bat` | Visible window |
| `npm start` | Visible Electron |
| `npm run startup:install` | Launch minimized at Windows login |
| `npm run mcp` | MCP stdio server for Cursor tools |

MCP (Cursor): `~/.cursor/mcp.json` → server `cursor-chrome` → `node …/mcp/server.js`

Installer: `builds/Cursor-Chrome_*.exe` · Latest Installer copy under `Cursor-Chrome\`.

Watchdog auto-relaunches if the agent API dies (spawned with the app).

---

## 7. Maintenance (for coding agents)

When changing `src/agent-api.js`, `src/routes-power.js`, `src/client.js`, handoff, guide/sidebar, frames, or drop-files:

1. Update **this** file’s playbooks/rules if behavior changed.  
2. Update `.cursor/skills/cursor-chrome/SKILL.md` (keep in lockstep).  
3. Run `npm run docs:sync` (regenerates `docs/API.generated.md`, copies skill → `~\.cursor\skills\cursor-chrome\`).  
4. Bump user-facing README only if user-visible behavior changed.

### 7b. Auto-maintain Gitea + GitHub (private monorepo)

Full policy: **`docs/MAINTAIN-REMOTES.md`**.

1. Once: `npm run hooks:install` (also runs on `npm install` / `install:agent` in the private repo).  
2. Every `git commit` → background `npm run maintain:remotes`  
   - private push → Gitea / origin / github  
   - public MIT export → `T3ckfr3ak1/cursor-chrome-public`  
3. Force now: `npm run maintain:remotes`  
4. Status: `logs/maintain-remotes-last.json`  
5. Skip once: `CURSOR_CHROME_SKIP_MAINTAIN=1`

Do not leave the skill stale relative to the API.  
Do not leave remotes stale after a finished feature commit.
