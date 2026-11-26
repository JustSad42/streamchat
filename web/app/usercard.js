// The user card: profile, your nickname and notes for the person, their linked accounts on other
// platforms, moderation (here or on every linked platform), and their recent messages.

import { chatEl, el, iconEl, platformEl, readableColor } from '/shared/render.js';
import { PLATFORM } from '/shared/icons.js';
import { $, api, toast, enableLightDismiss, canMod, canSend, emit, on } from './core.js';
import { renderOpts } from './feed.js';

const dlg = $('#userCard');
enableLightDismiss(dlg);
let current = null; // { platform, user }

on('userCard', ({ platform, user }) => openUserCard(platform, user));

export async function mod(platform, action, okText) {
  try {
    await api('POST', '/api/mod', { platform, action });
    if (okText) toast(okText, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

export async function banWithUndo(platform, user) {
  try {
    await api('POST', '/api/mod', { platform, action: { type: 'ban', userId: user.id, login: user.login } });
    toast(`${user.name} was banned`, 'ok', { label: 'Undo', run: () => mod(platform, { type: 'unban', userId: user.id, login: user.login }, `${user.name} was unbanned`) });
  } catch (e) { toast(e.message, 'err'); }
}

/** Ban / time out / unban on this platform and every linked account you moderate. */
export async function modEverywhere(platform, user, action, verb) {
  try {
    const r = await api('POST', '/api/mod/all', { platform, action: { ...action, userId: user.id, login: user.login } });
    const ok = r.results.filter(x => x.ok).map(x => PLATFORM[x.platform].name);
    const bad = r.results.filter(x => !x.ok);
    if (ok.length) {
      toast(`${user.name} ${verb} on ${ok.join(' and ')}`, 'ok', action.type === 'ban'
        ? { label: 'Undo', run: () => modEverywhere(platform, user, { type: 'unban' }, 'unbanned') } : undefined);
    }
    for (const b of bad) toast(`${PLATFORM[b.platform].name}: ${b.message}`, 'err');
  } catch (e) { toast(e.message, 'err'); }
}

function fmtAge(iso) {
  const days = (Date.now() - (typeof iso === 'number' ? iso : Date.parse(iso))) / 864e5;
  if (days < 1) return 'less than a day';
  if (days < 60) return `${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'}`;
  if (days < 730) return `${Math.floor(days / 30.4)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
}
const fmtDate = ts => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

export async function openUserCard(platform, user) {
  current = { platform, user };
  dlg.style.setProperty('--pcolor', PLATFORM[platform]?.color);
  dlg.replaceChildren();
  const head = el('div', 'uc-head');
  const av = el('div', 'uc-av', (user.name || '?').slice(0, 1).toUpperCase());
  const info = el('div', 'uc-info');
  const name = el('h2', 'uc-name');
  name.id = 'ucName';
  name.append(platformEl(platform), el('span', null, user.name));
  const color = readableColor(user.color);
  if (color) name.lastChild.style.color = color;
  const sub = el('div', 'uc-sub', `@${user.login}`);
  info.append(name, sub);
  const close = el('button', 'icon-btn uc-close');
  close.setAttribute('aria-label', 'Close');
  close.append(iconEl('x'));
  close.addEventListener('click', () => dlg.close());
  head.append(av, info, close);
  dlg.append(head);

  const actions = el('div', 'uc-mod');
  const profileBtn = el('a', 'btn sm');
  profileBtn.append(iconEl('external'), el('span', null, 'Profile'));
  profileBtn.target = '_blank';
  profileBtn.rel = 'noopener';
  const searchBtn = el('button', 'btn sm');
  searchBtn.append(iconEl('search'), el('span', null, 'All messages'));
  searchBtn.title = 'Search everything this person has said';
  searchBtn.addEventListener('click', () => { dlg.close(); emit('search', { platform, userId: user.id, label: user.name }); });
  actions.append(profileBtn, searchBtn);
  if (canSend(platform)) {
    const b = el('button', 'btn sm'); b.append(iconEl('at'), el('span', null, 'Mention'));
    b.addEventListener('click', () => { dlg.close(); emit('insert', `@${user.login} `); });
    actions.append(b);
  }
  dlg.append(actions);

  const modRow = el('div', 'uc-mod');
  if (canMod(platform) && !user.broadcaster) {
    for (const [s, l] of [[60, '1m'], [600, '10m'], [3600, '1h'], [86400, '1d'], [604800, '7d']]) {
      const b = el('button', 'btn sm'); b.append(iconEl('clock'), el('span', null, l));
      b.title = `Timeout ${l}`;
      b.addEventListener('click', () => mod(platform, { type: 'timeout', userId: user.id, login: user.login, seconds: s }, `${user.name} timed out (${l})`));
      modRow.append(b);
    }
    const ban = el('button', 'btn sm danger'); ban.append(iconEl('ban'), el('span', null, 'Ban'));
    ban.addEventListener('click', () => banWithUndo(platform, user));
    const unban = el('button', 'btn sm'); unban.append(iconEl('undo'), el('span', null, 'Unban'));
    unban.addEventListener('click', () => mod(platform, { type: 'unban', userId: user.id, login: user.login }, `${user.name} was unbanned`));
    modRow.append(ban, unban);
    dlg.append(modRow);
  }
  const everywhere = el('div', 'uc-mod uc-everywhere');
  everywhere.hidden = true;
  dlg.append(everywhere);

  // Your notes about the person
  const notes = el('div', 'uc-notes');
  const nick = el('input', 'inp');
  nick.placeholder = 'Nickname (only you see it)';
  nick.maxLength = 40;
  nick.setAttribute('aria-label', 'Nickname');
  const note = el('textarea', 'inp');
  note.placeholder = 'Notes: who they are, what they play, inside jokes…';
  note.rows = 2;
  note.setAttribute('aria-label', 'Notes');
  const saved = el('small', 'uc-saved');
  let t = null;
  const saveNotes = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      try {
        await api('POST', '/api/viewer', { platform, id: user.id, login: user.login, name: user.name, nick: nick.value, note: note.value });
        saved.textContent = 'Saved';
        setTimeout(() => (saved.textContent = ''), 1500);
      } catch (e) { toast(e.message, 'err'); }
    }, 500);
  };
  nick.addEventListener('input', saveNotes);
  note.addEventListener('input', saveNotes);
  const nrow = el('div', 'uc-nick-row');
  nrow.append(iconEl('user'), nick, saved);
  notes.append(nrow, note);
  dlg.append(notes);

  // Linked accounts
  const linkBox = el('div', 'uc-links');
  dlg.append(linkBox);

  const histHead = el('div', 'uc-hist-head', 'Recent messages');
  const hist = el('div', 'uc-hist');
  dlg.append(histHead, hist);
  if (!dlg.open) dlg.showModal();

  try {
    const r = await api('GET', `/api/user?platform=${platform}&id=${encodeURIComponent(user.id)}&login=${encodeURIComponent(user.login)}`);
    if (current?.user !== user) return;
    const c = r.card;
    if (c.profileUrl) profileBtn.href = c.profileUrl; else profileBtn.remove();
    if (c.avatar) {
      const img = document.createElement('img');
      img.className = 'uc-av'; img.src = c.avatar; img.alt = '';
      av.replaceWith(img);
    }
    const v = r.viewer;
    const bits = [`@${c.login || user.login}`];
    if (c.createdAt) bits.push(`Account ${fmtAge(c.createdAt)} old`);
    if (c.followedAt) bits.push(`Following for ${fmtAge(c.followedAt)}`);
    else if (c.followedAt === null) bits.push('Not following');
    if (v.firstSeen) bits.push(`First chatted ${fmtDate(v.firstSeen)}`);
    if (v.messages) bits.push(`${v.messages.toLocaleString()} message${v.messages === 1 ? '' : 's'}`);
    sub.replaceChildren(...bits.map(b => el('span', null, b)));
    nick.value = v.nick;
    note.value = v.note;
    drawLinks(linkBox, platform, user, v.linked, everywhere);
    histHead.textContent = r.history.length ? `Recent messages (${r.history.length})` : 'No messages in the last while';
    const opts = { ...renderOpts(), onUser: null };
    hist.replaceChildren(...r.history.slice(-50).map(m => chatEl(m, { ...opts, timestamps: true })));
    hist.scrollTop = hist.scrollHeight;
  } catch (e) {
    histHead.textContent = e.message;
  }
}

function drawLinks(box, platform, user, linked, everywhere) {
  box.replaceChildren();
  const head = el('div', 'uc-section-title');
  head.append(iconEl('link'), el('span', null, 'Same person on other platforms'));
  box.append(head);
  const list = el('div', 'uc-link-list');
  for (const o of linked) {
    const chip = el('div', 'link-chip');
    const open = el('button', 'link-open');
    open.append(platformEl(o.platform), el('span', null, o.name));
    open.title = `Open ${o.name} on ${PLATFORM[o.platform].name}`;
    open.addEventListener('click', () => openUserCard(o.platform, { id: o.id, login: o.login, name: o.name, badges: [] }));
    const x = el('button', 'link-x'); x.append(iconEl('x')); x.title = 'Unlink';
    x.addEventListener('click', async () => {
      try { await api('POST', '/api/viewer/unlink', { platform: o.platform, id: o.id }); openUserCard(platform, user); }
      catch (e) { toast(e.message, 'err'); }
    });
    chip.append(open, x);
    list.append(chip);
  }
  const add = el('button', 'btn sm');
  add.append(iconEl('plus'), el('span', null, linked.length ? 'Link another' : 'Link an account'));
  list.append(add);
  box.append(list);

  const finder = el('div', 'link-finder');
  finder.hidden = true;
  const q = el('input', 'inp');
  q.placeholder = `Their name on ${['twitch', 'kick', 'tiktok', 'youtube'].filter(p => p !== platform).map(p => PLATFORM[p].name).join(' or ')}`;
  const res = el('div', 'link-results');
  finder.append(q, res, el('small', 'help', 'Shows people who have chatted in your channel.'));
  box.append(finder);
  add.addEventListener('click', () => { finder.hidden = !finder.hidden; if (!finder.hidden) q.focus(); });
  let t = null;
  q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      if (!q.value.trim()) { res.replaceChildren(); return; }
      const r = await api('GET', `/api/viewers/find?q=${encodeURIComponent(q.value)}&exclude=${platform}`).catch(() => ({ viewers: [] }));
      res.replaceChildren();
      if (!r.viewers.length) res.append(el('small', 'help', 'Nobody by that name has chatted yet.'));
      for (const v of r.viewers) {
        const b = el('button', 'link-result');
        b.append(platformEl(v.platform), el('b', null, v.name), el('small', null, v.login !== v.name.toLowerCase() ? `@${v.login}` : ''), el('small', 'muted', v.messages ? `${v.messages} msgs` : ''));
        b.addEventListener('click', async () => {
          try {
            await api('POST', '/api/viewer/link', { a: { platform, id: user.id, login: user.login, name: user.name }, b: { platform: v.platform, id: v.id, login: v.login, name: v.name } });
            toast(`Linked ${user.name} and ${v.name}`, 'ok');
            openUserCard(platform, user);
          } catch (e) { toast(e.message, 'err'); }
        });
        res.append(b);
      }
    }, 200);
  });

  // Moderate on every platform at once when the person is linked.
  const modPlatforms = [platform, ...linked.map(o => o.platform)].filter((p, i, a) => a.indexOf(p) === i && canMod(p));
  everywhere.replaceChildren();
  everywhere.hidden = !(linked.length && modPlatforms.length > 1 && !user.broadcaster);
  if (!everywhere.hidden) {
    const names = modPlatforms.map(p => PLATFORM[p].name).join(' + ');
    everywhere.append(el('span', 'uc-ev-label', `Everywhere (${names}):`));
    const to = el('button', 'btn sm'); to.append(iconEl('clock'), el('span', null, 'Timeout 10m'));
    to.addEventListener('click', () => modEverywhere(platform, user, { type: 'timeout', seconds: 600 }, 'timed out for 10 minutes'));
    const ban = el('button', 'btn sm danger'); ban.append(iconEl('ban'), el('span', null, 'Ban everywhere'));
    ban.addEventListener('click', () => modEverywhere(platform, user, { type: 'ban' }, 'banned'));
    const un = el('button', 'btn sm'); un.append(iconEl('undo'), el('span', null, 'Unban everywhere'));
    un.addEventListener('click', () => modEverywhere(platform, user, { type: 'unban' }, 'unbanned'));
    everywhere.append(to, ban, un);
  }
}
