// Settings dialog: accounts & channels, chat options, overlay studio, alerts, server.

import { el, iconEl, platformEl } from '/shared/render.js';
import { PLATFORM } from '/shared/icons.js';
import { $, api, state, refreshState, toast, prefs, savePrefs, copy, enableLightDismiss, openExternal, on, STAT_KEYS, CHAT_SIZE } from './core.js';
import { applyLook, renderStats } from './view.js';

const dlg = $('#settings');
enableLightDismiss(dlg);

const SECTIONS = [
  { id: 'accounts', label: 'Accounts', icon: 'user' },
  { id: 'chat', label: 'Chat', icon: 'highlighter' },
  { id: 'overlay', label: 'Overlay', icon: 'layers' },
  { id: 'alerts', label: 'Alerts', icon: 'bell' },
  { id: 'server', label: 'Server', icon: 'terminal' },
];
let section = 'accounts';
let body;

export async function openSettings(which) {
  if (which) section = which;
  if (!state.pub) await refreshState();
  build();
  if (!dlg.open) dlg.showModal();
}

dlg.addEventListener('close', () => { stopTwitchPoll(); dlg.replaceChildren(); });
on('state', () => { if (dlg.open && section !== 'overlay' && section !== 'alerts' && !dlg.contains(document.activeElement?.closest('input,select,textarea'))) renderSection(); });
on('status', () => { if (dlg.open && section === 'accounts') updateChips(); });

function build() {
  dlg.replaceChildren();
  const nav = el('nav', 's-nav');
  nav.append(el('h2', null, 'Settings'));
  for (const s of SECTIONS) {
    const b = el('button');
    b.type = 'button';
    b.dataset.s = s.id;
    b.append(iconEl(s.icon), el('span', null, s.label));
    if (s.id === section) b.setAttribute('aria-current', 'page');
    b.addEventListener('click', () => {
      section = s.id;
      for (const x of nav.querySelectorAll('button')) x.removeAttribute('aria-current');
      b.setAttribute('aria-current', 'page');
      renderSection();
    });
    nav.append(b);
  }
  body = el('div', 's-body');
  const close = el('button', 'icon-btn s-close');
  close.setAttribute('aria-label', 'Close settings');
  close.append(iconEl('x'));
  close.addEventListener('click', () => dlg.close());
  dlg.append(nav, body);
  dlg.append(close);
  renderSection();
}

function renderSection() {
  stopTwitchPoll();
  const scroll = body.scrollTop;
  body.replaceChildren();
  ({ accounts, chat, overlay, alerts, server })[section]();
  body.scrollTop = scroll;
}

// ---------------------------------------------------------------- helpers

let pending = {};
let saveTimer = null;
function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) a[k] = deepMerge(a[k] && typeof a[k] === 'object' ? a[k] : {}, v);
    else a[k] = v;
  }
  return a;
}
function save(patch, delay = 250) {
  deepMerge(pending, patch);
  deepMerge(state.pub.settings, structuredClone(patch));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const p = pending;
    pending = {};
    try { state.pub = await api('POST', '/api/settings', p); state.status = state.pub.status; }
    catch (e) { toast(e.message, 'err'); }
  }, delay);
}

function field(label, input, help) {
  const f = el('label', 'field');
  f.append(el('span', null, label), input);
  if (help) f.append(el('small', null, help));
  return f;
}
function textInput(value, { type = 'text', placeholder = '', onChange, onCommit } = {}) {
  const i = el('input');
  i.type = type;
  i.value = value ?? '';
  i.placeholder = placeholder;
  i.spellcheck = false;
  i.autocomplete = 'off';
  if (onChange) i.addEventListener('input', () => onChange(i.value));
  if (onCommit) i.addEventListener('change', () => onCommit(i.value));
  return i;
}
function switchRow(title, desc, checked, onChange) {
  const row = el('label', 'switch-row');
  const lbl = el('div', 'lbl');
  lbl.append(el('b', null, title));
  if (desc) lbl.append(el('small', null, desc));
  const sw = el('input', 'switch');
  sw.type = 'checkbox';
  sw.checked = !!checked;
  sw.addEventListener('change', () => onChange(sw.checked));
  row.append(lbl, sw);
  return row;
}
function rangeField(label, value, { min, max, step = 1, fmt = v => v, onChange }) {
  const wrap = el('label', 'range-field');
  const out = el('output', null, fmt(value));
  const r = el('input');
  r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = value;
  r.addEventListener('input', () => { out.textContent = fmt(Number(r.value)); onChange(Number(r.value)); });
  wrap.append(el('span', null, label), out, r);
  return wrap;
}
function select(value, options, onChange) {
  const s = el('select', 'inp');
  for (const [v, l] of options) { const o = el('option', null, l); o.value = v; if (String(v) === String(value)) o.selected = true; s.append(o); }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}
