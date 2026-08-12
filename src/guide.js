'use strict';

/**
 * Right-rail instruction guide for humans watching / taking over Cursor-Chrome.
 * Agents push structured steps via POST /guide; the chrome UI renders them.
 */
const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 260;
const MAX_WIDTH = 480;

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((s, i) => {
      if (typeof s === 'string') {
        return { id: `s${i + 1}`, text: s.trim(), done: false, detail: null };
      }
      if (!s || typeof s !== 'object') return null;
      const text = String(s.text || s.title || s.label || '').trim();
      if (!text) return null;
      return {
        id: String(s.id || `s${i + 1}`),
        text,
        done: !!s.done,
        detail: s.detail ? String(s.detail) : null,
      };
    })
    .filter(Boolean);
}

/** Pull numbered / bulleted lines out of a freeform message into steps. */
function stepsFromMessage(message) {
  const lines = String(message || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const stepped = [];
  const rest = [];
  for (const line of lines) {
    const m = line.match(/^(?:\d+[\).\]]\s+|[-*•]\s+)(.+)$/);
    if (m) stepped.push(m[1].trim());
    else rest.push(line);
  }
  return { steps: stepped, body: rest.join('\n').trim() || null };
}

class GuideController {
  constructor() {
    this.state = this._empty();
    this.onChange = null;
  }

  _empty() {
    return {
      open: false,
      title: '',
      subtitle: null,
      body: null,
      footer: null,
      steps: [],
      blocked: null, // { code, message, detail } | null
      tabId: null,
      threadId: null,
      width: DEFAULT_WIDTH,
      source: null,
      updatedAt: Date.now(),
    };
  }

  get() {
    return { ...this.state, steps: this.state.steps.map((s) => ({ ...s })) };
  }

  /** Pixels the page BrowserView must leave on the right. */
  sidebarWidth() {
    return this.state.open ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, this.state.width || DEFAULT_WIDTH)) : 0;
  }

  set(payload = {}) {
    const prev = this.state;
    const incomingThread =
      payload.threadId !== undefined ? payload.threadId || null : undefined;
    if (
      prev.open &&
      prev.threadId &&
      incomingThread &&
      incomingThread !== prev.threadId &&
      !payload.force &&
      !payload.clear
    ) {
      const err = new Error(
        `Guide busy for thread ${prev.threadId}. Clear that guide first, or pass force:true.`
      );
      err.code = 'GUIDE_BUSY';
      err.guide = this.get();
      throw err;
    }

    const steps =
      payload.steps !== undefined ? normalizeSteps(payload.steps) : prev.steps.map((s) => ({ ...s }));

    let width = prev.width || DEFAULT_WIDTH;
    if (payload.width != null) {
      width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(payload.width) || DEFAULT_WIDTH));
    }

    const open =
      payload.open !== undefined
        ? !!payload.open
        : payload.clear
          ? false
          : true; // posting content opens by default

    this.state = {
      open,
      title: payload.title !== undefined ? String(payload.title || '') : prev.title,
      subtitle:
        payload.subtitle !== undefined
          ? payload.subtitle
            ? String(payload.subtitle)
            : null
          : prev.subtitle,
      body: payload.body !== undefined ? (payload.body ? String(payload.body) : null) : prev.body,
      footer:
        payload.footer !== undefined ? (payload.footer ? String(payload.footer) : null) : prev.footer,
      steps,
      blocked:
        payload.blocked !== undefined
          ? payload.blocked
            ? {
                code: String(payload.blocked.code || payload.blocked.reason || 'blocked'),
                message: String(payload.blocked.message || payload.blocked.text || 'Blocked'),
                detail: payload.blocked.detail ? String(payload.blocked.detail) : null,
              }
            : null
          : prev.blocked || null,
      tabId: payload.tabId !== undefined ? payload.tabId || null : prev.tabId,
      threadId: payload.threadId !== undefined ? payload.threadId || null : prev.threadId,
      width,
      source: payload.source !== undefined ? payload.source : prev.source || 'agent',
      updatedAt: Date.now(),
    };

    // Empty guide with open:false stays empty
    if (payload.clear) {
      this.state = this._empty();
    }

    this._emit();
    return this.get();
  }

  /** Convenience: open a well-laid-out guide from agent copy. */
  show({
    title = 'Instructions',
    subtitle = null,
    body = null,
    footer = null,
    steps = [],
    blocked = null,
    tabId = null,
    threadId = null,
    width,
    source = 'agent',
  } = {}) {
    return this.set({
      open: true,
      title,
      subtitle,
      body,
      footer,
      steps,
      blocked,
      tabId,
      threadId,
      width,
      source,
    });
  }

  /** Mark the rail as blocked (SPA error, confirm needed, etc.). Opens if closed. */
  block({ code = 'blocked', message, detail = null, title, keepSteps = true } = {}) {
    return this.set({
      open: true,
      title: title !== undefined ? title : this.state.title || 'Blocked',
      blocked: { code, message: message || 'Something blocked progress', detail },
      steps: keepSteps ? undefined : [],
      source: this.state.source || 'agent',
    });
  }

  clearBlocked() {
    return this.set({ blocked: null, open: this.state.open });
  }

  /**
   * Seed the rail from a handoff message (parses numbered lists into steps).
   * Skips if an agent-authored guide is already open.
   */
  fromHandoff({ message, tabId = null, threadId = null, reason = 'handoff' } = {}) {
    if (this.state.open && this.state.source === 'agent' && (this.state.steps.length || this.state.body)) {
      // Keep agent guide; just ensure open
      this.state.open = true;
      this.state.updatedAt = Date.now();
      this._emit();
      return this.get();
    }
    const { steps, body } = stepsFromMessage(message);
    return this.show({
      title: 'Your turn',
      subtitle: reason && reason !== 'user' ? String(reason) : 'Finish this step, then Hand back to Cursor',
      body: body || (steps.length ? null : String(message || '').trim() || null),
      steps,
      footer: 'When finished, click Hand back to Cursor in the toolbar (or Ctrl+Shift+H).',
      tabId,
      threadId,
      source: 'handoff',
    });
  }

  setStep(indexOrId, { done } = {}) {
    const steps = this.state.steps.map((s) => ({ ...s }));
    let idx = -1;
    if (typeof indexOrId === 'number') idx = indexOrId;
    else idx = steps.findIndex((s) => s.id === indexOrId);
    if (idx < 0 || idx >= steps.length) {
      return { ok: false, error: 'Step not found', guide: this.get() };
    }
    if (done !== undefined) steps[idx].done = !!done;
    this.state = { ...this.state, steps, updatedAt: Date.now(), source: this.state.source || 'agent' };
    this._emit();
    return { ok: true, guide: this.get() };
  }

  close() {
    if (!this.state.open) return this.get();
    this.state = { ...this.state, open: false, updatedAt: Date.now() };
    this._emit();
    return this.get();
  }

  open() {
    if (!this.state.title && !this.state.body && !this.state.steps.length) {
      return this.get();
    }
    this.state = { ...this.state, open: true, updatedAt: Date.now() };
    this._emit();
    return this.get();
  }

  clear({ ifSource = null } = {}) {
    if (ifSource && this.state.source !== ifSource) return this.get();
    this.state = this._empty();
    this._emit();
    return this.get();
  }

  _emit() {
    if (typeof this.onChange === 'function') this.onChange(this.get());
  }
}

module.exports = { GuideController, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH };
