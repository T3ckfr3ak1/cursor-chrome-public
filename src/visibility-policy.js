'use strict';

/**
 * Visibility / anti-secrecy + focus policy for Cursor-Chrome.
 *
 * The human may minimize or hide via taskbar / tray / UI.
 * Agents and the API must NEVER park, hide, or opaque-stealth the window —
 * the human always retains a way to see work (taskbar, tray, /live, frames).
 *
 * Agents also must NEVER steal OS focus or use always-on-top.
 * `show` / `front` / `watch` are background-safe (tab switch only).
 * Handoff soft-nudges (flash + notification) without covering other apps.
 * Humans raise the window via taskbar, tray, or Ctrl+Shift+C.
 */

const AGENT_BLOCKED = Object.freeze({
  ok: false,
  error: 'AGENT_VISIBILITY_FORBIDDEN',
  message:
    'Agents cannot hide or minimize Cursor-Chrome. The human may park via taskbar/tray. Agent show/front/watch do not raise the OS window — use taskbar, tray, Ctrl+Shift+C, or /live to watch. Live frames stay at /live and /tabs/:id/frame.jpg.',
});

function observabilityNote(apiPort) {
  return {
    agentCanHide: false,
    agentCanMinimize: false,
    agentCanPark: false,
    agentCanStealFocus: false,
    agentCanAlwaysOnTop: false,
    humanCanMinimize: true,
    humanCanHide: true,
    alwaysOn: {
      tray: true,
      taskbarWhenVisibleOrParked: true,
      liveViewer: `http://127.0.0.1:${apiPort || 9222}/live`,
      health: `http://127.0.0.1:${apiPort || 9222}/health`,
      hotkeyWatch: 'Ctrl+Shift+C',
    },
    policy:
      'Cursor-Chrome refuses agent hide/minimize/park AND refuses agent focus-steal / always-on-top. Agents work in the background; humans raise the window when they want to watch.',
  };
}

module.exports = {
  AGENT_BLOCKED,
  observabilityNote,
};
