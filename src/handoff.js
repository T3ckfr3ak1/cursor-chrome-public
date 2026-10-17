'use strict';

/**
 * Human handoff: bring Cursor-Chrome to the foreground so the user can
 * complete logins / 2FA / CAPTCHA, then signal Done and return control to the agent.
 */
class HandoffController {
  constructor() {
    this.state = null; // { id, tabId, threadId, reason, message, startedAt, after }
    this._waiters = [];
    this.onChange = null;
  }

  get() {
    return this.state ? { ...this.state, active: true } : { active: false };
  }

  start({
    tabId = null,
    threadId = null,
    reason = 'user',
    message = '',
    after = 'stay',
    force = false,
  } = {}) {
    // One global handoff UI — refuse superseding another thread unless force.
    if (this.state && !force) {
      const sameTab = tabId && this.state.tabId === tabId;
      const sameThread = threadId && this.state.threadId === threadId;
      if (!sameTab && !sameThread) {
        const err = new Error(
          `Handoff already active for thread ${this.state.threadId || 'unknown'} (tab ${this.state.tabId || 'unknown'}). Wait for Hand back, or pass force:true.`
        );
        err.code = 'HANDOFF_BUSY';
        err.handoff = this.get();
        throw err;
      }
      // Same thread/tab renewing — resolve prior waiters as superseded then replace.
      this._resolveWaiters({ ok: false, superseded: true, handoff: this.get() });
    } else if (this.state && force) {
      this._resolveWaiters({ ok: false, superseded: true, handoff: this.get() });
    }

    // Agents cannot request post-handoff hide/minimize — only "stay".
    // Humans still park themselves with taskbar / tray after Done.
    const safeAfter = 'stay';

    this.state = {
      id: `ho-${Date.now().toString(36)}`,
      tabId,
      threadId,
      reason: reason || 'user',
      message: message || 'Finish this step in the browser, then click Done.',
      after: safeAfter,
      requestedAfter: after === 'hide' || after === 'minimize' ? after : 'stay',
      startedAt: Date.now(),
    };
    this._emit();
    return this.get();
  }

  done({ note = null, source = 'api' } = {}) {
    if (!this.state) {
      return { ok: false, active: false, error: 'No handoff in progress' };
    }
    const finished = {
      ok: true,
      active: false,
      source,
      note,
      handoff: { ...this.state },
      finishedAt: Date.now(),
      durationMs: Date.now() - this.state.startedAt,
    };
    const after = this.state.after;
    this.state = null;
    this._resolveWaiters(finished);
    this._emit();
    return { ...finished, after };
  }

  /**
   * Block until handoff done/supersede or timeout.
   * Caps timeout at 2h so long logins (2FA, bank, Play) don't die at 5 minutes by surprise.
   * Timed-out waiters leave handoff active — agent may wait again or call done.
   */
  wait(timeoutMs = 300000) {
    if (!this.state) {
      return Promise.resolve({ ok: false, active: false, error: 'No handoff in progress' });
    }
    const MAX_WAIT = 2 * 60 * 60 * 1000; // 2 hours
    const ms = Math.min(MAX_WAIT, Math.max(1000, Number(timeoutMs) || 300000));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this._waiters.findIndex((w) => w.resolve === resolveWrapped);
        if (idx >= 0) this._waiters.splice(idx, 1);
        resolve({
          ok: false,
          timedOut: true,
          active: !!this.state,
          timeoutMs: ms,
          handoff: this.get(),
        });
      }, ms);

      const resolveWrapped = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
      this._waiters.push({ resolve: resolveWrapped, startedAt: Date.now() });
    });
  }

  _resolveWaiters(result) {
    const waiters = this._waiters.splice(0, this._waiters.length);
    for (const w of waiters) w.resolve(result);
  }

  _emit() {
    if (typeof this.onChange === 'function') this.onChange(this.get());
  }
}

/**
 * Unpark the window onto the desktop without stealing OS focus or always-on-top.
 * Used for handoff nudges so the human can finish other work first.
 */
async function requestWindowAttention(win) {
  if (!win || win.isDestroyed()) return false;

  try {
    win.setOpacity(1);
  } catch {
    /* ignore */
  }
  if (win.isMinimized()) win.restore();
  try {
    const b = win.getBounds();
    if (b.x < -1000 || b.y < -1000) {
      win.center();
    }
  } catch {
    /* ignore */
  }

  // Never setAlwaysOnTop / moveTop / focus — agents must not cover other apps.
  try {
    win.showInactive();
  } catch {
    try {
      win.show();
    } catch {
      /* ignore */
    }
  }
  try {
    win.flashFrame(true);
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      if (!win.isDestroyed()) win.flashFrame(false);
    } catch {
      /* ignore */
    }
  }, 2500);

  return true;
}

/**
 * Human-initiated: bring Cursor-Chrome forward (taskbar / hotkey / tray).
 * Still never uses always-on-top.
 */
async function bringWindowToFront(win) {
  if (!win || win.isDestroyed()) return false;

  try {
    win.setOpacity(1);
  } catch {
    /* ignore */
  }
  if (win.isMinimized()) win.restore();
  try {
    const b = win.getBounds();
    if (b.x < -1000 || b.y < -1000) {
      win.center();
    }
  } catch {
    /* ignore */
  }

  try {
    if (typeof win.setAlwaysOnTop === 'function') win.setAlwaysOnTop(false);
  } catch {
    /* ignore */
  }

  win.show();
  try {
    win.focus();
  } catch {
    /* ignore */
  }

  return true;
}

module.exports = { HandoffController, bringWindowToFront, requestWindowAttention };
