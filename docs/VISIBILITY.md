# Visibility (anti-secrecy + no focus steal)

Cursor-Chrome is agent-controlled only in a way the **human can always observe**, without the agent covering other apps.

## Agents cannot

- `POST /window/hide` → **403**
- `POST /window/minimize` → **403**
- `POST /window/park` → **403**
- Request handoff `after: minimize|hide` (forced to `stay`)
- Steal OS focus, `moveTop`, or `alwaysOnTop` via `show` / `front` / `watch`

## Agents can

- Drive tabs while the window stays parked / in the background
- `POST /window/show` / `front` / `watch` — **background-safe** (active tab only; no OS raise)
- Read live frames always: `GET /tabs/:id/frame.jpg`, `http://127.0.0.1:9222/live`
- Start handoff — soft nudge only (taskbar flash + notification), **no always-on-top**

## Humans can

| Action | How |
|--------|-----|
| Park agents keep working | Taskbar minimize or tray “Minimize to taskbar park” |
| Hide to tray only | Tray “Hide to tray only” |
| Watch anytime | Taskbar icon · tray click · **Ctrl+Shift+C** · live URL |

There is no agent mode that removes tray + taskbar + live view. Secretive control is refused by design (`src/visibility-policy.js`).
Agents must not call `front`/`watch`/`show` expecting the window to jump on top — that behavior was removed.
