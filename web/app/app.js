import { el, iconEl, platformEl } from '/shared/render.js';
import { PLATFORM } from '/shared/icons.js';
import { $, $$, api, state, refreshState, hydrateIcons, toast, prefs, savePrefs, copy, on, emit, placePopover, canMod, canSend, CHAT_SIZE } from './core.js';
import { openSettings } from './settings.js';
import { Column, VIEWS, viewLabel, matches, renderItem } from './feed.js';
import { mod, banWithUndo, openUserCard } from './usercard.js';
import { openSearch } from './search.js';
import { renderTarget, startReply, insertText, rememberUser, lockTarget } from './composer.js';
import { applyLook, setChatSize, renderStats, noteItem, openViewMenu, showKeys, renderBanners } from './view.js';

const PLATFORMS = ['twitch', 'kick', 'tiktok', 'youtube'];
const MAX_ITEMS = 3000;

// A pop-out window shows one view, e.g. /app?view=kick&popout=1
const params = new URLSearchParams(location.search);
const popout = params.get('popout') === '1';
const popView = VIEWS.some(v => v.id === params.get('view')) ? params.get('view') : 'all';

let tab = popout ? popView : 'all';
const unread = { mentions: 0, firsts: 0, events: 0 };
let columns = [];

hydrateIcons();
applyLook();
if (popout) {
  document.body.classList.add('popout');
  document.title = `${viewLabel(popView)} · StreamChat`;
  const t = $('#popoutTitle');
  t.hidden = false;
  const v = VIEWS.find(x => x.id === popView);
  if (v?.pf) t.append(platformEl(v.pf)); else if (v?.icon) t.append(iconEl(v.icon));
  t.append(el('span', null, viewLabel(popView)));
  lockTarget(popView);
}

// ---------------------------------------------------------------- tabs & columns

function buildTabs() {
  const nav = $('#tabs');
  nav.replaceChildren();
  for (const t of VIEWS) {
    const b = el('button', 'tab');
    b.role = 'tab';
    b.dataset.tab = t.id;
    b.setAttribute('aria-selected', String(t.id === tab));
    if (t.pf) { b.append(platformEl(t.pf)); b.style.setProperty('--tab-color', PLATFORM[t.pf].color); }
    if (t.icon) b.append(iconEl(t.icon));
    b.append(el('span', null, t.label));
    if (t.id in unread) { const c = el('span', 'count'); c.hidden = true; b.append(c); }
    b.addEventListener('click', () => setTab(t.id));
    nav.append(b);
  }
  const pop = el('button', 'tab tab-pop');
  pop.title = 'Pop out this view into its own window';
  pop.append(iconEl('popout'));
  pop.addEventListener('click', () => popOut(tab));
  nav.append(pop);
}

function setTab(id) {
  if (prefs.layout === 'columns' && !popout) { prefs.layout = 'single'; savePrefs(); buildColumns(); }
  tab = id;
  for (const b of $$('.tab')) if (b.dataset.tab) b.setAttribute('aria-selected', String(b.dataset.tab === id));
  if (id in unread) { unread[id] = 0; updateCounts(); }
  columns[0]?.setView(id);
}
on('showView', id => setTab(id));

function updateCounts() {
  for (const k of Object.keys(unread)) {
    const c = $(`.tab[data-tab="${k}"] .count`);
    if (!c) continue;
    c.hidden = !unread[k];
    c.textContent = unread[k] > 99 ? '99+' : String(unread[k]);
  }
}

const split = () => prefs.layout === 'columns' && !popout;

function buildColumns() {
  const box = $('#columns');
  box.replaceChildren();
  columns = [];
  document.body.classList.toggle('split', split());
  if (!split()) {
    const c = new Column(tab);
    columns.push(c);
    box.append(c.root);
  } else {
    if (!prefs.columns?.length) prefs.columns = ['twitch', 'kick'];
    prefs.columns.forEach((v, i) => {
      const c = new Column(v, {
        split: true,
        onChange: nv => { prefs.columns[columns.indexOf(c)] = nv; savePrefs(); },
        onClose: col => removeColumn(col),
        onPopout: view => popOut(view),
      });
      columns.push(c);
      box.append(c.root);
    });
    if (columns.length < 4) {
      const add = el('button', 'col-add');
      add.title = 'Add a column';
      add.append(iconEl('plus'), el('span', null, 'Add column'));
      add.addEventListener('click', () => {
        const unused = VIEWS.find(v => !prefs.columns.includes(v.id))?.id || 'all';
        prefs.columns.push(unused); savePrefs(); buildColumns();
      });
      box.append(add);
    }
  }
  for (const c of columns) c.rebuild();
}

