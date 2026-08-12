'use strict';

/**
 * Action recorder + in-page element picker helpers (injected via evaluate).
 */
const PICKER_SCRIPT = `(() => {
  if (window.__ccPickerActive) return 'already';
  window.__ccPickerActive = true;
  window.__ccLastPick = null;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #c0a840;background:rgba(192,168,64,.15);display:none;';
  document.documentElement.appendChild(overlay);
  const cssPath = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 5) {
      let part = el.tagName.toLowerCase();
      if (el.classList && el.classList.length) part += '.' + [...el.classList].slice(0,2).map(c=>CSS.escape(c)).join('.');
      const parent = el.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter(c => c.tagName === el.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(el)+1) + ')';
      }
      parts.unshift(part);
      el = parent;
    }
    return parts.join(' > ');
  };
  const move = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay) return;
    const r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
  };
  const click = (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    window.__ccLastPick = {
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || '').slice(0, 80),
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
    };
    stop();
  };
  const stop = () => {
    window.__ccPickerActive = false;
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('click', click, true);
    overlay.remove();
  };
  document.addEventListener('mousemove', move, true);
  document.addEventListener('click', click, true);
  window.__ccStopPicker = stop;
  return 'started';
})()`;

class Recorder {
  constructor() {
    /** @type {Map<string, object>} */
    this.byTab = new Map();
  }

  start(tabId, threadId = null) {
    const rec = { tabId, threadId, startedAt: Date.now(), actions: [], recording: true };
    this.byTab.set(tabId, rec);
    return rec;
  }

  stop(tabId) {
    const rec = this.byTab.get(tabId);
    if (!rec) return null;
    rec.recording = false;
    rec.stoppedAt = Date.now();
    return rec;
  }

  push(tabId, action) {
    const rec = this.byTab.get(tabId);
    if (!rec || !rec.recording) return null;
    const row = { ts: Date.now(), ...action };
    rec.actions.push(row);
    return row;
  }

  get(tabId) {
    return this.byTab.get(tabId) || null;
  }

  toPlaybook(tabId) {
    const rec = this.get(tabId);
    if (!rec) return null;
    return {
      name: `playbook-${tabId.slice(0, 8)}`,
      createdAt: rec.startedAt,
      steps: rec.actions.map((a) => {
        if (a.type === 'navigate') return { navigate: a.url };
        if (a.type === 'click') return { click: { selector: a.selector, x: a.x, y: a.y } };
        if (a.type === 'type') return { type: { selector: a.selector, text: a.text } };
        if (a.type === 'dropFiles') return { dropFiles: a };
        return a;
      }),
    };
  }
}

module.exports = { Recorder, PICKER_SCRIPT };
