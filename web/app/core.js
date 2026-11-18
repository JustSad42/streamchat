// Small shared helpers for the app: API calls, state, toasts, icons, preferences.

import { ICONS } from '/shared/icons.js';
import { el, iconEl } from '/shared/render.js';

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => bus.addEventListener(type, e => fn(e.detail));

export const state = {
  pub: null,          // /api/state result: settings, status, keys, accounts, overlayKey
  status: { twitch: { state: 'off' }, kick: { state: 'off' }, tiktok: { state: 'off' } },
  items: [],          // recent chat + events, oldest first
  users: new Map(),   // login -> { name, color, platform } for autocomplete
  overlayHidden: false,
};

export const canMod = p => !!state.status[p]?.canModerate;
export const canSend = p => !!state.status[p]?.canSend;

export async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (r.status === 401) { location.reload(); throw new Error('Signed out'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

export async function refreshState() {
  state.pub = await api('GET', '/api/state');
  state.status = state.pub.status;
  emit('state', state.pub);
  return state.pub;
}

export function hydrateIcons(root = document) {
  for (const e of root.querySelectorAll('[data-icon]')) {
    if (!e.querySelector('svg')) e.insertAdjacentHTML('afterbegin', ICONS[e.dataset.icon] || '');
  }
}

export function toast(text, kind = 'info', action) {
  const box = $('#toasts');
  const t = el('div', `toast ${kind}`);
  t.append(iconEl(kind === 'err' ? 'x' : kind === 'ok' ? 'check' : 'bell'));
  const body = el('div', null, text);
  body.style.flex = '1';
  t.append(body);
  if (action) {
    const b = el('button', 'btn sm', action.label);
    b.addEventListener('click', () => { action.run(); close(); });
    t.append(b);
  }
  box.append(t);
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 260); };
  setTimeout(close, kind === 'err' ? 7000 : action ? 6000 : 3500);
  t.addEventListener('click', e => { if (e.target === t || e.target === body) close(); });
}

const PREF_KEY = 'streamchat.prefs';
export const STAT_KEYS = [
  ['viewers', 'Viewers per platform'], ['total', 'Total viewers'], ['uptime', 'Uptime'],
  ['rate', 'Messages per minute'], ['chatters', 'Active chatters (last 5 min)'], ['firsts', 'First-time chatters today'],
];
export const CHAT_SIZE = { min: 10, max: 48, def: 14 };
const defaults = {
  timestamps: true, side: false, chatSize: CHAT_SIZE.def, target: 'all', badges: true, platformIcons: true,
  msgStyle: 'plain',            // plain | bubbles | striped
  nicks: true,                  // show your nicknames for people
  layout: 'single',             // single | columns
  columns: ['twitch', 'kick', 'tiktok'],
  statsBar: true,
  stats: { viewers: true, total: true, uptime: true, rate: true, chatters: false, firsts: true },
  dismissed: {},                // banners you closed
};
export const prefs = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    return { ...defaults, ...saved, stats: { ...defaults.stats, ...(saved.stats || {}) }, dismissed: { ...(saved.dismissed || {}) } };
  } catch { return structuredClone(defaults); }
})();
prefs.chatSize = Math.min(CHAT_SIZE.max, Math.max(CHAT_SIZE.min, Number(prefs.chatSize) || CHAT_SIZE.def));
export function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
  emit('prefs', prefs);
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied', 'ok'); }
  catch {
    const ta = el('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Copied', 'ok');
  }
}

export function openExternal(url) {
  window.open(url, '_blank', 'noopener');
}

// Light dismiss for <dialog closedby="any"> where the browser lacks it.
export function enableLightDismiss(dialog) {
  if ('closedBy' in HTMLDialogElement.prototype) return;
  dialog.addEventListener('click', e => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = r.top <= e.clientY && e.clientY <= r.bottom && r.left <= e.clientX && e.clientX <= r.right;
    if (!inside) dialog.close();
  });
}

// Place a popover next to an element or point, kept inside the viewport.
export function placePopover(pop, anchor, { prefer = 'below', gap = 6 } = {}) {
  const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const vw = innerWidth, vh = innerHeight;
  let left = Math.min(Math.max(8, rect.left), vw - pw - 8);
  let top = prefer === 'above' ? rect.top - ph - gap : rect.bottom + gap;
  if (prefer === 'above' && top < 8) top = rect.bottom + gap;
  if (prefer !== 'above' && top + ph > vh - 8) top = Math.max(8, rect.top - ph - gap);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}
