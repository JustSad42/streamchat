// The message box: where to send (All / Twitch / Kick), replies, slash commands, Tab completion
// for emotes, people and commands, sent-message history, and the emote picker.

import { el, iconEl, platformEl, readableColor } from '/shared/render.js';
import { PLATFORM } from '/shared/icons.js';
import { $, api, state, toast, prefs, savePrefs, on, emit, placePopover, canSend } from './core.js';

const input = $('#input');
let target = prefs.target;
let replyTo = null;
const sent = [];
let histIdx = -1;

const sendable = () => ['twitch', 'kick'].filter(canSend);
export const composerTarget = () => (replyTo ? replyTo.platform : target);

/** In a pop-out window for one platform, send there by default. */
export function lockTarget(platform) {
  if (['twitch', 'kick'].includes(platform)) target = platform;
}

export function renderTarget() {
  const box = $('#target');
  box.replaceChildren();
  const avail = sendable();
  if (replyTo) target = replyTo.platform;
  else if (target !== 'all' && !avail.includes(target)) target = avail.length > 1 ? 'all' : avail[0] || 'all';
  for (const [id, label] of [['all', 'All'], ['twitch', 'Twitch'], ['kick', 'Kick']]) {
    const b = el('button');
    b.type = 'button';
    b.role = 'radio';
    b.setAttribute('aria-checked', String(target === id));
    b.disabled = id === 'all' ? avail.length < 1 || !!replyTo : !avail.includes(id) || (!!replyTo && replyTo.platform !== id);
    b.append(id === 'all' ? iconEl('zap') : platformEl(id), el('span', 'lbl', label));
    b.title = id === 'all' ? `Send to every platform you're signed in to (${avail.map(p => PLATFORM[p].name).join(', ') || 'none'})` : `Send to ${label}`;
    b.addEventListener('click', () => { target = id; prefs.target = id; savePrefs(); renderTarget(); input.focus(); });
    box.append(b);
  }
  const none = !avail.length;
  input.disabled = none;
  $('#sendBtn').disabled = none;
  $('#emoteBtn').disabled = none;
  input.placeholder = none ? 'Sign in to Twitch or Kick in Settings to chat'
    : (target === 'all' ? `Send to ${avail.map(p => PLATFORM[p].name).join(' + ')}` : `Send to ${PLATFORM[target].name}`) + '  ·  / for commands';
}

export function startReply(m) {
  replyTo = m;
  const chip = $('#replyChip');
  chip.replaceChildren();
  const t = el('div', 'txt');
  t.append('Replying to ', el('b', null, m.user.name), `: ${m.text}`);
  const x = el('button'); x.append(iconEl('x')); x.setAttribute('aria-label', 'Cancel reply');
  x.addEventListener('click', cancelReply);
  chip.append(iconEl('reply'), t, x);
  chip.hidden = false;
  renderTarget();
  input.focus();
}

export function cancelReply() {
  if (!replyTo) return false;
  replyTo = null;
  $('#replyChip').hidden = true;
  target = prefs.target;
  renderTarget();
  return true;
}

export function insertText(text) {
  const s = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, s);
  const pad = before && !/\s$/.test(before) ? ' ' : '';
  input.value = before + pad + text + input.value.slice(input.selectionEnd ?? s);
  const pos = (before + pad + text).length;
  input.focus();
  input.setSelectionRange(pos, pos);
}
on('insert', insertText);
on('reply', startReply);

async function send() {
  let text = input.value.trim();
  if (!text) return;
  const btn = $('#sendBtn');
  btn.classList.add('busy');
  try {
    const platform = composerTarget();
    if (text.startsWith('/') && !text.startsWith('//')) {
      await runCommand(platform, text);
    } else {
      if (text.startsWith('//')) text = text.slice(1); // "//" sends a message that starts with "/"
      const r = await api('POST', '/api/send', { platform, text, replyTo: replyTo?.id });
      for (const err of r.errors || []) toast(err, 'err');
    }
    sent.push(input.value.trim());
    if (sent.length > 50) sent.shift();
    histIdx = -1;
    input.value = '';
    closeSuggest();
    cancelReply();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.classList.remove('busy');
  }
}

