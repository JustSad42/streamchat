// Turns server messages into DOM. Shared by the chat app and the OBS overlay.
// All user text goes through textContent, never innerHTML.

import { PLATFORM, ICONS, badgeArt } from './icons.js';

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function iconEl(name, cls = 'ico') {
  const s = el('span', cls);
  s.innerHTML = ICONS[name] || '';
  return s;
}

export function platformEl(platform, cls = 'pf') {
  const s = el('span', `${cls} pf-${platform}`);
  s.innerHTML = PLATFORM[platform]?.icon || '';
  s.title = PLATFORM[platform]?.name || platform;
  return s;
}

// Make user name colors readable on a dark (or light) background.
const colorCache = new Map();
export function readableColor(hex, dark = true) {
  if (!hex) return null;
  const key = hex + dark;
  if (colorCache.has(key)) return colorCache.get(key);
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  let [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  if (dark) l = Math.max(l, 0.6); else l = Math.min(l, 0.42);
  const out = `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
  colorCache.set(key, out);
  return out;
}

function emoteEl(p, opts) {
  const wrap = el('span', p.overlays?.length ? 'emote stack' : 'emote');
  const img = document.createElement('img');
  img.src = p.url;
  img.alt = p.name;
  img.decoding = 'async';
  img.draggable = false;
  if (opts.titles !== false) img.title = `${p.name} · ${SRC_NAME[p.src] || p.src}`;
  wrap.append(img);
  for (const o of p.overlays || []) {
    const z = document.createElement('img');
    z.src = o.url;
    z.alt = o.name;
    z.className = 'zw';
    z.decoding = 'async';
    z.draggable = false;
    if (opts.titles !== false) z.title = `${o.name} · ${SRC_NAME[o.src] || o.src}`;
    wrap.append(z);
  }
  if (opts.onEmote) wrap.addEventListener('click', e => opts.onEmote(p, e));
  return wrap;
}

const SRC_NAME = { twitch: 'Twitch', kick: 'Kick', tiktok: 'TikTok', '7tv': '7TV', ffz: 'FrankerFaceZ', bttv: 'BetterTTV' };

export function partsEl(parts, opts = {}) {
  const span = el('span', 'body');
  for (const p of parts || []) {
    if (p.t === 'text') span.append(p.v);
    else if (p.t === 'emote') span.append(emoteEl(p, opts));
    else if (p.t === 'mention') {
      const m = el('span', 'mention', p.v);
      if (opts.selfNames?.includes(p.v.slice(1).toLowerCase())) m.classList.add('me');
      span.append(m);
    } else if (p.t === 'link') {
      if (opts.links === false) span.append(el('span', 'link', p.v));
      else {
        const a = el('a', 'link', p.v);
        a.href = p.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        span.append(a);
      }
    }
  }
  return span;
}

export function badgesEl(badges) {
  const wrap = el('span', 'badges');
  for (const b of badges || []) {
    if (b.url) {
      const img = document.createElement('img');
      img.src = b.url;
      img.alt = b.title;
      img.title = b.title;
      img.className = 'badge';
      img.decoding = 'async';
      wrap.append(img);
    } else {
      const art = badgeArt(b.id);
      if (!art) continue;
      const s = el('span', 'badge');
      s.innerHTML = art;
      s.title = b.title;
      wrap.append(s);
    }
  }
  return wrap;
}

export function timeStr(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// opts: { timestamps, badges, platformIcon, userColors, darkBg, links, onUser, onEmote, selfNames }
export function chatEl(m, opts = {}) {
  const row = el('div', 'msg');
  row.dataset.id = m.id;
  row.dataset.platform = m.platform;
  row.dataset.user = m.user.id;
  if (m.flags?.action) row.classList.add('action');
  if (m.flags?.mention) row.classList.add('mention');
  if (m.flags?.highlight) { row.classList.add('hl'); row.style.setProperty('--hl', m.flags.highlight); }
  if (m.flags?.firstMsg) row.classList.add('first');
  if (m.flags?.self) row.classList.add('self');
  if (m.flags?.blocked) row.classList.add('blocked');
  if (m.deleted) row.classList.add('deleted');

  if (m.reply) {
    const r = el('div', 'reply-ctx');
    r.append(iconEl('reply', 'ico tiny'), el('b', null, `@${m.reply.user}`), ' ', el('span', null, m.reply.text));
    row.append(r);
  }
  const line = el('div', 'line');
  const meta = el('span', 'meta');
  if (opts.timestamps) meta.append(el('time', 'ts', timeStr(m.ts)));
  if (opts.platformIcon !== false) meta.append(platformEl(m.platform));
  if (opts.badges !== false && m.user.badges?.length) meta.append(badgesEl(m.user.badges));
  if (meta.childNodes.length) line.append(meta);

  // Your own nickname for this person (app only); the real name stays in the tooltip.
  const nick = opts.nicks && m.viewer?.nick;
  const name = el('span', 'name', nick || m.user.name);
  if (nick) name.title = `${m.user.name} (your nickname: ${nick})`;
  const color = opts.userColors === false ? null : readableColor(m.user.color, opts.darkBg !== false);
  if (color) name.style.color = color;
  if (opts.onUser) { name.classList.add('clickable'); name.addEventListener('click', e => opts.onUser(m, e)); }
  line.append(name);
  if (opts.nicks && m.viewer?.hasNote) { const n = iconEl('note', 'ico note-mark'); n.title = 'You have a note about this person'; line.append(n); }
  if (opts.nicks && m.viewer?.linked?.length) {
    const l = el('span', 'linked-mark');
    for (const p of m.viewer.linked) l.append(platformEl(p));
    l.title = `Also on ${m.viewer.linked.map(p => PLATFORM[p]?.name || p).join(', ')}`;
    line.append(l);
  }
  if (!m.flags?.action) line.append(el('span', 'colon', ':'));
  line.append(' ');
  const body = partsEl(m.parts, opts);
  if (m.flags?.action && color) body.style.color = color;
  line.append(body);
  row.append(line);
  return row;
}

export const EVENT_STYLE = {
  follow: { icon: 'heart', color: '#f472b6' },
  sub: { icon: 'star', color: '#a78bfa' },
  resub: { icon: 'star', color: '#a78bfa' },
  giftsub: { icon: 'gift', color: '#f59e0b' },
  raid: { icon: 'users', color: '#38bdf8' },
  bits: { icon: 'gem', color: '#c084fc' },
  gift: { icon: 'gift', color: '#fe2c55' },
  kicks: { icon: 'coins', color: '#53fc18' },
  like: { icon: 'heart', color: '#fb7185' },
  share: { icon: 'share', color: '#22d3ee' },
  redeem: { icon: 'sparkles', color: '#facc15' },
  announcement: { icon: 'megaphone', color: '#60a5fa' },
  ban: { icon: 'ban', color: '#ef4444' },
  timeout: { icon: 'clock', color: '#f97316' },
  live: { icon: 'radio', color: '#ef4444' },
};

export function eventEl(ev, opts = {}) {
  const st = EVENT_STYLE[ev.type] || { icon: 'zap', color: '#94a3b8' };
  const row = el('div', `event ev-${ev.type}`);
  row.dataset.id = ev.id;
  row.dataset.platform = ev.platform;
  row.style.setProperty('--ev', st.color);
  const ic = iconEl(st.icon, 'ev-ico');
  const main = el('div', 'ev-main');
  const head = el('div', 'ev-title');
  if (opts.platformIcon !== false) head.append(platformEl(ev.platform));
  head.append(el('span', null, ev.title));
  if (opts.timestamps) head.append(el('time', 'ts', timeStr(ev.ts)));
  main.append(head);
  if (ev.parts?.length) main.append(partsEl(ev.parts, opts));
  row.append(ic, main);
  if (ev.image) {
    const img = document.createElement('img');
    img.src = ev.image;
    img.className = 'ev-img';
    img.alt = '';
    row.append(img);
  }
  if (ev.user && opts.onUser) {
    row.classList.add('clickable');
    row.addEventListener('click', e => opts.onUser({ platform: ev.platform, user: ev.user }, e));
  }
  return row;
}