function copyField(value) {
  const wrap = el('div', 'copy-field');
  const i = textInput(value);
  i.readOnly = true;
  i.addEventListener('focus', () => i.select());
  const b = el('button', 'btn sm');
  b.type = 'button';
  b.append(iconEl('copy'), el('span', null, 'Copy'));
  b.addEventListener('click', () => copy(i.value));
  wrap.append(i, b);
  return wrap;
}
function btn(label, icon, cls, run) {
  const b = el('button', `btn ${cls || ''}`);
  b.type = 'button';
  if (icon) b.append(iconEl(icon));
  b.append(el('span', null, label));
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await run(); } catch (e) { toast(e.message, 'err'); } finally { b.disabled = false; }
  });
  return b;
}
function heading(title, lead) {
  body.append(el('h3', null, title));
  if (lead) body.append(el('p', 'lead', lead));
}
function card(platform, title, right) {
  const c = el('section', 'card');
  const h = el('div', 'card-head');
  if (platform) h.append(platformEl(platform));
  h.append(el('h4', null, title));
  const r = el('div', 'right');
  if (right) r.append(...[].concat(right));
  h.append(r);
  c.append(h);
  return c;
}
function howto(title, steps) {
  const d = el('details', 'howto');
  d.append(el('summary', null, title));
  const ol = el('ol');
  for (const s of steps) {
    const li = el('li');
    // steps may contain `code` segments
    for (const [i, part] of s.split('`').entries()) li.append(i % 2 ? el('code', null, part) : part);
    ol.append(li);
  }
  d.append(ol);
  return d;
}
const origin = () => location.origin;
const localish = () => (state.pub.settings.publicUrl || origin()).replace(/\/+$/, '').replace('//127.0.0.1', '//localhost');

function statusChip(p) {
  const s = state.status[p] || { state: 'off' };
  const map = { connected: ['ok', 'Connected'], connecting: ['warn', 'Connecting'], waiting: ['', 'Waiting for stream'], error: ['warn', 'Problem'], off: ['off', 'Off'] };
  const [cls, txt] = map[s.state] || ['', s.state];
  const c = el('span', `chip ${cls}`, txt);
  c.dataset.chip = p;
  if (s.detail) c.title = s.detail;
  return c;
}
function updateChips() {
  for (const p of ['twitch', 'kick', 'tiktok', 'youtube']) {
    const old = body?.querySelector(`[data-chip="${p}"]`);
    if (old) old.replaceWith(statusChip(p));
    const d = body?.querySelector(`[data-detail="${p}"]`);
    if (d) d.textContent = state.status[p]?.detail || '';
  }
}
function detailLine(p) {
  const d = el('p', 'help');
  d.dataset.detail = p;
  d.textContent = state.status[p]?.detail || '';
  return d;
}

// ---------------------------------------------------------------- Accounts

let twitchPoll = null;
function stopTwitchPoll() { clearInterval(twitchPoll); twitchPoll = null; }

function accounts() {
  const s = state.pub.settings;
  const k = state.pub.keys;
  const acc = state.pub.accounts;
  heading('Accounts & channels', 'Connect the channels you stream on. Reading chat works signed out on Twitch; sending, moderating and events need you signed in.');

  // ---- Twitch
  {
    const c = card('twitch', 'Twitch', [statusChip('twitch'), enabledSwitch('twitch')]);
    c.append(detailLine('twitch'));
    const g = el('div', 'grid2');
    g.append(field('Channel', textInput(s.twitch.channel, { placeholder: acc.twitch || 'your_channel', onCommit: v => save({ twitch: { channel: v.trim().toLowerCase() } }, 0) }), 'Leave empty to use the account you sign in with.'));
    const cid = textInput(k.twitchClientId, { placeholder: 'e.g. abcd1234…', onCommit: async v => { state.pub = await api('POST', '/api/keys', { twitchClientId: v }); renderSection(); } });
    g.append(field('Client ID', cid, 'From your Twitch developer app (Public client type).'));
    c.append(g);
    const authBox = el('div');
    c.append(authBox);
    drawTwitchAuth(authBox);
    c.append(howto('How to get a Twitch Client ID (2 minutes)', [
      'Go to `dev.twitch.tv/console/apps` and sign in with your Twitch account.',
      'Click "Register Your Application". Name: anything, e.g. `StreamChat-yourname`.',
      'OAuth Redirect URL: `http://localhost` (it isn\'t used, but Twitch requires one).',
      'Category: Chat Bot. Client Type: Public. Click Create.',
      'Click "Manage", copy the Client ID and paste it above. You don\'t need a secret.',
    ]));
    body.append(c);
  }

  // ---- Kick
  {
    const c = card('kick', 'Kick', [statusChip('kick'), enabledSwitch('kick')]);
    c.append(detailLine('kick'));
    const g = el('div', 'grid2');
    g.append(field('Client ID', textInput(k.kickClientId, { placeholder: 'From kick.com developer settings', onCommit: async v => { state.pub = await api('POST', '/api/keys', { kickClientId: v }); renderSection(); } })));
    g.append(field('Client Secret', textInput('', { type: 'password', placeholder: k.kickHasSecret ? 'Saved (type to replace)' : 'Paste the secret', onCommit: async v => { if (!v) return; state.pub = await api('POST', '/api/keys', { kickClientSecret: v }); toast('Kick secret saved', 'ok'); renderSection(); } })));
    c.append(g);
    if (acc.kick) {
      const a = el('div', 'account');
      a.append(iconEl('check', 'ico ok'), el('div', 'who', `Signed in as ${acc.kick}`), btn('Sign out', 'logout', 'sm', async () => { state.pub = await api('POST', '/api/auth/kick/logout', {}); renderSection(); }));
      c.append(a);
    } else {
      const row = el('div', 'preview-bar');
      const b = btn('Sign in with Kick', null, 'kick', async () => {
        const r = await api('POST', '/api/auth/kick/start', { origin: origin() });
        openExternal(r.url);
        toast('Finish signing in in your browser, then come back here.');
      });
      b.prepend(platformEl('kick'));
      b.disabled = !k.kickClientId || !k.kickHasSecret;
      row.append(b);
      if (b.disabled) row.append(el('small', null, 'Add the Client ID and Secret first.'));
      c.append(row);
    }
    c.append(el('div', 'group-title', 'Setup checklist'));
    const checklist = el('div', 'checklist');
    checklist.append(el('p', 'help', 'Checking…'));
    c.append(checklist);
    c.append(field('Redirect URL (for your Kick app)', copyField(`${localish()}/auth/kick/callback`)));
    const hook = el('div');
    c.append(hook);
    drawKickSetup(checklist, hook).catch(e => { checklist.replaceChildren(el('p', 'help', e.message)); });
    c.append(howto('How to set up Kick (5 minutes)', [
      'On kick.com go to Settings → Developer and create an app.',
      'Redirect URL: the one above. Turn on Webhooks and paste the Webhook URL from below.',
      'Enable the scopes: Read user info, Read channel info, Write to chat, Subscribe to events, Moderation (ban + chat messages).',
      'Copy the Client ID and Client Secret into the fields above, then click Sign in with Kick.',
      'Send a message in your Kick chat. Every step in the checklist should turn green.',
    ]));
    body.append(c);
  }

  // ---- TikTok
  {
    const c = card('tiktok', 'TikTok', [statusChip('tiktok'), enabledSwitch('tiktok')]);
    c.append(detailLine('tiktok'));
    const g = el('div', 'grid2');
    g.append(field('Username', textInput(s.tiktok.username, { placeholder: '@yourname', onCommit: v => save({ tiktok: { username: v.trim().replace(/^@/, '') } }, 0) }), 'Chat connects automatically when you go LIVE.'));
    g.append(field('Euler Stream API key (optional)', textInput('', { type: 'password', placeholder: k.eulerKeySet ? 'Saved (type to replace, or clear)' : 'Not set, using the free tier', onCommit: async v => { state.pub = await api('POST', '/api/keys', { eulerKey: v }); toast(v ? 'Key saved' : 'Key removed', 'ok'); renderSection(); } }), 'A free key from eulerstream.com raises the connection limits.'));
    c.append(g);
    c.append(el('p', 'help', 'TikTok is read-only: other apps can\'t send messages or moderate there. Gifts, follows, shares, subs and likes show up as events.'));
    body.append(c);
  }

  // ---- YouTube
  {
    const c = card('youtube', 'YouTube', [statusChip('youtube'), enabledSwitch('youtube')]);
    c.append(detailLine('youtube'));
    c.append(field('Channel', textInput(s.youtube.channel, { placeholder: '@yourchannel', onCommit: v => save({ youtube: { channel: v.trim() } }, 0) }), 'Your @handle, channel link or channel ID. Chat connects automatically when you go LIVE.'));
    c.append(el('p', 'help', 'YouTube is read-only here and needs no sign-in: send and moderate on YouTube. Super Chats and memberships show up as events. Unlisted and private streams are not found.'));
    body.append(c);
  }
}