function removeColumn(col) {
  const i = columns.indexOf(col);
  prefs.columns.splice(i, 1);
  if (!prefs.columns.length) { prefs.layout = 'single'; prefs.columns = ['twitch', 'kick']; }
  savePrefs();
  buildColumns();
}
on('layout', () => buildColumns());

function popOut(view) {
  const url = `${location.origin}/app?view=${encodeURIComponent(view)}&popout=1`;
  const w = window.open(url, `streamchat-${view}`, 'popup,width=420,height=760');
  if (!w) toast('Your browser blocked the pop-out window.', 'err');
}

// ---------------------------------------------------------------- events side panel

const sideFeed = $('#sideFeed');
sideFeed.addEventListener('load', () => { sideFeed.scrollTop = sideFeed.scrollHeight; }, true);
function rebuildSide() {
  if ($('#sidePane').hidden) return;
  const side = state.items.filter(i => matches(i, 'side')).slice(-200);
  sideFeed.replaceChildren(...side.map(i => renderItem(i)));
  sideFeed.scrollTop = sideFeed.scrollHeight;
  $('#sideSub').textContent = side.length ? `${side.length}` : '';
}

function rebuildAll() {
  for (const c of columns) c.rebuild();
  rebuildSide();
}

// ---------------------------------------------------------------- incoming items

function addItem(item) {
  state.items.push(item);
  if (state.items.length > MAX_ITEMS) state.items.splice(0, state.items.length - MAX_ITEMS);
  for (const c of columns) c.add(item);
  if (!$('#sidePane').hidden && matches(item, 'side')) {
    const near = sideFeed.scrollHeight - sideFeed.scrollTop - sideFeed.clientHeight < 48;
    sideFeed.append(renderItem(item, true));
    while (sideFeed.childElementCount > 300) sideFeed.firstElementChild.remove();
    if (near) sideFeed.scrollTop = sideFeed.scrollHeight;
  }
  const visible = v => columns.some(c => c.view === v);
  if (item.kind === 'chat' && item.flags?.mention && !visible('mentions')) { unread.mentions++; updateCounts(); }
  if (item.kind === 'chat' && item.flags?.firstMsg && !visible('firsts')) { unread.firsts++; updateCounts(); }
  if (item.kind === 'event' && item.type !== 'like' && !visible('events') && $('#sidePane').hidden) { unread.events++; updateCounts(); }
  if (item.kind === 'chat') rememberUser(item);
  noteItem(item);
}

function markDeleted(fn) {
  for (const it of state.items) if (it.kind === 'chat' && fn(it)) it.deleted = true;
  for (const c of columns) c.markDeleted();
}

// ---------------------------------------------------------------- hover actions & context menu

const colBox = $('#columns');
colBox.addEventListener('mouseover', e => {
  const row = e.target.closest?.('.msg');
  if (!row || row.querySelector(':scope > .actions') || !row._item) return;
  row.append(buildActions(row._item));
});

function actBtn(icon, title, run, cls = '') {
  const b = el('button', cls);
  b.title = title;
  b.setAttribute('aria-label', title);
  b.append(iconEl(icon));
  b.addEventListener('click', e => { e.stopPropagation(); run(); });
  return b;
}

function buildActions(m) {
  const box = el('div', 'actions');
  if (canSend(m.platform)) box.append(actBtn('reply', 'Reply', () => startReply(m)));
  box.append(actBtn('user', 'User info', () => openUserCard(m.platform, m.user)));
  if (canMod(m.platform) && !m.flags?.self && !m.user.broadcaster) {
    if (!m.deleted) box.append(actBtn('trash', 'Delete message', () => mod(m.platform, { type: 'delete', messageId: m.id })));
    box.append(actBtn('clock', 'Timeout 10 minutes', () => mod(m.platform, { type: 'timeout', userId: m.user.id, login: m.user.login, seconds: 600 }, `${m.user.name} timed out for 10 minutes`), 'warn'));
    box.append(actBtn('ban', 'Ban', () => banWithUndo(m.platform, m.user), 'danger'));
  }
  box.append(actBtn('more', 'More', () => { const r = box.getBoundingClientRect(); openMsgMenu(m, { x: r.right - 200, y: r.bottom + 4 }); }));
  return box;
}

