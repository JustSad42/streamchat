// Search past chat (saved to disk by the server): words, person, platform and time range.

import { chatEl, eventEl, el, iconEl, platformEl } from '/shared/render.js';
import { PLATFORM } from '/shared/icons.js';
import { $, api, enableLightDismiss, prefs, emit, on } from './core.js';

const dlg = $('#searchDlg');
enableLightDismiss(dlg);
let built = false;
let f = {};          // form controls
let userFilter = null; // { platform, userId, label } from a user card
let reqId = 0;

on('search', opts => openSearch(opts));

export function openSearch(opts = {}) {
  if (!built) build();
  userFilter = opts.userId ? opts : null;
  drawUserChip();
  if (opts.q != null) f.q.value = opts.q;
  if (!dlg.open) dlg.showModal();
  f.q.focus();
  f.q.select();
  run();
}

function build() {
  built = true;
  const head = el('div', 'sd-head');
  const box = el('div', 'sd-searchbox');
  f.q = el('input');
  f.q.type = 'search';
  f.q.placeholder = 'Search messages';
  f.q.setAttribute('aria-label', 'Words to search for');
  box.append(iconEl('search'), f.q);
  const close = el('button', 'icon-btn'); close.append(iconEl('x')); close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => dlg.close());
  head.append(box, close);

  const filters = el('div', 'sd-filters');
  f.user = el('input', 'inp');
  f.user.placeholder = 'From (name or nickname)';
  f.user.setAttribute('aria-label', 'From');
  f.platform = sel([['', 'All platforms'], ['twitch', 'Twitch'], ['kick', 'Kick'], ['tiktok', 'TikTok'], ['youtube', 'YouTube']], 'Platform');
  f.days = sel([['1', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['0', 'Everything']], 'Time range');
  f.days.value = '7';
  f.kind = sel([['chat', 'Messages'], ['events', 'Events'], ['all', 'Both']], 'Show');
  f.userChip = el('div', 'sd-userchip');
  filters.append(f.userChip, f.user, f.platform, f.days, f.kind);

  f.summary = el('div', 'sd-summary');
  f.results = el('div', 'sd-results feed');
  f.more = el('button', 'btn sm sd-more', 'Load older results');
  f.more.hidden = true;
  f.more.addEventListener('click', () => run(true));
  dlg.append(head, filters, f.summary, f.results, f.more);

  let t = null;
  const later = () => { clearTimeout(t); t = setTimeout(() => run(), 280); };
  f.q.addEventListener('input', later);
  f.user.addEventListener('input', later);
  for (const s of [f.platform, f.days, f.kind]) s.addEventListener('change', () => run());
}

function sel(options, label) {
  const s = el('select', 'inp');
  s.setAttribute('aria-label', label);
  for (const [v, l] of options) { const o = el('option', null, l); o.value = v; s.append(o); }
  return s;
}

function drawUserChip() {
  f.userChip.replaceChildren();
  f.userChip.hidden = !userFilter;
  f.user.hidden = !!userFilter;
  if (!userFilter) return;
  f.userChip.append(platformEl(userFilter.platform), el('span', null, userFilter.label));
  const x = el('button'); x.append(iconEl('x')); x.setAttribute('aria-label', 'Search everyone');
  x.addEventListener('click', () => { userFilter = null; drawUserChip(); run(); });
  f.userChip.append(x);
}

let oldest = 0;
async function run(more = false) {
  const id = ++reqId;
  const p = new URLSearchParams({ q: f.q.value.trim(), kind: f.kind.value, days: f.days.value, limit: '150' });
  if (userFilter) { p.set('userId', userFilter.userId); p.set('platform', userFilter.platform); }
  else { if (f.user.value.trim()) p.set('user', f.user.value.trim()); if (f.platform.value) p.set('platform', f.platform.value); }
  if (more && oldest) p.set('before', String(oldest));
  if (!more) { f.summary.textContent = 'Searching…'; }
  try {
    const r = await api('GET', `/api/search?${p}`);
    if (id !== reqId) return;
    if (!more) f.results.replaceChildren();
    // Results come newest first; show them grouped by day, newest day on top.
    let lastDay = more ? f.results.lastElementChild?.dataset?.day : '';
    const opts = {
      timestamps: true, badges: prefs.badges, platformIcon: true, nicks: prefs.nicks, darkBg: true,
      onUser: m => { emit('userCard', { platform: m.platform, user: m.user }); },
    };
    for (const it of r.results) {
      const day = new Date(it.ts).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      if (day !== lastDay) { const h = el('div', 'sd-day', day); h.dataset.day = day; f.results.append(h); lastDay = day; }
      const node = it.kind === 'chat' ? chatEl(it, opts) : eventEl(it, opts);
      node.dataset.day = day;
      if (f.q.value.trim()) highlight(node, f.q.value.trim());
      f.results.append(node);
    }
    if (r.results.length) oldest = r.results.at(-1).ts;
    f.more.hidden = !r.more;
    const total = f.results.querySelectorAll('.msg, .event').length;
    const range = { 1: 'today', 7: 'in the last 7 days', 30: 'in the last 30 days', 0: 'in everything saved' }[f.days.value];
    f.summary.textContent = total ? `${total}${r.more ? '+' : ''} result${total === 1 ? '' : 's'} ${range}` : `Nothing found ${range}.`;
    if (!total && f.days.value !== '0') {
      const b = el('button', 'linkish', 'Search everything');
      b.addEventListener('click', () => { f.days.value = '0'; run(); });
      f.summary.append(' ', b);
    }
  } catch (e) {
    if (id === reqId) f.summary.textContent = e.message;
  }
}

// Mark the matching words in a result (text nodes only, never touching markup).
function highlight(node, q) {
  const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return;
  const body = node.querySelector('.body');
  if (!body) return;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const t of texts) {
    const s = t.nodeValue;
    const lower = s.toLowerCase();
    let i = 0;
    const frag = document.createDocumentFragment();
    let changed = false;
    while (i < s.length) {
      let best = -1, len = 0;
      for (const w of words) { const at = lower.indexOf(w, i); if (at >= 0 && (best < 0 || at < best)) { best = at; len = w.length; } }
      if (best < 0) break;
      frag.append(s.slice(i, best), el('mark', null, s.slice(best, best + len)));
      i = best + len;
      changed = true;
    }
    if (changed) { frag.append(s.slice(i)); t.replaceWith(frag); }
  }
}