async function drawKickSetup(list, hookBox) {
  const r = await api('GET', '/api/kick/setup');
  list.replaceChildren();
  for (const st of r.steps) {
    const row = el('div', `check-row ${st.ok === true ? 'ok' : st.ok === false ? 'bad' : 'todo'}`);
    row.append(iconEl(st.ok === true ? 'check' : st.ok === false ? 'x' : 'clock'), el('b', null, st.label));
    if (st.detail) row.append(el('span', null, st.detail));
    list.append(row);
  }
  const notRunning = r.steps[3].ok === false;
  if (notRunning) list.append(el('p', 'help warn-text', 'Kick says webhooks are off. In your Kick app turn on Webhooks, paste the Webhook URL below and save. StreamChat retries every 20 seconds, so it connects by itself.'));

  hookBox.replaceChildren();
  const ts = r.tailscale;
  const url = textInput(r.webhookUrl, { placeholder: 'https://your-machine.your-tailnet.ts.net:8443/webhooks/kick', onCommit: v => save({ kick: { webhookUrl: v.trim() } }, 0) });
  const wrap = el('div', 'copy-field');
  const cp = el('button', 'btn sm'); cp.type = 'button'; cp.append(iconEl('copy'), el('span', null, 'Copy'));
  cp.addEventListener('click', () => copy(url.value));
  wrap.append(url, cp);
  hookBox.append(field('Webhook URL (for your Kick app)', wrap, 'Kick sends your chat to this public address. Only Kick webhooks are answered there; your app and overlay stay private.'));
  const row = el('div', 'preview-bar');
  if (!r.webhookUrl && ts.installed && ts.running && !r.inDocker) {
    row.append(btn('Make webhook address', 'link', 'primary sm', async () => {
      const x = await api('POST', '/api/kick/funnel', {});
      if (x.enableUrl) { openExternal(x.enableUrl); toast(x.message); }
      else toast(x.message, x.ok ? 'ok' : 'err');
      await drawKickSetup(list, hookBox);
    }));
  }
  if (r.webhookUrl) {
    row.append(btn('Test the address', 'play', 'sm', async () => { const x = await api('POST', '/api/kick/test', {}); toast(x.message, x.ok ? 'ok' : 'err'); }));
  }
  row.append(btn('Check again', 'refresh', 'sm', () => drawKickSetup(list, hookBox)));
  hookBox.append(row);
  if (!r.webhookUrl) {
    let tip;
    if (r.inDocker) tip = 'On the server, run this once (install.sh does it for you):';
    else if (!ts.installed) tip = 'Install Tailscale from tailscale.com/download and sign in, then click Check again. Or run this yourself:';
    else if (!ts.running) tip = `${ts.error || 'Tailscale is not connected.'} Start it, then click Check again. Or run:`;
    else tip = 'Or run this yourself:';
    hookBox.append(el('p', 'help', tip), copyField(r.funnelCommand));
  }
}