colBox.addEventListener('contextmenu', e => {
  const row = e.target.closest('.msg, .event');
  if (!row?._item || e.target.closest('a')) return;
  e.preventDefault();
  if (row._item.kind === 'chat') openMsgMenu(row._item, { x: e.clientX, y: e.clientY });
});

function menuItem(menu, icon, label, run, cls = '') {
  const b = el('button', cls);
  b.type = 'button';
  b.append(iconEl(icon), el('span', null, label));
  b.addEventListener('click', () => { menu.hidePopover(); run(); });
  menu.append(b);
}

function openMsgMenu(m, point) {
  const menu = $('#msgMenu');
  menu.replaceChildren();
  if (canSend(m.platform)) menuItem(menu, 'reply', 'Reply', () => startReply(m));
  menuItem(menu, 'user', `View ${m.viewer?.nick || m.user.name}`, () => openUserCard(m.platform, m.user));
  menuItem(menu, 'copy', 'Copy message', () => copy(m.text));
  menuItem(menu, 'at', 'Mention', () => insertText(`@${m.user.login} `));
  menuItem(menu, 'search', 'Search their messages', () => openSearch({ platform: m.platform, userId: m.user.id, label: m.user.name }));
  if (canMod(m.platform) && !m.flags?.self && !m.user.broadcaster) {
    menu.append(el('hr'));
    if (!m.deleted) menuItem(menu, 'trash', 'Delete message', () => mod(m.platform, { type: 'delete', messageId: m.id }));
    for (const [s, l] of [[60, '1 minute'], [600, '10 minutes'], [3600, '1 hour'], [86400, '1 day']]) {
      menuItem(menu, 'clock', `Timeout ${l}`, () => mod(m.platform, { type: 'timeout', userId: m.user.id, login: m.user.login, seconds: s }, `${m.user.name} timed out for ${l}`));
    }
    menuItem(menu, 'ban', 'Ban', () => banWithUndo(m.platform, m.user), 'danger');
  }
  menu.showPopover();
  placePopover(menu, point);
  menu.querySelector('button')?.focus({ focusVisible: false });
}

$('#msgMenu').addEventListener('keydown', e => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const btns = $$('#msgMenu button');
  const i = btns.indexOf(document.activeElement);
  const n = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : (i + (e.key === 'ArrowUp' ? -1 : 1) + btns.length) % btns.length;
  e.preventDefault();
  btns[n]?.focus();
});

// ---------------------------------------------------------------- status pills

function renderStatus() {
  const box = $('#statusPills');
  box.replaceChildren();
  for (const p of PLATFORMS) {
    const s = state.status[p] || { state: 'off' };
    if (s.state === 'off' && (!s.detail || s.detail === 'Turned off')) continue;
    const b = el('button', 'pill');
    b.role = 'listitem';
    b.dataset.state = s.state;
    b.append(platformEl(p), el('span', 'dot'), el('span', 'pill-name', s.channel || PLATFORM[p].name));
    if (s.live) b.append(el('span', 'live', 'LIVE'));
    b.title = `${PLATFORM[p].name}: ${stateText(s)}${s.detail ? `. ${s.detail}` : ''}`;
    b.addEventListener('click', () => openStatus(p, b));
    box.append(b);
  }
  if (!box.childElementCount) {
    const b = el('button', 'pill');
    b.append(el('span', 'dot'), el('span', null, 'No channels connected. Set up'));
    b.addEventListener('click', () => openSettings('accounts'));
    box.append(b);
  }
}

function stateText(s) {
  return { connected: 'Connected', connecting: 'Connecting…', waiting: 'Waiting for stream', error: 'Needs attention', off: 'Off' }[s.state] || s.state;
}

