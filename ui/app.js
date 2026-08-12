'use strict';

const tabstrip = document.getElementById('tabstrip');
const poolLabel = document.getElementById('poolLabel');
const meta = document.getElementById('meta');
const urlInput = document.getElementById('urlInput');
const navForm = document.getElementById('navForm');
const btnNew = document.getElementById('btnNew');
const btnMin = document.getElementById('btnMin');
const btnHide = document.getElementById('btnHide');
const btnReturn = document.getElementById('btnReturn');
const guideRail = document.getElementById('guideRail');
const guideTitle = document.getElementById('guideTitle');
const guideSubtitle = document.getElementById('guideSubtitle');
const guideKicker = document.getElementById('guideKicker');
const guideBody = document.getElementById('guideBody');
const guideBlocked = document.getElementById('guideBlocked');
const guideBlockedCode = document.getElementById('guideBlockedCode');
const guideBlockedMsg = document.getElementById('guideBlockedMsg');
const guideBlockedDetail = document.getElementById('guideBlockedDetail');
const guideSteps = document.getElementById('guideSteps');
const guideFooter = document.getElementById('guideFooter');
const btnGuideClose = document.getElementById('btnGuideClose');

let state = { tabs: [], activeTabId: null, pool: null, handoff: null, guide: null };

async function handBackToCursor() {
  if (!state.handoff?.active) return;
  btnReturn.disabled = true;
  btnReturn.textContent = 'Returning…';
  try {
    await window.cursorChrome.handoffDone('user clicked Hand back to Cursor');
  } finally {
    btnReturn.disabled = false;
  }
}

function renderGuide() {
  const g = state.guide;
  const hasContent = !!(
    g &&
    (g.title || g.body || g.blocked || (g.steps && g.steps.length) || g.footer)
  );
  const open = !!(g && g.open && hasContent);
  const width = open ? Math.max(260, Math.min(480, g.width || 340)) : 0;
  document.documentElement.style.setProperty('--guide-width', open ? `${width}px` : '0px');

  if (!open) {
    guideRail.hidden = true;
    return;
  }

  guideRail.hidden = false;
  guideKicker.textContent = g.blocked
    ? 'Blocked'
    : g.source === 'handoff'
      ? 'Your turn'
      : 'Cursor';
  guideTitle.textContent = g.title || (g.blocked ? 'Needs attention' : 'Instructions');

  if (g.subtitle) {
    guideSubtitle.hidden = false;
    guideSubtitle.textContent = g.subtitle;
  } else {
    guideSubtitle.hidden = true;
    guideSubtitle.textContent = '';
  }

  if (g.body) {
    guideBody.hidden = false;
    guideBody.textContent = g.body;
  } else {
    guideBody.hidden = true;
    guideBody.textContent = '';
  }

  if (g.blocked && g.blocked.message) {
    guideBlocked.hidden = false;
    guideBlockedCode.textContent = g.blocked.code || 'blocked';
    guideBlockedMsg.textContent = g.blocked.message;
    if (g.blocked.detail) {
      guideBlockedDetail.hidden = false;
      guideBlockedDetail.textContent = g.blocked.detail;
    } else {
      guideBlockedDetail.hidden = true;
      guideBlockedDetail.textContent = '';
    }
  } else {
    guideBlocked.hidden = true;
  }

  guideSteps.innerHTML = '';
  const steps = Array.isArray(g.steps) ? g.steps : [];
  steps.forEach((step, i) => {
    const li = document.createElement('li');
    li.className = `guide-step${step.done ? ' done' : ''}`;

    const num = document.createElement('div');
    num.className = 'guide-step-num';
    num.textContent = step.done ? '✓' : String(i + 1);

    const main = document.createElement('div');
    const text = document.createElement('div');
    text.className = 'guide-step-text';
    text.textContent = step.text || '';
    main.appendChild(text);
    if (step.detail) {
      const detail = document.createElement('div');
      detail.className = 'guide-step-detail';
      detail.textContent = step.detail;
      main.appendChild(detail);
    }

    li.appendChild(num);
    li.appendChild(main);
    guideSteps.appendChild(li);
  });

  if (g.footer) {
    guideFooter.hidden = false;
    guideFooter.textContent = g.footer;
  } else {
    guideFooter.hidden = true;
    guideFooter.textContent = '';
  }
}

function render() {
  const used = state.pool?.used ?? state.tabs.length;
  const max = state.pool?.max ?? 20;
  poolLabel.textContent = `${used} / ${max} agent tabs`;

  const api = state.apiUrl ? `API ${state.apiUrl}` : 'API …';
  const cdp = state.cdpUrl ? `CDP ${state.cdpUrl}` : 'CDP …';
  const mode = state.visible === false ? 'hidden' : state.minimized ? 'minimized' : 'visible';
  const ho = state.handoff?.active ? ' · YOUR TURN' : '';
  const guideOpen = state.guide?.open ? ' · guide' : '';
  meta.textContent = `${api}  ·  ${cdp}  ·  ${mode}${ho}${guideOpen}`;

  const activeHandoff = !!state.handoff?.active;
  btnReturn.classList.toggle('armed', activeHandoff);
  btnReturn.classList.toggle('ai-controlled', !activeHandoff);
  if (activeHandoff) {
    btnReturn.textContent = 'Hand back to Cursor';
    btnReturn.title =
      state.handoff.message ||
      'Your turn — use the page normally, then click here to return control to Cursor (Ctrl+Shift+H)';
    btnReturn.disabled = false;
  } else {
    btnReturn.textContent = 'AI Controlled';
    btnReturn.title =
      'Agent is driving. You can still watch; when Cursor hands off, this becomes Hand back to Cursor.';
    btnReturn.disabled = false;
  }

  tabstrip.innerHTML = '';
  for (const tab of state.tabs) {
    if (tab.warm && !tab.threadId) continue;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `tab${tab.active || tab.id === state.activeTabId ? ' active' : ''}`;
    el.title = tab.url || '';

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || 'New Tab';

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.cursorChrome.closeTab(tab.id);
    });

    el.appendChild(title);
    el.appendChild(close);
    el.addEventListener('click', async () => {
      await window.cursorChrome.focusTab(tab.id);
      urlInput.value = tab.url || '';
    });

    tabstrip.appendChild(el);
  }

  const active = state.tabs.find((t) => t.id === state.activeTabId) || state.tabs.find((t) => t.active);
  if (active && document.activeElement !== urlInput) {
    urlInput.value = active.url || '';
  }

  renderGuide();
}

async function refresh() {
  state = await window.cursorChrome.getState();
  render();
}

btnNew.addEventListener('click', async () => {
  await window.cursorChrome.createTab({ url: 'about:blank', title: 'New Tab' });
});

btnMin.addEventListener('click', () => window.cursorChrome.minimize());
btnHide.addEventListener('click', () => window.cursorChrome.hide());
btnReturn.addEventListener('click', handBackToCursor);
btnGuideClose.addEventListener('click', async () => {
  await window.cursorChrome.guideClose();
});

navForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const active = state.activeTabId;
  if (!active) return;
  let url = urlInput.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url) && !/^about:/i.test(url)) {
    url = `https://${url}`;
  }
  await window.cursorChrome.navigate(active, url);
});

window.cursorChrome.onState((next) => {
  state = next;
  render();
});

refresh();