function enabledSwitch(p) {
  const sw = el('input', 'switch');
  sw.type = 'checkbox';
  sw.checked = state.pub.settings[p].enabled;
  sw.title = 'Enabled';
  sw.setAttribute('aria-label', `${PLATFORM[p].name} enabled`);
  sw.addEventListener('change', () => save({ [p]: { enabled: sw.checked } }, 0));
  return sw;
}

function drawTwitchAuth(box) {
  box.replaceChildren();
  const acc = state.pub.accounts.twitch;
  const flow = state.pub.twitchLogin;
  if (acc) {
    const a = el('div', 'account');
    a.append(iconEl('check', 'ico ok'), el('div', 'who', `Signed in as ${acc}`), btn('Sign out', 'logout', 'sm', async () => { state.pub = await api('POST', '/api/auth/twitch/logout', {}); renderSection(); }));
    box.append(a);
    if (state.pub.twitchMissingScopes?.length) {
      const n = el('div', 'notice-box');
      n.append(iconEl('key'), el('div', null, 'This version adds new commands (/slow, /shoutout, /announce, /raid, /mod, /vip). Sign in again to allow them.'));
      n.append(btn('Sign in again', null, 'twitch sm', async () => {
        const r = await api('POST', '/api/auth/twitch/start', {});
        state.pub.twitchLogin = r.flow;
        state.pub.accounts.twitch = null;
        drawTwitchAuth(box);
        openExternal(r.flow.verificationUri);
      }));
      box.append(n);
    }
    return;
  }
  if (flow && !flow.done && !flow.error && flow.expiresAt > Date.now()) {
    const d = el('div', 'device-code');
    const sp = el('span', 'spinner');
    const txt = el('div');
    txt.append(el('div', 'help', 'Open the link and enter this code:'), el('div', 'code', flow.userCode));
    const open = btn('Open twitch.tv/activate', 'external', 'twitch', () => openExternal(flow.verificationUri));
    d.append(sp, txt, open);
    open.style.marginLeft = 'auto';
    box.append(d);
    startTwitchPoll(box);
    return;
  }
  const row = el('div', 'preview-bar');
  const b = btn('Sign in with Twitch', null, 'twitch', async () => {
    const r = await api('POST', '/api/auth/twitch/start', {});
    state.pub.twitchLogin = r.flow;
    drawTwitchAuth(box);
    openExternal(r.flow.verificationUri);
  });
  b.prepend(platformEl('twitch'));
  b.disabled = !state.pub.keys.twitchClientId;
  row.append(b);
  if (flow?.error) row.append(el('small', null, flow.error));
  else if (b.disabled) row.append(el('small', null, 'Add your Client ID first.'));
  else row.append(el('small', null, 'Needed to send messages, moderate, and see follows.'));
  box.append(row);
}

function startTwitchPoll(box) {
  stopTwitchPoll();
  twitchPoll = setInterval(async () => {
    try {
      const r = await api('GET', '/api/auth/twitch/status');
      if (r.account) { stopTwitchPoll(); await refreshState(); toast(`Signed in to Twitch as ${r.account}`, 'ok'); if (section === 'accounts') renderSection(); return; }
      if (r.flow?.error) { stopTwitchPoll(); state.pub.twitchLogin = r.flow; drawTwitchAuth(box); }
    } catch { /* keep polling */ }
  }, 2000);
}

// ---------------------------------------------------------------- Chat