function openStatus(p, anchor) {
  const pop = $('#statusPop');
  const s = state.status[p];
  const box = el('div', 'status-detail');
  const h = el('h4'); h.append(platformEl(p), el('span', null, PLATFORM[p].name));
  if (s.live) h.append(el('span', 'chip warn', 'LIVE'));
  box.append(h, el('div', 'state', s.detail ? `${stateText(s)}. ${s.detail}` : stateText(s)));
  const kv = el('div', 'kv');
  const add = (k, v) => kv.append(el('span', null, k), el('span', null, v));
  if (s.channel) add('Channel', s.channel);
  add('Signed in', s.loggedInAs || 'No (read-only)');
  add('Send', s.canSend ? 'Yes' : 'No');
  add('Moderate', s.canModerate ? 'Yes' : 'No');
  if (s.live && s.viewers != null) add('Viewers', s.viewers.toLocaleString());
  box.append(kv);
  const row = el('div', 'row');
  const rc = el('button', 'btn sm'); rc.append(iconEl('refresh'), el('span', null, 'Reconnect'));
  rc.addEventListener('click', async () => { pop.hidePopover(); try { await api('POST', '/api/reconnect', { platform: p }); } catch (e) { toast(e.message, 'err'); } });
  const st = el('button', 'btn sm'); st.append(iconEl('settings'), el('span', null, 'Settings'));
  st.addEventListener('click', () => { pop.hidePopover(); openSettings('accounts'); });
  const po = el('button', 'btn sm'); po.append(iconEl('popout'), el('span', null, 'Pop out'));
  po.addEventListener('click', () => { pop.hidePopover(); popOut(p); });
  row.append(rc, st, po);
  box.append(row);
  pop.replaceChildren(box);
  pop.showPopover();
  placePopover(pop, anchor);
}

// ---------------------------------------------------------------- top bar

$('#settingsBtn').addEventListener('click', () => openSettings());
$('#overlayBtn').addEventListener('click', () => openSettings('overlay'));
$('#searchBtn').addEventListener('click', () => openSearch());
$('#viewBtn').addEventListener('click', e => openViewMenu(e.currentTarget));
on('openSettings', s => openSettings(s));

const hideBtn = $('#hideOverlayBtn');
function paintHideBtn() {
  const h = state.overlayHidden;
  hideBtn.setAttribute('aria-pressed', String(h));
  hideBtn.replaceChildren(iconEl(h ? 'eyeOff' : 'eye'));
  hideBtn.title = h ? 'Chat is hidden on stream. Click to show it (Ctrl+Shift+H)' : 'Hide chat on stream (Ctrl+Shift+H)';
  hideBtn.classList.toggle('alert', h);
}
async function toggleOverlay() {
  try {
    const r = await api('POST', '/api/overlay/visibility', { hidden: !state.overlayHidden });
    state.overlayHidden = r.hidden;
    paintHideBtn();
    toast(r.hidden ? 'Chat is hidden on stream' : 'Chat is showing on stream again', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}
hideBtn.addEventListener('click', toggleOverlay);

const sideBtn = $('#sideToggle');
function applySide() {
  $('#sidePane').hidden = !prefs.side || popout;
  sideBtn.setAttribute('aria-pressed', String(prefs.side));
  sideBtn.title = prefs.side ? 'Hide events panel (Ctrl+E)' : 'Show events panel (Ctrl+E)';
  if (prefs.side) { unread.events = 0; updateCounts(); }
}
function toggleSide() { prefs.side = !prefs.side; savePrefs(); applySide(); rebuildSide(); }
sideBtn.addEventListener('click', toggleSide);

let lastLook = JSON.stringify([prefs.timestamps, prefs.badges, prefs.platformIcons, prefs.nicks]);
on('prefs', () => {
  applyLook();
  renderStats();
  const look = JSON.stringify([prefs.timestamps, prefs.badges, prefs.platformIcons, prefs.nicks]);
  if (look !== lastLook) { lastLook = look; rebuildAll(); }
});
on('chatSize', () => { for (const c of columns) if (c.pinned) c.toBottom(); });

// ---------------------------------------------------------------- keyboard

const typing = t => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t?.isContentEditable;
document.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey;
  const input = $('#input');
  // Text size works everywhere, even while typing.
  if (ctrl && !e.shiftKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); setChatSize(prefs.chatSize + 1); return; }
  if (ctrl && !e.shiftKey && (e.key === '-' || e.key === '_')) { e.preventDefault(); setChatSize(prefs.chatSize - 1); return; }
  if (ctrl && !e.shiftKey && e.key === '0') { e.preventDefault(); setChatSize(CHAT_SIZE.def); return; }
  if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); return; }
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 'h') { e.preventDefault(); toggleOverlay(); return; }
  if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'e' && !popout) { e.preventDefault(); toggleSide(); return; }
  if (ctrl && e.key === ',') { e.preventDefault(); openSettings(); return; }
  if (ctrl && e.key === '\\' && !popout) { e.preventDefault(); prefs.layout = split() ? 'single' : 'columns'; savePrefs(); buildColumns(); return; }
  if (ctrl && !e.shiftKey && /^[1-8]$/.test(e.key) && !popout) { e.preventDefault(); setTab(VIEWS[Number(e.key) - 1].id); return; }
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape' && !typing(e.target)) { for (const c of columns) c.goLive(); return; }
  if (typing(e.target)) return;
  if ((e.key === '/' || (ctrl && e.key.toLowerCase() === 'k')) && !input.disabled) { e.preventDefault(); input.focus(); return; }
  if (e.key === '?') { e.preventDefault(); showKeys(); }
});
// Ctrl + mouse wheel over chat changes the text size instead of zooming the page.
colBox.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setChatSize(prefs.chatSize + (e.deltaY < 0 ? 1 : -1));
}, { passive: false });

