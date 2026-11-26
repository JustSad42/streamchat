// A chat column: one scrolling feed showing one view (All, Twitch, Mentions, …), with
// Chatterino-style hover pause and a "jump to live" pill. The app shows one column, or several
// side by side in Columns layout.

import { chatEl, eventEl, el, iconEl } from '/shared/render.js';
import { PLATFORM } from '/shared/icons.js';
import { state, prefs, emit } from './core.js';

const PLATFORMS = ['twitch', 'kick', 'tiktok', 'youtube'];
const MAX_NODES = 600;

export const VIEWS = [
  { id: 'all', label: 'All' },
  { id: 'twitch', label: 'Twitch', pf: 'twitch' },
  { id: 'kick', label: 'Kick', pf: 'kick' },
  { id: 'tiktok', label: 'TikTok', pf: 'tiktok' },
  { id: 'youtube', label: 'YouTube', pf: 'youtube' },
  { id: 'mentions', label: 'Mentions', icon: 'at' },
  { id: 'firsts', label: 'First-timers', icon: 'sprout' },
  { id: 'events', label: 'Events', icon: 'zap' },
];
export const viewLabel = id => VIEWS.find(v => v.id === id)?.label || id;

const NOISY = new Set(['like']);
export function matches(item, view) {
  if (item.kind === 'chat' && item.flags?.blocked && state.pub?.settings?.filters?.hideInApp) return false;
  switch (view) {
    case 'all': return !(item.kind === 'event' && NOISY.has(item.type));
    case 'mentions': return item.kind === 'chat' && !!item.flags?.mention;
    case 'firsts': return item.kind === 'chat' && !!item.flags?.firstMsg;
    case 'events': return item.kind === 'event';
    case 'side': return item.kind === 'event' && !['ban', 'timeout'].includes(item.type);
    default: return item.platform === view && !(item.kind === 'event' && NOISY.has(item.type));
  }
}

const selfNames = () => {
  const a = state.pub?.accounts || {};
  return [a.twitch, a.kick, state.pub?.settings?.tiktok?.username].filter(Boolean).map(s => s.toLowerCase());
};

export function renderOpts() {
  return {
    timestamps: prefs.timestamps, badges: prefs.badges, platformIcon: prefs.platformIcons, nicks: prefs.nicks,
    darkBg: true, selfNames: selfNames(), onUser: m => emit('userCard', { platform: m.platform, user: m.user }),
  };
}

export function renderItem(item, animate = false) {
  const node = item.kind === 'chat' ? chatEl(item, renderOpts()) : eventEl(item, renderOpts());
  node._item = item;
  if (animate) {
    node.classList.add('new');
    node.addEventListener('animationend', () => node.classList.remove('new'), { once: true });
  }
  return node;
}

export class Column {
  constructor(view, { split = false, onChange, onClose, onPopout } = {}) {
    this.view = view;
    this.split = split;
    this.pinned = true;
    this.hoverPause = false;
    this.newWhilePaused = 0;
    this.root = el('section', 'col');
    if (split) {
      const head = el('div', 'col-head');
      const sel = el('select', 'col-view');
      sel.setAttribute('aria-label', 'What this column shows');
      for (const v of VIEWS) { const o = el('option', null, v.label); o.value = v.id; sel.append(o); }
      sel.value = view;
      sel.addEventListener('change', () => { this.setView(sel.value); onChange?.(sel.value); });
      this.headIcon = el('span', 'col-ico');
      const pop = el('button', 'icon-btn sm'); pop.append(iconEl('popout')); pop.title = 'Pop out this column'; pop.addEventListener('click', () => onPopout?.(this.view));
      const close = el('button', 'icon-btn sm'); close.append(iconEl('x')); close.title = 'Remove column'; close.addEventListener('click', () => onClose?.(this));
      head.append(this.headIcon, sel, pop, close);
      this.root.append(head);
      this.sel = sel;
    }
    this.feed = el('div', 'feed');
    this.feed.role = 'log';
    this.feed.setAttribute('aria-label', viewLabel(view));
    this.empty = el('div', 'empty'); this.empty.hidden = true;
    this.jump = el('button', 'jump'); this.jump.hidden = true;
    this.root.append(this.feed, this.empty, this.jump);
    this.wire();
    this.paintHead();
  }

  paintHead() {
    if (!this.headIcon) return;
    const v = VIEWS.find(x => x.id === this.view);
    this.headIcon.replaceChildren();
    this.root.style.setProperty('--col-color', v?.pf ? PLATFORM[v.pf].color : 'var(--accent)');
    if (v?.pf) { const s = el('span', `pf pf-${v.pf}`); s.innerHTML = PLATFORM[v.pf].icon; this.headIcon.append(s); }
    else if (v?.icon) this.headIcon.append(iconEl(v.icon));
  }