function chat() {
  const s = state.pub.settings;
  heading('Chat', 'How chat looks in this window, emotes, and highlights.');

  const look = card(null, 'This window');
  look.append(
    rangeField('Text size', prefs.chatSize, { min: CHAT_SIZE.min, max: CHAT_SIZE.max, fmt: v => `${v}px`, onChange: v => { prefs.chatSize = v; applyLook(); clearTimeout(chat._t); chat._t = setTimeout(savePrefs, 200); } }),
    el('p', 'help', 'Tip: Ctrl + mouse wheel over chat, or Ctrl + / Ctrl −, changes it any time. Ctrl 0 resets.'),
    field('Message background', select(prefs.msgStyle, [['plain', 'None'], ['bubbles', 'Dark bubble per message'], ['striped', 'Striped rows']], v => { prefs.msgStyle = v; savePrefs(); })),
    switchRow('Timestamps', 'Show the time next to each message.', prefs.timestamps, v => { prefs.timestamps = v; savePrefs(); }),
    switchRow('Badges', 'Moderator, subscriber, VIP and other badges.', prefs.badges, v => { prefs.badges = v; savePrefs(); }),
    switchRow('Platform icons', 'Small Twitch / Kick / TikTok / YouTube mark on every line.', prefs.platformIcons, v => { prefs.platformIcons = v; savePrefs(); }),
    switchRow('Nicknames', 'Show the nicknames you give people (set them in a user card).', prefs.nicks, v => { prefs.nicks = v; savePrefs(); }),
    switchRow('First-time chatters', 'Mark people chatting in your channel for the first time, and list them in the First-timers tab. On Kick, TikTok and YouTube this starts 3 days after StreamChat first sees your chat.', s.firstChatter, v => save({ firstChatter: v })),
  );
  body.append(look);

  const stats = card(null, 'Stats bar');
  stats.append(switchRow('Show the stats bar', 'Viewers, uptime and chat activity under the tabs.', prefs.statsBar, v => { prefs.statsBar = v; savePrefs(); renderStats(); renderSection(); }));
  if (prefs.statsBar) {
    const grid = el('div', 'check-grid');
    for (const [k, label] of STAT_KEYS) {
      const l = el('label', 'mini');
      const c = el('input'); c.type = 'checkbox'; c.checked = !!prefs.stats[k];
      c.addEventListener('change', () => { prefs.stats[k] = c.checked; savePrefs(); renderStats(); });
      l.append(c, label);
      grid.append(l);
    }
    stats.append(grid, el('p', 'help', 'Viewer counts need you signed in on Twitch and Kick. TikTok and YouTube show them while you are live.'));
  }
  body.append(stats);

  const em = card(null, 'Emotes');
  em.append(el('p', 'help', 'Third-party emotes from your channel and the global sets. 7TV works on Twitch and Kick; FrankerFaceZ and BetterTTV are Twitch only. Changes on 7TV show up live.'));
  em.append(
    switchRow('7TV', 'Includes animated and zero-width (stacking) emotes.', s.emotes.sevenTv, v => save({ emotes: { sevenTv: v } })),
    switchRow('FrankerFaceZ', null, s.emotes.ffz, v => save({ emotes: { ffz: v } })),
    switchRow('BetterTTV', null, s.emotes.bttv, v => save({ emotes: { bttv: v } })),
  );
  body.append(em);

  const hl = card(null, 'Highlights');
  hl.append(switchRow('Highlight mentions', 'Messages that mention your name get a red highlight and go to the Mentions tab.', s.highlightMentions, v => save({ highlightMentions: v })));
  hl.append(el('div', 'group-title', 'Highlight words'));
  const list = el('div', 'hl-list');
  const rules = structuredClone(s.highlights);
  const commit = () => save({ highlights: rules }, 400);
  const draw = () => {
    list.replaceChildren();
    if (!rules.length) list.append(el('p', 'help', 'No highlight words yet. Add your name, keywords, or a regular expression.'));
    rules.forEach((r, i) => {
      const row = el('div', 'hl-row');
      const t = textInput(r.pattern, { placeholder: 'word or phrase', onChange: v => { r.pattern = v; commit(); } });
      t.className = 'inp';
      const c = el('input'); c.type = 'color'; c.value = r.color || '#f59e0b';
      c.addEventListener('input', () => { r.color = c.value; commit(); });
      const rx = el('label', 'mini');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!r.regex;
      cb.addEventListener('change', () => { r.regex = cb.checked; commit(); });
      rx.append(cb, 'Regex');
      const del = el('button', 'icon-btn'); del.type = 'button'; del.append(iconEl('trash')); del.setAttribute('aria-label', 'Remove');
      del.addEventListener('click', () => { rules.splice(i, 1); commit(); draw(); });
      row.append(c, t, rx, del);
      list.append(row);
    });
  };
  draw();
  hl.append(list, btn('Add highlight', 'plus', 'sm', () => { rules.push({ pattern: '', color: '#f59e0b', regex: false }); draw(); list.querySelector('.hl-row:last-child input[type=text]')?.focus(); }));
  body.append(hl);

  body.append(blockedCard(s));
  body.append(logsCard(s));
}

function blockedCard(s) {
  const f = s.filters;
  const c = card(null, 'Blocked words');
  c.append(el('p', 'help', 'Messages containing these words or phrases never show on stream. Whole words only, so "ass" won\'t catch "class". Tick Regex for patterns.'));
  const terms = structuredClone(f.terms);
  const commit = () => save({ filters: { terms } }, 500);
  const list = el('div', 'hl-list');
  const draw = () => {
    list.replaceChildren();
    if (!terms.length) list.append(el('p', 'help', 'No blocked words yet.'));
    terms.forEach((r, i) => {
      const row = el('div', 'hl-row');
      const t = textInput(r.pattern, { placeholder: 'word or phrase', onChange: v => { r.pattern = v; commit(); } });
      t.className = 'inp';
      const rx = el('label', 'mini');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!r.regex;
      cb.addEventListener('change', () => { r.regex = cb.checked; commit(); });
      rx.append(cb, 'Regex');
      const del = el('button', 'icon-btn'); del.type = 'button'; del.append(iconEl('trash')); del.setAttribute('aria-label', 'Remove');
      del.addEventListener('click', () => { terms.splice(i, 1); commit(); draw(); });
      row.append(iconEl('filter'), t, rx, del);
      list.append(row);
    });
  };
  draw();
  const addRow = el('div', 'preview-bar');
  addRow.append(btn('Add word', 'plus', 'sm', () => { terms.push({ pattern: '', regex: false }); draw(); list.querySelector('.hl-row:last-child input[type=text]')?.focus(); }));
  const bulk = btn('Paste a list', 'copy', 'sm', () => {
    const text = prompt('Paste words or phrases, one per line or separated by commas:');
    if (!text) return;
    for (const w of text.split(/[\n,]+/).map(x => x.trim()).filter(Boolean)) if (!terms.some(t => t.pattern.toLowerCase() === w.toLowerCase())) terms.push({ pattern: w, regex: false });
    commit(); draw();
  });
  addRow.append(bulk);
  c.append(list, addRow);
  c.append(
    switchRow('Keep them off stream', 'The OBS overlay never shows matching messages.', f.hideFromOverlay, v => save({ filters: { hideFromOverlay: v } })),
    switchRow('Hide them here too', 'Otherwise they show dimmed in this window with a "Blocked" label.', f.hideInApp, v => save({ filters: { hideInApp: v } })),
  );
  const g = el('div', 'grid2');
  g.append(field('Also do this automatically', select(f.action, [['none', 'Nothing'], ['delete', 'Delete the message'], ['timeout', 'Time the person out']], v => { save({ filters: { action: v } }, 0); setTimeout(renderSection, 50); }), 'Needs you signed in as broadcaster or moderator (Twitch, Kick).'));
  if (f.action === 'timeout') g.append(field('Timeout length (seconds)', textInput(String(f.timeoutSeconds), { type: 'number', onCommit: v => save({ filters: { timeoutSeconds: Math.max(1, Math.min(1209600, Number(v) || 60)) } }) })));
  c.append(g);
  c.append(switchRow('Never act on mods', 'Moderators and you are never deleted or timed out automatically.', f.exemptMods, v => save({ filters: { exemptMods: v } })));
  return c;
}