async function runCommand(platform, text) {
  const r = await api('POST', '/api/command', { platform, text });
  if (r.help) { emit('showKeys', 'commands'); return; }
  const multi = r.results.length > 1;
  for (const x of r.results) {
    const msg = x.message || 'Done';
    if (x.ok && !x.message) continue;
    toast(multi ? `${PLATFORM[x.platform].name}: ${msg}` : msg, x.ok ? 'ok' : 'err');
  }
}

$('#sendBtn').addEventListener('click', send);

// ---------------------------------------------------------------- autocomplete

export function rememberUser(m) {
  const users = state.users;
  users.delete(m.user.login);
  users.set(m.user.login, { name: m.user.name, color: m.user.color, platform: m.platform });
  if (users.size > 3000) users.delete(users.keys().next().value);
}

const emoteCache = new Map();
async function emotesFor(platform) {
  if (!emoteCache.has(platform)) emoteCache.set(platform, api('GET', `/api/emotes?platform=${platform}`).then(r => r.emotes).catch(() => []));
  return emoteCache.get(platform);
}
on('emotesChanged', () => emoteCache.clear());

let sugg = { open: false, list: [], idx: 0, start: 0, end: 0, navigated: false };
const suggestBox = $('#suggest');

function currentWord() {
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const m = /(\S+)$/.exec(before);
  if (!m) return null;
  return { word: m[1], start: pos - m[1].length, end: pos };
}

async function updateSuggest() {
  const w = currentWord();
  if (!w) return closeSuggest();
  const list = [];
  const platform = composerTarget() === 'all' ? (sendable()[0] || 'twitch') : composerTarget();
  // Slash commands: only as the first word.
  if (w.start === 0 && w.word.startsWith('/') && !w.word.startsWith('//')) {
    const q = w.word.slice(1).toLowerCase();
    const targets = composerTarget() === 'all' ? sendable() : [composerTarget()];
    for (const c of state.pub?.commands || []) {
      const names = [c.name, ...(c.aliases || [])];
      if (!names.some(n => n.startsWith(q))) continue;
      const usable = c.platforms.some(p => targets.includes(p));
      list.push({ kind: 'cmd', value: `/${c.name}`, c, usable });
    }
    list.sort((a, b) => Number(b.usable) - Number(a.usable));
    if (!list.length) return closeSuggest();
    sugg = { open: true, list: list.slice(0, 30), idx: 0, start: w.start, end: w.end, navigated: false };
    return drawSuggest();
  }
  if ((w.word.length < 2 && !w.word.startsWith('@')) || w.word === '@') return closeSuggest();
  const isUser = w.word.startsWith('@');
  const q = (isUser ? w.word.slice(1) : w.word).toLowerCase();
  if (!isUser) {
    const all = await emotesFor(platform);
    const starts = [], contains = [];
    for (const e of all) {
      const n = e.name.toLowerCase();
      if (n.startsWith(q)) starts.push(e); else if (q.length >= 3 && n.includes(q)) contains.push(e);
      if (starts.length > 40) break;
    }
    for (const e of [...starts, ...contains].slice(0, 30)) list.push({ kind: 'emote', value: e.name, e });
  }
  for (const [login, u] of [...state.users.entries()].reverse()) {
    if (list.length >= 40) break;
    if (login.startsWith(q) || u.name.toLowerCase().startsWith(q)) list.push({ kind: 'user', value: `@${u.name}`, u });
  }
  const cw = currentWord();
  if (!cw || cw.word !== w.word) return; // input changed while loading
  if (!list.length) return closeSuggest();
  sugg = { open: true, list, idx: 0, start: w.start, end: w.end, navigated: false };
  drawSuggest();
}