  wire() {
    const feed = this.feed;
    feed.addEventListener('scroll', () => {
      const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;
      if (atBottom !== this.pinned) {
        this.pinned = atBottom;
        if (atBottom) this.newWhilePaused = 0;
        this.updateJump();
      }
    }, { passive: true });
    // Emotes load after a line is added; keep the view pinned to the newest message.
    feed.addEventListener('load', () => { if (this.pinned && !this.hoverPause) this.toBottom(); }, true);
    // Like Chatterino: hold still while the mouse moves over chat; resume when it leaves or rests.
    feed.addEventListener('mousemove', () => {
      this.hoverPause = true;
      clearTimeout(this.hoverTimer);
      this.hoverTimer = setTimeout(() => this.resume(), 3500);
    });
    feed.addEventListener('mouseleave', () => this.resume());
    this.jump.addEventListener('click', () => this.goLive(true));
  }

  resume() {
    if (!this.hoverPause) return;
    this.hoverPause = false;
    clearTimeout(this.hoverTimer);
    if (this.pinned) {
      this.trim();
      this.toBottom();
      this.newWhilePaused = 0;
    }
    this.updateJump();
  }

  goLive(smooth = false) {
    this.pinned = true;
    this.hoverPause = false;
    this.newWhilePaused = 0;
    this.updateJump();
    if (smooth) this.feed.scrollTo({ top: this.feed.scrollHeight, behavior: 'smooth' }); else this.toBottom();
  }

  toBottom() { this.feed.scrollTop = this.feed.scrollHeight; }
  trim() { while (this.feed.childElementCount > MAX_NODES) this.feed.firstElementChild.remove(); }

  setView(view) {
    this.view = view;
    this.feed.setAttribute('aria-label', viewLabel(view));
    if (this.sel) this.sel.value = view;
    this.paintHead();
    this.rebuild();
  }

  rebuild() {
    const list = state.items.filter(i => matches(i, this.view)).slice(-400);
    this.feed.replaceChildren(...list.map(i => renderItem(i)));
    this.pinned = true;
    this.newWhilePaused = 0;
    this.updateJump();
    this.toBottom();
    this.updateEmpty(list.length);
  }

  add(item) {
    if (!matches(item, this.view)) return false;
    this.feed.append(renderItem(item, true));
    this.empty.hidden = true;
    if (this.pinned && !this.hoverPause) { this.trim(); this.toBottom(); }
    else { this.newWhilePaused++; this.updateJump(); }
    return true;
  }

  markDeleted() {
    for (const n of this.feed.querySelectorAll('.msg')) if (n._item?.deleted) n.classList.add('deleted');
  }

  /** Re-draw one person's lines (their nickname/note changed). */
  refreshUser(platform, userId) {
    for (const n of [...this.feed.querySelectorAll('.msg')]) {
      const it = n._item;
      if (it?.platform === platform && it.user?.id === userId) n.replaceWith(renderItem(it));
    }
  }

  updateJump() {
    const j = this.jump;
    if (this.pinned && !(this.hoverPause && this.newWhilePaused)) { j.hidden = true; return; }
    j.hidden = false;
    if (this.pinned) { j.replaceChildren(iconEl('pause'), el('span', null, `Paused · ${this.newWhilePaused} new`)); return; }
    j.replaceChildren(iconEl('arrowDown'), el('span', null, this.newWhilePaused ? `${this.newWhilePaused} new message${this.newWhilePaused === 1 ? '' : 's'}` : 'Back to live chat'));
  }

  updateEmpty(count) {
    const box = this.empty;
    if (count) { box.hidden = true; return; }
    const st = state.status;
    const anyConnected = PLATFORMS.some(p => st[p]?.state === 'connected');
    const anyConfigured = PLATFORMS.some(p => st[p]?.state !== 'off');
    let icon = 'radio', title = 'Waiting for chat', text = 'Messages will show up here as soon as someone talks.', action = null;
    const v = this.view;
    if (!anyConfigured) {
      icon = 'settings'; title = 'Connect your channels';
      text = 'Add your Twitch, Kick, TikTok and YouTube channels to start reading chat.';
      action = { label: 'Open settings', run: () => emit('openSettings', 'accounts') };
    } else if (v === 'mentions') { icon = 'at'; title = 'No mentions yet'; text = 'Messages that mention you will collect here.'; }
    else if (v === 'firsts') { icon = 'sprout'; title = 'No first-timers yet'; text = 'People chatting in your channel for the first time show up here, so you can welcome them.'; }
    else if (v === 'events') { icon = 'zap'; title = 'No events yet'; text = 'Follows, subs, gifts, raids and Kicks appear here.'; }
    else if (PLATFORMS.includes(v) && st[v]?.state !== 'connected') {
      icon = 'radio'; title = st[v]?.state === 'waiting' ? `Waiting for your ${PLATFORM[v].name} stream` : `${PLATFORM[v].name} isn't connected`;
      text = st[v]?.detail || 'Set it up in Settings.';
      if (st[v]?.state !== 'waiting') action = { label: 'Open settings', run: () => emit('openSettings', 'accounts') };
    } else if (!anyConnected) { title = 'Connecting…'; text = 'Hang tight while StreamChat connects.'; }
    const card = el('div', 'empty-card');
    const big = el('div', 'big'); big.append(iconEl(icon));
    card.append(big, el('h3', null, title), el('p', null, text));
    if (action) { const b = el('button', 'btn primary', action.label); b.addEventListener('click', action.run); card.append(b); }
    box.replaceChildren(card);
    box.hidden = false;
  }
}