// ---------------------------------------------------------------- live connection

let wsAttempt = 0;
let wasConnected = false;
let ws = null;
setInterval(() => { if (ws?.readyState === 1) ws.send('ping'); }, 30000);
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?role=app`);
  ws.onopen = () => {
    wsAttempt = 0;
    if (wasConnected) toast('Reconnected to StreamChat', 'ok');
    wasConnected = true;
  };
  ws.onmessage = e => {
    if (e.data === 'pong') return;
    const msg = JSON.parse(e.data);
    switch (msg.op) {
      case 'hello':
        state.status = msg.status;
        state.items = msg.history;
        state.overlayHidden = !!msg.overlayHidden;
        state.users.clear();
        for (const it of state.items) { if (it.kind === 'chat') rememberUser(it); noteItem(it, false); }
        renderStatus(); renderTarget(); rebuildAll(); paintHideBtn(); renderStats();
        break;
      case 'item': addItem(msg.item); break;
      case 'status':
        state.status = msg.status;
        renderStatus(); renderTarget();
        for (const c of columns) if (!c.feed.childElementCount) c.updateEmpty(0);
        emit('status', msg.status);
        break;
      case 'delete': markDeleted(i => i.platform === msg.platform && i.id === msg.id); break;
      case 'clearUser': markDeleted(i => i.platform === msg.platform && i.user.id === msg.userId); break;
      case 'viewer':
        for (const it of state.items) if (it.kind === 'chat' && it.platform === msg.platform && it.user.id === msg.userId) it.viewer = msg.tag;
        for (const c of columns) c.refreshUser(msg.platform, msg.userId);
        break;
      case 'overlayHidden': state.overlayHidden = !!msg.hidden; paintHideBtn(); break;
      case 'settings': refreshState().then(rebuildAll).catch(() => {}); break;
      case 'notice': toast(`${PLATFORM[msg.platform]?.name || msg.platform}: ${msg.text}`); break;
      case 'emotesChanged': emit('emotesChanged'); break;
    }
  };
  ws.onclose = async () => {
    if (wasConnected && wsAttempt === 0) toast('Lost connection to StreamChat. Reconnecting…', 'err');
    const delay = Math.min(10000, 500 * 2 ** wsAttempt++);
    if (wsAttempt > 2) {
      const r = await fetch('/api/state', { credentials: 'same-origin' }).catch(() => null);
      if (r?.status === 401) { location.reload(); return; }
    }
    setTimeout(connect, delay);
  };
}

// ---------------------------------------------------------------- boot

buildTabs();
buildColumns();
applySide();
renderTarget();
renderStats();
on('state', () => { renderTarget(); renderBanners(); });
refreshState().then(() => {
  const s = state.pub;
  const nothingSet = !s.settings.twitch.channel && !s.accounts.twitch && !s.settings.kick.channel && !s.accounts.kick && !s.settings.tiktok.username && !s.settings.youtube.channel;
  if (nothingSet && !popout) openSettings('accounts');
}).catch(e => toast(e.message, 'err'));
connect();
