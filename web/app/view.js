// Stats bar, the View menu (text size, message style, layout, stats), the keyboard-shortcut list,
// and banners (updates, Twitch needing a fresh sign-in).

import { el, iconEl, platformEl } from '/shared/render.js';
import { PLATFORM } from '/shared/icons.js';
import { $, api, state, prefs, savePrefs, toast, on, emit, placePopover, enableLightDismiss, STAT_KEYS, CHAT_SIZE } from './core.js';

const PLATFORMS = ['twitch', 'kick', 'tiktok'];

// ---------------------------------------------------------------- text size & message style

export function applyLook() {
  document.documentElement.style.setProperty('--chat-size', `${prefs.chatSize}px`);
  document.body.dataset.msgStyle = prefs.msgStyle;
}

export function setChatSize(v, { quiet = false } = {}) {
  const n = Math.min(CHAT_SIZE.max, Math.max(CHAT_SIZE.min, Math.round(v)));
  if (n === prefs.chatSize) return;
  prefs.chatSize = n;
  applyLook();
  clearTimeout(setChatSize._t);
  setChatSize._t = setTimeout(savePrefs, 200);
  if (!quiet) sizeToast(n);
  emit('chatSize', n);
}
let sizeT = null;
function sizeToast(n) {
  let t = $('#sizeToast');
  if (!t) { t = el('div', 'size-toast'); t.id = 'sizeToast'; document.body.append(t); }
  t.textContent = `Text size ${n}px`;
  t.classList.add('show');
  clearTimeout(sizeT);
  sizeT = setTimeout(() => t.classList.remove('show'), 900);
}

// ---------------------------------------------------------------- stats bar

const rate = [];       // timestamps of chat messages in the last minute
const active = new Map(); // platform:userId -> last message time
let firstsToday = 0;
let firstsDay = new Date().toDateString();