function logsCard(s) {
  const c = card(null, 'Saved chat');
  c.append(el('p', 'help', 'Chat and events are saved on the machine running StreamChat, so you can search them later (Ctrl+F) and a restart doesn\'t empty the window.'));
  c.append(switchRow('Save chat', null, s.logs.enabled, v => save({ logs: { enabled: v } })));
  c.append(field('Keep for', select(String(s.logs.keepDays), [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', '1 year'], ['3650', 'Forever (10 years)']], v => save({ logs: { keepDays: Number(v) } }))));
  const usage = el('p', 'help');
  c.append(usage);
  api('GET', '/api/logs/usage').then(u => {
    const mb = (u.bytes / 1048576).toFixed(u.bytes > 10485760 ? 0 : 1);
    const people = Object.values(u.viewers).reduce((a, b) => a + b, 0);
    usage.textContent = u.days ? `${u.days} day${u.days === 1 ? '' : 's'} saved (${mb} MB) since ${u.oldest}. ${people.toLocaleString()} different people have chatted.` : 'Nothing saved yet.';
  }).catch(() => {});
  return c;
}

// ---------------------------------------------------------------- Overlay studio

const FONTS = ['Inter', 'Poppins', 'Montserrat', 'Nunito', 'Rubik', 'Outfit', 'Lexend', 'Roboto', 'Fredoka', 'Bebas Neue', 'Press Start 2P', 'Segoe UI', 'Arial'];

function overlay() {
  const t = state.pub.settings.overlay;
  const k = state.pub.overlayKey;
  heading('Overlay studio', 'Style the chat that appears on your stream. Changes show up live in the preview and in OBS.');

  const urls = card(null, 'Add to OBS');
  urls.append(el('p', 'help', 'In OBS: Sources → + → Browser. Paste the URL, set the size (e.g. 450 × 800 for chat, 1920 × 1080 for alerts), and leave "Shutdown source when not visible" off.'));
  urls.append(field('Chat overlay URL', copyField(`${origin()}/overlay/chat?k=${k}`)));
  urls.append(field('Alerts overlay URL', copyField(`${origin()}/overlay/alerts?k=${k}`)));
  if (/127\.0\.0\.1|localhost/.test(location.host)) urls.append(el('p', 'help', 'These links work on this PC. If StreamChat runs on your server, open the app from the server address instead so the links point there.'));
  body.append(urls);

  const studio = el('div', 'studio');
  const controls = el('div');
  const pv = el('div', 'studio-preview');
  studio.append(controls, pv);
  body.append(studio);

  // preview
  const frame = el('div', 'preview-frame scene');
  const iframe = el('iframe');
  iframe.src = `/overlay/chat?k=${encodeURIComponent(k)}&preview=1`;
  iframe.title = 'Overlay preview';
  frame.append(iframe);
  // Render at a typical OBS source size (450 × 800) and scale it to fit the panel.
  new ResizeObserver(() => frame.style.setProperty('--s', String(frame.clientWidth / 450))).observe(frame);
  frame.style.maxWidth = '360px';
  const bar = el('div', 'preview-bar');
  const seg = el('div', 'seg');
  for (const [id, label] of [['scene', 'Game scene'], ['checker', 'Transparent']]) {
    const b = el('button', null, label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(id === 'scene'));
    b.addEventListener('click', () => { frame.classList.toggle('scene', id === 'scene'); for (const x of seg.children) x.setAttribute('aria-pressed', String(x === b)); });
    seg.append(b);
  }
  bar.append(seg, btn('Reset style', 'undo', 'sm', async () => { state.pub = await api('POST', '/api/theme/reset', {}); renderSection(); }),
    btn('Clear stream chat', 'broom', 'sm', async () => { await api('POST', '/api/overlay/clear', {}); toast('Cleared the chat on stream', 'ok'); }));
  pv.append(frame, bar, el('p', 'help', 'The preview shows sample messages when chat is quiet.'));

  const set = (key, v) => save({ overlay: { [key]: v } }, 150);

  controls.append(el('div', 'group-title', 'Text'));
  controls.append(field('Font', select(t.fontFamily, FONTS.map(f => [f, f]), v => set('fontFamily', v))));
  controls.append(rangeField('Size', t.fontSize, { min: 12, max: 48, fmt: v => `${v}px`, onChange: v => set('fontSize', v) }));
  controls.append(rangeField('Weight', t.fontWeight, { min: 400, max: 800, step: 100, onChange: v => set('fontWeight', v) }));
  controls.append(rangeField('Emote size', t.emoteScale, { min: 0.6, max: 2.5, step: 0.1, fmt: v => `${Math.round(v * 100)}%`, onChange: v => set('emoteScale', v) }));
  controls.append(el('div', 'group-title', 'Background'));
  controls.append(field('Message background', select(t.bgMode || 'bubble', [['bubble', 'Bubble behind each message'], ['none', 'No background (just text)'], ['panel', 'One panel behind all chat']], v => {
    set('bgMode', v);
    if (v === 'none' && !state.pub.settings.overlay.textShadow) { set('textShadow', true); toast('Turned on text shadow so text stays readable without a background.'); setTimeout(renderSection, 300); }
    else setTimeout(renderSection, 300);
  })));
  const colors = el('div', 'color-row');
  const tc = el('input'); tc.type = 'color'; tc.value = t.textColor; tc.addEventListener('input', () => set('textColor', tc.value));
  colors.append(field('Text color', tc));
  const bc = el('input'); bc.type = 'color'; bc.value = t.bgColor; bc.addEventListener('input', () => set('bgColor', bc.value));
  if ((t.bgMode || 'bubble') !== 'none') colors.append(field(t.bgMode === 'panel' ? 'Panel color' : 'Bubble color', bc));
  controls.append(colors);
  if ((t.bgMode || 'bubble') !== 'none') controls.append(rangeField(t.bgMode === 'panel' ? 'Panel opacity' : 'Bubble opacity', t.bgOpacity, { min: 0, max: 1, step: 0.05, fmt: v => `${Math.round(v * 100)}%`, onChange: v => set('bgOpacity', v) }));
  controls.append(rangeField('Corner radius', t.radius, { min: 0, max: 28, fmt: v => `${v}px`, onChange: v => set('radius', v) }));
  controls.append(rangeField('Padding', t.padding, { min: 0, max: 24, fmt: v => `${v}px`, onChange: v => set('padding', v) }));
  controls.append(rangeField('Space between messages', t.gap, { min: 0, max: 24, fmt: v => `${v}px`, onChange: v => set('gap', v) }));

  controls.append(el('div', 'group-title', 'Show'));
  const pt = el('div', 'platform-toggles');
  for (const p of ['twitch', 'kick', 'tiktok', 'youtube']) {
    const b = el('button', 'ptoggle');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(t.platforms[p]));
    b.append(platformEl(p), el('span', null, PLATFORM[p].name));
    b.addEventListener('click', () => { const v = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(v)); set('platforms', { ...state.pub.settings.overlay.platforms, [p]: v }); });
    pt.append(b);
  }
  controls.append(pt);
  const sw = (title, key, desc) => switchRow(title, desc, t[key], v => set(key, v));
  controls.append(
    sw('Platform icons', 'showPlatformIcon'),
    sw('Badges', 'showBadges'),
    sw('Name colors', 'useUserColors', 'Use each chatter\'s own color.'),
    sw('Bold names', 'nameBold'),
    sw('Timestamps', 'showTimestamps'),
    sw('Text shadow', 'textShadow', 'Keeps text readable on bright scenes.'),
    sw('Outline', 'outline'),
    sw('Events in chat', 'showEvents', 'Follows, subs, gifts and raids as highlighted lines.'),
    sw('Hide !commands', 'hideCommands'),
  );

  controls.append(el('div', 'group-title', 'Behavior'));
  controls.append(field('Animation', select(t.animation, [['slide', 'Slide in'], ['fade', 'Fade in'], ['pop', 'Pop'], ['none', 'None']], v => set('animation', v))));
  controls.append(field('Direction', select(t.direction, [['up', 'Newest at the bottom'], ['down', 'Newest at the top']], v => set('direction', v))));
  controls.append(rangeField('Max messages', t.maxMessages, { min: 3, max: 100, onChange: v => set('maxMessages', v) }));
  controls.append(rangeField('Hide messages after', t.fadeAfter, { min: 0, max: 300, step: 5, fmt: v => v ? `${v}s` : 'Never', onChange: v => set('fadeAfter', v) }));
  controls.append(field('Hidden users', textInput(t.hideUsers.join(', '), { onCommit: v => set('hideUsers', v.split(/[,\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean)) }), 'Bots and anyone else to keep off stream (comma separated).'));
  const css = el('textarea');
  css.value = t.customCss;
  css.placeholder = '.msg { letter-spacing: .02em }';
  css.spellcheck = false;
  css.addEventListener('input', () => save({ overlay: { customCss: css.value } }, 500));
  controls.append(field('Custom CSS (advanced)', css));
}

// ---------------------------------------------------------------- Alerts

function alerts() {
  const a = state.pub.settings.alerts;
  const k = state.pub.overlayKey;
  heading('Alerts', 'Pop-up alerts for follows, subs, gifts and more. Add the alerts URL as its own Browser source in OBS.');
  const u = card(null, 'Alerts overlay');
  u.append(field('URL for OBS (1920 × 1080)', copyField(`${origin()}/overlay/alerts?k=${k}`)));
  u.append(switchRow('Alerts on', null, a.enabled, v => save({ alerts: { enabled: v } })));
  body.append(u);

  const types = card(null, 'Which events');
  const T = [['follow', 'Follows', 'All platforms'], ['sub', 'Subscriptions', 'New subs, resubs and YouTube members'], ['giftsub', 'Gifted subs', 'Twitch, Kick and YouTube memberships'], ['raid', 'Raids', 'Twitch'], ['bits', 'Bits', 'Twitch'], ['gift', 'Gifts', 'TikTok gifts and YouTube Super Chats'], ['kicks', 'Kicks', 'Kick'], ['share', 'Shares', 'TikTok'], ['like', 'Likes', 'TikTok, at most once a minute per viewer']];
  for (const [id, label, desc] of T) types.append(switchRow(label, desc, a.types[id], v => save({ alerts: { types: { [id]: v } } })));
  body.append(types);

  const look = card(null, 'Look & sound');
  const g = el('div', 'grid2');
  g.append(field('Minimum bits', textInput(String(a.minBits), { type: 'number', onCommit: v => save({ alerts: { minBits: Math.max(1, Number(v) || 1) } }) })));
  g.append(field('Minimum TikTok gift (coins)', textInput(String(a.minDiamonds), { type: 'number', onCommit: v => save({ alerts: { minDiamonds: Math.max(1, Number(v) || 1) } }) })));
  look.append(g);
  look.append(rangeField('Duration', a.durationSec, { min: 2, max: 20, fmt: v => `${v}s`, onChange: v => save({ alerts: { durationSec: v } }) }));
  look.append(rangeField('Chime volume', a.volume, { min: 0, max: 1, step: 0.05, fmt: v => v ? `${Math.round(v * 100)}%` : 'Off', onChange: v => save({ alerts: { volume: v } }) }));
  const cr = el('div', 'color-row');
  const ac = el('input'); ac.type = 'color'; ac.value = a.accent; ac.addEventListener('input', () => save({ alerts: { accent: ac.value } }));
  cr.append(field('Accent color', ac), field('Font', select(a.fontFamily, FONTS.map(f => [f, f]), v => save({ alerts: { fontFamily: v } }))));
  look.append(cr);
  body.append(look);

  const test = card(null, 'Test');
  test.append(el('p', 'help', 'Sends a fake alert to the alerts overlay (OBS and any open alerts page).'));
  const grid = el('div', 'test-grid');
  for (const [id, label] of [['follow', 'Follow'], ['sub', 'Sub'], ['giftsub', 'Gift subs'], ['raid', 'Raid'], ['bits', 'Bits'], ['gift', 'TikTok gift'], ['kicks', 'Kicks']]) {
    grid.append(btn(label, 'play', 'sm', () => api('POST', '/api/alerts/test', { type: id })));
  }
  grid.append(btn('Open alerts page', 'external', 'sm', () => openExternal(`${origin()}/overlay/alerts?k=${k}`)));
  test.append(grid);
  body.append(test);
}

// ---------------------------------------------------------------- Server

function server() {
  const p = state.pub;
  heading('Server', 'Where StreamChat is running and how to reach it.');
  const c = card(null, 'This connection');
  const kv = el('div', 'grid2');
  kv.append(field('Address', copyField(origin())), field('Version', textInput(p.version)));
  kv.lastChild.querySelector('input').readOnly = true;
  c.append(kv);
  c.append(field('Public address (optional)', textInput(p.settings.publicUrl, { placeholder: 'https://my-server.tailnet.ts.net', onCommit: v => save({ publicUrl: v.trim() }, 0) }),
    'Only needed when you open the app through a different address than the one Kick should redirect to after sign-in.'));
  body.append(c);

  const up = card(null, 'Updates');
  const u = p.update;
  if (u?.via === 'desktop') up.append(el('p', 'help', `You have StreamChat ${p.version}. The app checks for updates by itself and shows a banner when one is ready.`));
  else if (u?.available) up.append(el('p', 'help', `Version ${u.latest} is available (you have ${p.version}). ${u.via === 'script' ? 'The server installs updates every night, or run sudo streamchat update now.' : 'Download it from GitHub.'}`));
  else up.append(el('p', 'help', `You have StreamChat ${p.version}${u?.latest ? ', the newest version' : ''}.`));
  up.append(btn('Release notes', 'external', 'sm', () => openExternal(u?.url || 'https://github.com/JustSad42/streamchat/releases')));
  body.append(up);

  const inst = card(null, 'Run it on your server (Hetzner)');
  inst.append(el('p', 'help', 'On a fresh Ubuntu/Debian server, this one command installs Docker and Tailscale if needed, starts StreamChat, makes it reachable on your tailnet, sets up the Kick webhook address, and turns on nightly updates. It prints your app address and access key at the end.'));
  inst.append(copyField('curl -fsSL https://raw.githubusercontent.com/JustSad42/streamchat/main/install.sh | sudo bash'));
  inst.append(el('p', 'help', 'Then in the desktop app: tray icon → Change connection… → On my server.'));
  body.append(inst);

  const keys = card(null, 'Overlay link');
  keys.append(el('p', 'help', 'Anyone with the overlay link can see your chat overlay (read-only). Make a new link if it leaked; you\'ll need to paste the new URLs into OBS.'));
  keys.append(btn('Make new overlay link', 'refresh', 'sm danger', async () => {
    if (!confirm('Make a new overlay link? The old OBS URLs will stop working.')) return;
    state.pub = await api('POST', '/api/overlay/new-key', {});
    toast('New overlay link created. Update your OBS sources.', 'ok');
  }));
  body.append(keys);

  const log = card(null, 'Log');
  const pre = el('div', 'log', 'Loading…');
  log.append(pre, el('div', 'preview-bar'));
  log.lastChild.append(btn('Refresh', 'refresh', 'sm', loadLog), btn('Reconnect everything', 'radio', 'sm', async () => { await api('POST', '/api/reconnect', {}); toast('Reconnecting', 'ok'); }));
  body.append(log);
  async function loadLog() {
    const r = await api('GET', '/api/log');
    pre.textContent = r.lines.slice(-200).join('\n') || 'Nothing logged yet.';
    pre.scrollTop = pre.scrollHeight;
  }
  loadLog().catch(e => { pre.textContent = e.message; });
}
