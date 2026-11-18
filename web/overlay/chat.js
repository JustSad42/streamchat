import { chatEl, eventEl } from '/shared/render.js';
import { applyTheme, connect, params, overlayKey, showNotice } from './common.js';

const chat = document.getElementById('chat');
const preview = params.get('preview') === '1';
let theme = null;
const timers = new Map();
let lastReal = 0;
let hidden = false; // "Hide chat on stream" from the app

const OVERLAY_EVENTS = new Set(['follow', 'sub', 'resub', 'giftsub', 'raid', 'bits', 'gift', 'kicks', 'redeem', 'announcement', 'share']);

function setTheme(t) {
  theme = t;
  applyTheme(t);
  chat.className = `chat anim-${t.animation} dir-${t.direction} bg-${t.bgMode || 'bubble'}${t.textShadow ? ' shadow' : ''}${t.outline ? ' outline' : ''}${t.nameBold ? '' : ' no-bold'}${hidden ? ' is-hidden' : ''}`;
  // Re-apply limits and visibility to what's on screen.
  for (const node of [...chat.children]) if (node._item && !visible(node._item)) node.remove();
  trim();
}

function visible(item) {
  if (!theme) return false;
  if (!theme.platforms[item.platform]) return false;
  if (item.kind === 'event') return theme.showEvents && OVERLAY_EVENTS.has(item.type);
  if (item.deleted || item.flags?.blocked) return false;
  if (theme.hideCommands && item.text.trimStart().startsWith('!')) return false;
  if (theme.hideUsers.some(u => u.toLowerCase() === item.user.login)) return false;
  if (!item.parts?.length) return false;
  return true;
}

function render(item) {
  const opts = {
    timestamps: theme.showTimestamps, badges: theme.showBadges, platformIcon: theme.showPlatformIcon,
    userColors: theme.useUserColors, darkBg: true, links: false, titles: false,
  };
  return item.kind === 'chat' ? chatEl(item, opts) : eventEl(item, opts);
}

function add(item, animate = true) {
  if (!visible(item)) return;
  const node = render(item);
  node._item = item;
  if (animate && theme.animation !== 'none') {
    node.classList.add('new');
    node.addEventListener('animationend', () => node.classList.remove('new'), { once: true });
  }
  if (theme.direction === 'down') chat.prepend(node); else chat.append(node);
  if (theme.fadeAfter > 0) {
    timers.set(node, setTimeout(() => leave(node), theme.fadeAfter * 1000));
  }
  trim();
}

function leave(node) {
  clearTimeout(timers.get(node));
  timers.delete(node);
  if (!node.isConnected || node.classList.contains('leaving')) return;
  node.classList.add('leaving');
  const done = () => node.remove();
  node.addEventListener('animationend', done, { once: true });
  setTimeout(done, 700);
}

function trim() {
  if (!theme) return;
  const nodes = [...chat.children].filter(n => !n.classList.contains('leaving'));
  const extra = nodes.length - theme.maxMessages;
  if (extra <= 0) return;
  const old = theme.direction === 'down' ? nodes.slice(-extra) : nodes.slice(0, extra);
  for (const n of old) { clearTimeout(timers.get(n)); n.remove(); }
  // Also drop anything that has scrolled out of view.
  const box = chat.getBoundingClientRect();
  for (const n of [...chat.children]) {
    const r = n.getBoundingClientRect();
    if (theme.direction === 'down' ? r.top > box.bottom : r.bottom < box.top) n.remove();
  }
}

function removeWhere(fn) {
  for (const n of [...chat.children]) if (n._item && fn(n._item)) leave(n);
}

connect(msg => {
  switch (msg.op) {
    case 'hello':
      hidden = !!msg.hidden && !preview;
      setTheme(msg.theme);
      chat.replaceChildren();
      for (const it of msg.history) add(it, false);
      showNotice('');
      break;
    case 'theme': setTheme(msg.theme); break;
    case 'visibility': if (!preview) { hidden = !!msg.hidden; chat.classList.toggle('is-hidden', hidden); } break;
    case 'clear': for (const n of [...chat.children]) { clearTimeout(timers.get(n)); n.remove(); } break;
    case 'item': lastReal = Date.now(); add(msg.item); break;
    case 'delete': removeWhere(i => i.platform === msg.platform && i.id === msg.id); break;
    case 'clearUser': removeWhere(i => i.kind === 'chat' && i.platform === msg.platform && i.user.id === msg.userId); break;
  }
}, async state => {
  if (state === 'closed' || state === 'badkey') {
    const r = await fetch(`/api/overlay?k=${encodeURIComponent(overlayKey)}`).catch(() => null);
    if (r && r.status === 401) showNotice('This overlay link is out of date. Copy the new one from StreamChat → Overlay.');
  }
});

// Preview mode (used by the Overlay studio): keep sample messages flowing when chat is quiet.
if (preview) {
  document.documentElement.style.colorScheme = 'dark'; // match the app so the iframe stays transparent
  const E = {
    kappa: { t: 'emote', name: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0', src: 'twitch' },
    lule: { t: 'emote', name: 'LULE', url: 'https://cdn.betterttv.net/emote/60477a2f306b602acc599abf/2x.webp', src: 'bttv' },
    clueless: { t: 'emote', name: 'Clueless', url: 'https://cdn.7tv.app/emote/01F6T8NM9R0007M5BTFWSP1YSJ/2x.webp', src: '7tv' },
    rain: { t: 'emote', name: 'RainTime', url: 'https://cdn.7tv.app/emote/01FCY771D800007PQ2DF3GDTN6/2x.webp', src: '7tv', zw: true },
  };
  const samples = [
    ['twitch', 'NightOwl', '#9b7bff', [{ id: 'subscriber/12', title: 'Subscriber' }], [{ t: 'text', v: 'that play was insane ' }, E.lule]],
    ['kick', 'greenmachine', '#53fc18', [{ id: 'kick:moderator', title: 'Moderator' }], [{ t: 'text', v: 'gg chat, clip it ' }, E.clueless]],
    ['tiktok', 'mia.plays', '#ff6b9a', [{ id: 'tiktok:subscriber', title: 'Subscriber' }], [{ t: 'text', v: 'hello from TikTok 👋' }]],
    ['twitch', 'Sven', '#3fb6ff', [{ id: 'vip/1', title: 'VIP' }], [{ ...E.clueless, overlays: [E.rain] }, { t: 'text', v: ' weather check' }]],
    ['kick', 'TurboTom', '#ffb020', [], [{ t: 'text', v: 'first time here, love the overlay ' }, E.kappa]],
  ];
  let i = 0;
  const tick = () => {
    if (theme && Date.now() - lastReal > 6000) {
      const [platform, name, color, badges, parts] = samples[i++ % samples.length];
      add({ kind: 'chat', id: `demo-${Date.now()}`, platform, ts: Date.now(), user: { id: name, login: name.toLowerCase(), name, color, badges }, text: '', parts, flags: {} });
      if (i % 7 === 0 && theme.showEvents) add({ kind: 'event', id: `demo-ev-${Date.now()}`, platform: 'tiktok', ts: Date.now(), type: 'gift', title: 'mia.plays sent 5× Rose', amount: 5 });
    }
  };
  setInterval(tick, 1800);
  setTimeout(tick, 300);
}