function drawSuggest() {
  suggestBox.replaceChildren();
  sugg.list.forEach((s, i) => {
    const o = el('div', 'opt');
    o.role = 'option';
    o.setAttribute('aria-selected', String(i === sugg.idx));
    if (s.kind === 'emote') {
      const img = document.createElement('img'); img.src = s.e.url; img.alt = '';
      o.append(img, el('span', null, s.e.name), el('span', 'src', { '7tv': '7TV', ffz: 'FFZ', bttv: 'BTTV', twitch: 'Twitch', kick: 'Kick' }[s.e.src] || s.e.src));
    } else if (s.kind === 'cmd') {
      o.classList.add('cmd');
      if (!s.usable) o.classList.add('unusable');
      const pf = el('span', 'cmd-pf');
      for (const p of s.c.platforms) pf.append(platformEl(p));
      o.append(el('code', null, s.c.usage), el('span', 'cmd-desc', s.c.desc), pf);
    } else {
      const av = el('span', 'av', s.u.name.slice(0, 1).toUpperCase());
      av.style.color = readableColor(s.u.color) || '';
      o.append(av, el('span', null, s.u.name), el('span', 'src', PLATFORM[s.u.platform]?.name));
    }
    o.addEventListener('mousedown', e => { e.preventDefault(); sugg.idx = i; acceptSuggest(); });
    suggestBox.append(o);
  });
  suggestBox.hidden = false;
  suggestBox.children[sugg.idx]?.scrollIntoView({ block: 'nearest' });
}

function acceptSuggest() {
  const s = sugg.list[sugg.idx];
  if (!s) return;
  const v = input.value;
  const after = v.slice(sugg.end);
  const insert = s.value + (after.startsWith(' ') ? '' : ' ');
  input.value = v.slice(0, sugg.start) + insert + after;
  const pos = sugg.start + insert.length;
  input.setSelectionRange(pos, pos);
  closeSuggest();
}

export function closeSuggest() {
  const was = sugg.open;
  sugg.open = false;
  suggestBox.hidden = true;
  return was;
}

input.addEventListener('input', () => { histIdx = -1; updateSuggest(); });
input.addEventListener('blur', () => setTimeout(closeSuggest, 120));
input.addEventListener('keydown', e => {
  if (sugg.open) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sugg.idx = (sugg.idx + (e.key === 'ArrowUp' ? -1 : 1) + sugg.list.length) % sugg.list.length;
      sugg.navigated = true;
      drawSuggest();
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && sugg.navigated)) { e.preventDefault(); acceptSuggest(); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeSuggest(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); return; }
  if (e.key === 'Escape') {
    if (cancelReply()) { e.preventDefault(); return; }
    if (input.value) { input.value = ''; e.preventDefault(); return; }
    input.blur();
    return;
  }
  if (e.key === 'ArrowUp' && sent.length && (input.value === '' || histIdx >= 0)) {
    e.preventDefault();
    histIdx = histIdx < 0 ? sent.length - 1 : Math.max(0, histIdx - 1);
    input.value = sent[histIdx];
  } else if (e.key === 'ArrowDown' && histIdx >= 0) {
    e.preventDefault();
    histIdx++;
    if (histIdx >= sent.length) { histIdx = -1; input.value = ''; } else input.value = sent[histIdx];
  }
});

// ---------------------------------------------------------------- emote picker

const emotePop = $('#emotePop');
$('#emoteBtn').addEventListener('click', async () => {
  if (emotePop.matches(':popover-open')) { emotePop.hidePopover(); return; }
  emotePop.showPopover();
  placePopover(emotePop, $('#emoteBtn'), { prefer: 'above' });
  $('#emoteSearch').value = '';
  await drawEmoteGrid('');
  $('#emoteSearch').focus();
});
$('#emoteSearch').addEventListener('input', e => drawEmoteGrid(e.target.value));

async function drawEmoteGrid(q) {
  const platform = composerTarget() === 'all' ? (sendable()[0] || 'twitch') : composerTarget();
  const all = await emotesFor(platform);
  q = q.toLowerCase();
  const groups = new Map();
  for (const e of all) {
    if (q && !e.name.toLowerCase().includes(q)) continue;
    const g = { twitch: 'Your Twitch emotes', '7tv': '7TV', bttv: 'BetterTTV', ffz: 'FrankerFaceZ', kick: 'Kick' }[e.src] || e.src;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const grid = $('#emoteGrid');
  grid.replaceChildren();
  if (!groups.size) { grid.append(el('h5', null, q ? 'No matches' : 'No emotes loaded for this platform')); return; }
  for (const [g, list] of groups) {
    grid.append(el('h5', null, `${g} · ${list.length}`));
    for (const e of list.slice(0, 400)) {
      const b = el('button');
      b.type = 'button';
      b.title = e.name;
      const img = document.createElement('img'); img.src = e.url; img.alt = e.name; img.loading = 'lazy';
      b.append(img);
      b.addEventListener('click', () => insertText(`${e.name} `));
      grid.append(b);
    }
  }
}
