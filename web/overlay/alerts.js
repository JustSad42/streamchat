import { el, iconEl, platformEl, partsEl, EVENT_STYLE } from '/shared/render.js';
import { connect, loadFont, overlayKey, showNotice } from './common.js';
import { PLATFORM } from '/shared/icons.js';

const box = document.getElementById('alerts');
let alerts = null;
const queue = [];
let showing = false;

const KICKER = {
  follow: 'New follower', sub: 'New subscriber', resub: 'Resubscribed', giftsub: 'Gifted subs', raid: 'Raid',
  bits: 'Cheer', gift: 'Gift', kicks: 'Kicks', share: 'Shared', like: 'Likes',
};

function wanted(ev) {
  if (!alerts?.enabled || ev.kind !== 'event' || !ev.alert) return false;
  const typeKey = ev.type === 'resub' ? 'sub' : ev.type;
  if (!alerts.types[typeKey]) return false;
  if (ev.type === 'bits' && (ev.amount || 0) < alerts.minBits) return false;
  if (ev.type === 'gift' && ev.platform === 'tiktok' && (ev.amount || 0) < alerts.minDiamonds) return false;
  return true;
}

let audio;
function chime() {
  if (!alerts?.volume) return;
  try {
    audio ||= new AudioContext();
    const t = audio.currentTime;
    const gain = audio.createGain();
    gain.connect(audio.destination);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.25 * alerts.volume, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
    for (const [f, d] of [[880, 0], [1318.5, 0.12], [1760, 0.24]]) {
      const o = audio.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(gain);
      o.start(t + d);
      o.stop(t + 1.2);
    }
  } catch { /* audio not allowed */ }
}

function render(ev) {
  const st = EVENT_STYLE[ev.type] || { icon: 'zap', color: alerts.accent };
  const card = el('div', 'alert');
  card.style.setProperty('--ev', ev.type === 'follow' || ev.type === 'sub' || ev.type === 'resub' ? alerts.accent : st.color);
  card.style.setProperty('--font', `"${alerts.fontFamily}", Inter, system-ui, sans-serif`);
  const art = el('div', 'alert-art');
  if (ev.image) { const img = document.createElement('img'); img.src = ev.image; img.alt = ''; art.append(img); }
  else art.append(iconEl(st.icon, 'ev-ico'));
  const text = el('div', 'alert-text');
  const kicker = el('div', 'alert-kicker');
  kicker.append(platformEl(ev.platform), `${PLATFORM[ev.platform]?.name || ''} · ${KICKER[ev.type] || ev.type}`);
  text.append(kicker, el('div', 'alert-title', ev.title));
  if (ev.parts?.length) { const m = partsEl(ev.parts, { links: false, titles: false }); m.className = 'alert-msg'; text.append(m); }
  card.append(art, text);
  if (ev.amount && ['bits', 'gift', 'kicks', 'giftsub', 'raid'].includes(ev.type)) {
    card.append(el('div', 'alert-amount', ev.type === 'gift' ? `${ev.amount}` : `×${ev.amount}`));
    if (ev.type === 'gift') card.lastChild.title = 'coins';
  }
  return card;
}

async function next() {
  if (showing || !queue.length) return;
  showing = true;
  const ev = queue.shift();
  const card = render(ev);
  box.replaceChildren(card);
  chime();
  await new Promise(r => setTimeout(r, Math.max(2, alerts.durationSec) * 1000));
  card.classList.add('out');
  await new Promise(r => setTimeout(r, 500));
  card.remove();
  await new Promise(r => setTimeout(r, 400));
  showing = false;
  next();
}

function enqueue(ev) {
  if (queue.length > 30) queue.shift();
  queue.push(ev);
  next();
}

connect(msg => {
  if (msg.op === 'hello' || msg.op === 'theme') { alerts = msg.alerts; loadFont(alerts.fontFamily); showNotice(''); }
  else if (msg.op === 'item' && wanted(msg.item)) enqueue(msg.item);
  else if (msg.op === 'alertTest') enqueue(msg.item);
}, async state => {
  if (state === 'closed') {
    const r = await fetch(`/api/overlay?k=${encodeURIComponent(overlayKey)}`).catch(() => null);
    if (r && r.status === 401) showNotice('This alerts link is out of date. Copy the new one from StreamChat → Overlay.');
  }
});