export function noteItem(item, live = true) {
  if (item.kind !== 'chat') return;
  const now = Date.now();
  if (live || now - item.ts < 60_000) rate.push(item.ts || now);
  if (now - item.ts < 300_000) active.set(`${item.platform}:${item.user.id}`, item.ts);
  if (item.flags?.firstMsg && new Date(item.ts).toDateString() === new Date().toDateString()) {
    if (firstsDay !== new Date().toDateString()) { firstsDay = new Date().toDateString(); firstsToday = 0; }
    firstsToday++;
  }
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
const fmtNum = n => n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : n.toLocaleString();

function stat(icon, label, value, title, cls = '') {
  const s = el('div', `stat ${cls}`);
  if (typeof icon === 'string') s.append(iconEl(icon)); else s.append(icon);
  s.append(el('b', null, value));
  if (label) s.append(el('span', null, label));
  s.title = title || label;
  return s;
}

export function renderStats() {
  const bar = $('#stats');
  const show = prefs.statsBar && Object.values(prefs.stats).some(Boolean);
  bar.hidden = !show;
  if (!show) return;
  const now = Date.now();
  while (rate.length && now - rate[0] > 60_000) rate.shift();
  for (const [k, t] of active) if (now - t > 300_000) active.delete(k);
  const st = state.status;
  const parts = [];
  if (prefs.stats.viewers) {
    for (const p of PLATFORMS) {
      const s = st[p];
      if (!s || s.state === 'off') continue;
      const live = !!s.live;
      const v = live ? (s.viewers != null ? fmtNum(s.viewers) : 'LIVE') : 'offline';
      parts.push(stat(platformEl(p), null, v, `${PLATFORM[p].name}: ${live ? (s.viewers != null ? `${s.viewers.toLocaleString()} watching` : 'live') : 'not live'}`, live ? 'live' : 'off'));
    }
  }
  const lives = PLATFORMS.filter(p => st[p]?.live);
  if (prefs.stats.total) {
    const total = lives.reduce((a, p) => a + (st[p].viewers || 0), 0);
    parts.push(stat('users', 'viewers', lives.length ? fmtNum(total) : '–', 'Total viewers across platforms'));
  }
  if (prefs.stats.uptime) {
    const starts = lives.map(p => st[p].startedAt).filter(Boolean);
    parts.push(stat('clock', null, starts.length ? fmtUptime(now - Math.min(...starts)) : 'offline', 'Stream uptime (earliest platform)'));
  }
  if (prefs.stats.rate) parts.push(stat('activity', 'msg/min', String(rate.length), 'Chat messages in the last minute'));
  if (prefs.stats.chatters) parts.push(stat('user', 'chatting', String(active.size), 'People who chatted in the last 5 minutes'));
  if (prefs.stats.firsts) {
    const f = stat('sprout', 'new today', String(firstsToday), 'First-time chatters today. Click to see them.', 'clickable');
    f.addEventListener('click', () => emit('showView', 'firsts'));
    parts.push(f);
  }
  const hide = el('button', 'icon-btn sm stats-hide');
  hide.append(iconEl('x'));
  hide.title = 'Hide the stats bar (turn it back on from the View menu)';
  hide.addEventListener('click', () => { prefs.statsBar = false; savePrefs(); renderStats(); toast('Stats bar hidden. Turn it back on from the View menu (Aa button).'); });
  bar.replaceChildren(...parts, hide);
}
setInterval(() => { if (!$('#stats').hidden) renderStats(); }, 1000);
on('status', renderStats);

// ---------------------------------------------------------------- View menu

const viewPop = $('#viewPop');
export function openViewMenu(anchor) {
  if (viewPop.matches(':popover-open')) { viewPop.hidePopover(); return; }
  drawViewMenu();
  viewPop.showPopover();
  placePopover(viewPop, anchor);
}

function seg(options, value, onPick) {
  const s = el('div', 'seg');
  for (const [v, label, icon] of options) {
    const b = el('button');
    b.type = 'button';
    if (icon) b.append(iconEl(icon));
    b.append(el('span', null, label));
    b.setAttribute('aria-pressed', String(v === value));
    b.addEventListener('click', () => { for (const x of s.children) x.setAttribute('aria-pressed', String(x === b)); onPick(v); });
    s.append(b);
  }
  return s;
}

function sw(label, checked, onChange) {
  const row = el('label', 'vp-switch');
  const i = el('input', 'switch');
  i.type = 'checkbox';
  i.checked = !!checked;
  i.addEventListener('change', () => onChange(i.checked));
  row.append(el('span', null, label), i);
  return row;
}

function drawViewMenu() {
  viewPop.replaceChildren();
  const box = el('div', 'vp');
  box.append(el('div', 'vp-title', 'Text size'));
  const sizeRow = el('div', 'vp-size');
  const minus = el('button', 'icon-btn sm'); minus.append(iconEl('minus')); minus.title = 'Smaller (Ctrl −)';
  const plus = el('button', 'icon-btn sm'); plus.append(iconEl('plus')); plus.title = 'Bigger (Ctrl +)';
  const range = el('input');
  range.type = 'range'; range.min = CHAT_SIZE.min; range.max = CHAT_SIZE.max; range.value = prefs.chatSize;
  range.setAttribute('aria-label', 'Text size');
  const out = el('output', null, `${prefs.chatSize}px`);
  const sync = () => { range.value = prefs.chatSize; out.textContent = `${prefs.chatSize}px`; };
  range.addEventListener('input', () => { setChatSize(Number(range.value), { quiet: true }); out.textContent = `${prefs.chatSize}px`; });
  minus.addEventListener('click', () => { setChatSize(prefs.chatSize - 1, { quiet: true }); sync(); });
  plus.addEventListener('click', () => { setChatSize(prefs.chatSize + 1, { quiet: true }); sync(); });
  sizeRow.append(minus, range, plus, out);
  box.append(sizeRow);
  const presets = el('div', 'vp-presets');
  for (const [n, l] of [[12, 'S'], [14, 'M'], [18, 'L'], [24, 'XL'], [32, 'XXL'], [44, 'Huge']]) {
    const b = el('button', 'chip-btn', l);
    b.title = `${n}px`;
    b.addEventListener('click', () => { setChatSize(n, { quiet: true }); sync(); });
    presets.append(b);
  }
  box.append(presets);

  box.append(el('div', 'vp-title', 'Message background'));
  box.append(seg([['plain', 'None'], ['bubbles', 'Dark bubbles'], ['striped', 'Striped']], prefs.msgStyle, v => { prefs.msgStyle = v; savePrefs(); applyLook(); }));

  box.append(el('div', 'vp-title', 'Layout'));
  box.append(seg([['single', 'One feed', 'type'], ['columns', 'Columns', 'columns']], prefs.layout, v => { prefs.layout = v; savePrefs(); emit('layout'); }));

  box.append(el('div', 'vp-title', 'Show'));
  box.append(
    sw('Stats bar', prefs.statsBar, v => { prefs.statsBar = v; savePrefs(); renderStats(); drawViewMenu(); }),
  );
  if (prefs.statsBar) {
    const grid = el('div', 'vp-stats');
    for (const [k, label] of STAT_KEYS) {
      const l = el('label', 'mini');
      const c = el('input'); c.type = 'checkbox'; c.checked = !!prefs.stats[k];
      c.addEventListener('change', () => { prefs.stats[k] = c.checked; savePrefs(); renderStats(); });
      l.append(c, label);
      grid.append(l);
    }
    box.append(grid);
  }
  box.append(
    sw('Timestamps', prefs.timestamps, v => { prefs.timestamps = v; savePrefs(); }),
    sw('Your nicknames for people', prefs.nicks, v => { prefs.nicks = v; savePrefs(); }),
  );

  const foot = el('div', 'vp-foot');
  const clear = el('button', 'btn sm'); clear.append(iconEl('broom'), el('span', null, 'Clear stream chat'));
  clear.title = 'Removes the messages currently shown in the OBS chat overlay';
  clear.addEventListener('click', async () => { try { await api('POST', '/api/overlay/clear', {}); toast('Cleared the chat on stream', 'ok'); } catch (e) { toast(e.message, 'err'); } });
  const keys = el('button', 'btn sm'); keys.append(iconEl('keyboard'), el('span', null, 'Shortcuts'));
  keys.addEventListener('click', () => { viewPop.hidePopover(); showKeys(); });
  foot.append(clear, keys);
  box.append(foot);
  viewPop.append(box);
}

// ---------------------------------------------------------------- shortcuts + commands list

const keysDlg = $('#keysDlg');
enableLightDismiss(keysDlg);
export const SHORTCUTS = [
  ['Ctrl + 1 … 7', 'Switch tab (All, Twitch, Kick, TikTok, Mentions, First-timers, Events)'],
  ['Ctrl + F', 'Search chat history'],
  ['Ctrl + K  or  /', 'Type a message'],
  ['Esc', 'Cancel reply · clear the box · back to live chat'],
  ['Ctrl + =  /  Ctrl + −', 'Bigger / smaller text (also Ctrl + mouse wheel)'],
  ['Ctrl + 0', 'Normal text size'],
  ['Ctrl + Shift + H', 'Hide / show chat on stream'],
  ['Ctrl + E', 'Events panel'],
  ['Ctrl + \\', 'One feed / columns'],
  ['Ctrl + ,', 'Settings'],
  ['?', 'This list'],
];

export function showKeys(focus) {
  keysDlg.replaceChildren();
  const head = el('div', 'kd-head');
  const h = el('h2', null, 'Keyboard shortcuts & commands'); h.id = 'keysTitle';
  const x = el('button', 'icon-btn'); x.append(iconEl('x')); x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', () => keysDlg.close());
  head.append(h, x);
  const body = el('div', 'kd-body');
  const t = el('div', 'kd-grid');
  for (const [k, d] of SHORTCUTS) {
    const keys = el('span', 'kd-keys');
    for (const part of k.split(/(\s+\+\s+|\s+…\s+|\s+\/\s+|\s+or\s+)/)) {
      if (/^\s+(\+|…|\/|or)\s+$/.test(part)) keys.append(el('span', 'kd-sep', part.trim()));
      else if (part) keys.append(el('kbd', null, part));
    }
    t.append(keys, el('span', null, d));
  }
  body.append(el('h3', null, 'Shortcuts'), t);
  const cmds = el('div', 'kd-grid kd-cmds');
  for (const c of state.pub?.commands || []) {
    const pf = el('span', 'cmd-pf');
    for (const p of c.platforms) pf.append(platformEl(p));
    const d = el('span'); d.append(c.desc, pf);
    cmds.append(el('code', null, c.usage), d);
  }
  const ch = el('h3', null, 'Commands');
  body.append(ch, el('p', 'help', 'Type them in the message box. They run on the platform you are sending to; with "All" they run on every platform that supports them. Start with // to send a message that begins with /.'), cmds);
  keysDlg.append(head, body);
  if (!keysDlg.open) keysDlg.showModal();
  if (focus === 'commands') ch.scrollIntoView();
}
on('showKeys', showKeys);

// ---------------------------------------------------------------- banners

let desktopUpdate = null;
// The desktop app tells the page about its own updates (it can't be checked from here).
window.addEventListener('streamchat-update', e => { desktopUpdate = e.detail; renderBanners(); });
if (window.__streamchatUpdate) desktopUpdate = window.__streamchatUpdate;

function banner(id, icon, text, actions, kind = '') {
  if (prefs.dismissed[id]) return null;
  const b = el('div', `banner ${kind}`);
  b.append(iconEl(icon), el('div', 'banner-text', text));
  for (const [label, run, cls] of actions) {
    const btn = el('button', `btn sm ${cls || ''}`, label);
    btn.addEventListener('click', run);
    b.append(btn);
  }
  const x = el('button', 'icon-btn sm'); x.append(iconEl('x')); x.title = 'Dismiss';
  x.addEventListener('click', () => { prefs.dismissed[id] = Date.now(); savePrefs(); renderBanners(); });
  b.append(x);
  return b;
}

export function renderBanners() {
  const box = $('#banners');
  const out = [];
  const pub = state.pub;
  if (desktopUpdate?.version) {
    out.push(banner(`desk-${desktopUpdate.version}`, 'download', `StreamChat ${desktopUpdate.version} is ready to install.`, [
      ['Update now', () => { location.href = 'http://tauri.localhost/index.html?update=1'; }, 'primary'],
      ['What\'s new', () => window.open(`https://github.com/JustSad42/streamchat/releases/tag/v${desktopUpdate.version}`, '_blank')],
    ], 'info'));
  }
  const u = pub?.update;
  if (u?.available && u.via !== 'desktop') {
    const how = u.via === 'script' ? 'It installs itself tonight, or run "sudo streamchat update" on the server now.' : 'Update the server to get it.';
    out.push(banner(`srv-${u.latest}`, 'download', `Server update ${u.latest} is available. ${how}`, [
      ['What\'s new', () => window.open(u.url, '_blank')],
    ], 'info'));
  }
  if (pub?.accounts?.twitch && pub.twitchMissingScopes?.length) {
    out.push(banner(`scopes-${pub.twitchMissingScopes.join(',')}`, 'key', 'Sign in to Twitch again to turn on the new commands (/slow, /shoutout, /raid, /mod and more).', [
      ['Open Twitch settings', () => emit('openSettings', 'accounts'), 'twitch'],
    ]));
  }
  box.replaceChildren(...out.filter(Boolean));
}
on('state', renderBanners);
