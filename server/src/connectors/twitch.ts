// Twitch: chat over IRC-over-WebSocket (works signed out for reading), Helix for moderation,
// badges and user cards, EventSub WebSocket for follows and channel point redemptions.
// Sign-in uses the Device Code flow, so only a public Client ID is needed (no secret, no redirect URL).

import type { Badge, ChatMessage, ChatUser, EventMessage, ModAction } from '../types.ts';
import { hub, localId } from '../hub.ts';
import { emotes, toParts, type NativeEmote } from '../emotes.ts';
import { secrets, saveSecrets, settings } from '../config.ts';
import { logger } from '../log.ts';
import { backoff, UserError, type Connector, type UserCard } from './base.ts';
import { needUser, parseDuration, Unsupported, type ParsedCommand } from '../commands.ts';

const log = logger('twitch');

export const TWITCH_SCOPES = [
  'chat:read', 'chat:edit', 'user:read:emotes',
  'moderator:manage:banned_users', 'moderator:manage:chat_messages', 'moderator:read:followers',
  'channel:read:redemptions',
  // for slash commands
  'moderator:manage:chat_settings', 'moderator:manage:shoutouts', 'moderator:manage:announcements',
  'channel:manage:raids', 'channel:manage:moderators', 'channel:manage:vips',
];

/** Permissions added in a newer version that this sign-in doesn't have yet. */
export function missingTwitchScopes() {
  if (!secrets.twitch.accessToken) return [];
  const have = new Set(secrets.twitch.scopes || []);
  return TWITCH_SCOPES.filter(s => !have.has(s));
}

// ---------------- Auth (device code flow) ----------------

export interface DeviceFlow { userCode: string; verificationUri: string; expiresAt: number; error?: string; done?: boolean }
let deviceFlow: DeviceFlow | null = null;
let deviceAbort: AbortController | null = null;

export function twitchDeviceFlow() { return deviceFlow; }

export async function startTwitchLogin(onDone: () => void) {
  const clientId = secrets.twitch.clientId;
  if (!clientId) throw new UserError('Add your Twitch Client ID first (Settings → Twitch).');
  deviceAbort?.abort();
  const abort = (deviceAbort = new AbortController());
  const r = await fetch('https://id.twitch.tv/oauth2/device', {
    method: 'POST',
    body: new URLSearchParams({ client_id: clientId, scopes: TWITCH_SCOPES.join(' ') }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new UserError(`Twitch refused the sign-in: ${j.message || r.status}. Is the app set to "Public" client type?`);
  deviceFlow = { userCode: j.user_code, verificationUri: j.verification_uri, expiresAt: Date.now() + j.expires_in * 1000 };

  (async () => {
    const interval = Math.max(1, j.interval || 5) * 1000;
    while (!abort.signal.aborted && Date.now() < deviceFlow!.expiresAt) {
      await new Promise(res => setTimeout(res, interval));
      if (abort.signal.aborted) return;
      const t = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: clientId, scopes: TWITCH_SCOPES.join(' '), device_code: j.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      }).catch(() => null);
      if (!t) continue;
      const tj: any = await t.json().catch(() => ({}));
      if (t.ok) {
        secrets.twitch.accessToken = tj.access_token;
        secrets.twitch.refreshToken = tj.refresh_token;
        secrets.twitch.expiresAt = Date.now() + (tj.expires_in || 3600) * 1000;
        secrets.twitch.scopes = tj.scope;
        await validate();
        saveSecrets();
        deviceFlow = { ...deviceFlow!, done: true };
        log.info(`signed in as ${secrets.twitch.login}`);
        onDone();
        return;
      }
      if (tj.message === 'authorization_pending' || tj.message === 'slow_down') continue;
      deviceFlow = { ...deviceFlow!, error: tj.message || 'Sign-in failed' };
      return;
    }
    if (deviceFlow && !deviceFlow.done) deviceFlow = { ...deviceFlow, error: 'The code expired. Try again.' };
  })().catch(e => { deviceFlow = { ...deviceFlow!, error: String(e.message || e) }; });
}

export function twitchLogout() {
  const token = secrets.twitch.accessToken;
  if (token && secrets.twitch.clientId) {
    fetch('https://id.twitch.tv/oauth2/revoke', {
      method: 'POST', body: new URLSearchParams({ client_id: secrets.twitch.clientId, token }),
    }).catch(() => {});
  }
  secrets.twitch = { clientId: secrets.twitch.clientId };
  saveSecrets();
  deviceFlow = null;
}

async function validate() {
  const r = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${secrets.twitch.accessToken}` } });
  if (!r.ok) return false;
  const j: any = await r.json();
  secrets.twitch.login = j.login;
  secrets.twitch.userId = j.user_id;
  secrets.twitch.scopes = j.scopes;
  return true;
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const { clientId, refreshToken } = secrets.twitch;
    if (!clientId || !refreshToken) return false;
    const r = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken }),
    }).catch(() => null);
    if (!r) return false;
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      log.warn(`token refresh failed (${j.message || r.status}); sign in again`);
      if (r.status === 400 || r.status === 401) { secrets.twitch = { clientId }; saveSecrets(); }
      return false;
    }
    secrets.twitch.accessToken = j.access_token;
    secrets.twitch.refreshToken = j.refresh_token;
    secrets.twitch.expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
    saveSecrets();
    return true;
  })().finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

const signedIn = () => !!(secrets.twitch.accessToken && secrets.twitch.clientId && secrets.twitch.login);

async function helix(method: string, path: string, body?: unknown, retry = true): Promise<any> {
  if (!signedIn()) throw new UserError('Sign in to Twitch first.');
  if ((secrets.twitch.expiresAt || 0) - Date.now() < 120_000) await refresh();
  const r = await fetch(`https://api.twitch.tv/helix${path}`, {
    method,
    headers: {
      'Client-Id': secrets.twitch.clientId!,
      Authorization: `Bearer ${secrets.twitch.accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && retry && (await refresh())) return helix(method, path, body, false);
  if (r.status === 204) return null;
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new UserError(`Twitch: ${j.message || r.statusText}`);
  return j;
}

// ---------------- IRC parsing ----------------

interface IrcMsg { tags: Record<string, string>; prefix: string; command: string; params: string[] }

function unescapeTag(v: string) {
  return v.replace(/\\(.)/g, (_, c) => ({ s: ' ', ':': ';', '\\': '\\', r: '\r', n: '\n' } as any)[c] ?? c);
}

export function parseIrc(line: string): IrcMsg {
  let i = 0;
  const tags: Record<string, string> = {};
  if (line[0] === '@') {
    const sp = line.indexOf(' ');
    for (const kv of line.slice(1, sp).split(';')) {
      const eq = kv.indexOf('=');
      tags[eq < 0 ? kv : kv.slice(0, eq)] = eq < 0 ? '' : unescapeTag(kv.slice(eq + 1));
    }
    i = sp + 1;
  }
  let prefix = '';
  if (line[i] === ':') {
    const sp = line.indexOf(' ', i);
    prefix = line.slice(i + 1, sp);
    i = sp + 1;
  }
  const rest = line.slice(i);
  const trailingAt = rest.indexOf(' :');
  const head = trailingAt >= 0 ? rest.slice(0, trailingAt) : rest;
  const params = head.split(' ').filter(Boolean);
  const command = params.shift() || '';
  if (trailingAt >= 0) params.push(rest.slice(trailingAt + 2));
  else if (rest.startsWith(':')) params.push(rest.slice(1));
  return { tags, prefix, command, params };
}

const DEFAULT_COLORS = ['#FF4A4A', '#4A7BFF', '#4AFF7B', '#B22222', '#FF7F50', '#9ACD32', '#FF6A00', '#2E8B57', '#DAA520', '#D2691E', '#5F9EA0', '#1E90FF', '#FF69B4', '#8A2BE2', '#00FF7F'];
export function defaultColor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return DEFAULT_COLORS[Math.abs(h) % DEFAULT_COLORS.length];
}

// ---------------- Connector ----------------

export class TwitchConnector implements Connector {
  platform = 'twitch' as const;
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private channel = '';
  private roomId = '';
  private badges = new Map<string, { title: string; url: string }>();
  private myEmotes = new Map<string, { id: string; name: string }>();
  private userState: { color?: string; badges?: string; badgeInfo?: string; displayName?: string } = {};
  private pingTimer: NodeJS.Timeout | null = null;
  private lastData = 0;
  private es: WebSocket | null = null;
  private esAttempt = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private streamTimer: NodeJS.Timeout | null = null;

  emoteChannelId() { return this.roomId || undefined; }

  async start() {
    this.stopped = false;
    this.channel = (settings.twitch.channel || secrets.twitch.login || '').toLowerCase().replace(/^#/, '').trim();
    if (!settings.twitch.enabled || !this.channel) {
      hub.setStatus('twitch', { state: 'off', detail: this.channel ? 'Turned off' : 'No channel set' });
      return;
    }
    if (signedIn()) {
      if (!(await validate().catch(() => false)) && !(await refresh())) log.warn('stored Twitch sign-in is no longer valid');
      else if (!secrets.twitch.login) await validate();
    }
    hub.selfNames.twitch = [secrets.twitch.login, this.channel].filter(Boolean) as string[];
    this.connect();
    this.refreshTimer = setInterval(() => {
      if (signedIn() && (secrets.twitch.expiresAt || 0) - Date.now() < 15 * 60_000) refresh();
    }, 5 * 60_000);
  }

  async stop() {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.streamTimer) clearInterval(this.streamTimer);
    this.streamTimer = null;
    this.ws?.close();
    this.ws = null;
    this.es?.close();
    this.es = null;
    if (this.roomId) emotes.dropChannel('twitch', this.roomId);
    this.roomId = '';
    hub.setStatus('twitch', { state: 'off' });
  }

  async restart() { await this.stop(); await this.start(); }

  private status(state: 'connecting' | 'connected' | 'error', detail?: string) {
    const auth = signedIn();
    const isBroadcaster = auth && secrets.twitch.login === this.channel;
    const cur = hub.status.twitch;
    hub.setStatus('twitch', {
      state, detail, channel: this.channel,
      loggedInAs: auth ? secrets.twitch.login : undefined,
      canSend: auth, canModerate: auth && (isBroadcaster || this.userState.badges?.includes('moderator') === true),
      live: cur.live, viewers: cur.viewers, startedAt: cur.startedAt,
    });
  }

  private connect() {
    if (this.stopped) return;
    this.status('connecting');
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    this.ws = ws;
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      if (signedIn()) {
        ws.send(`PASS oauth:${secrets.twitch.accessToken}`);
        ws.send(`NICK ${secrets.twitch.login}`);
      } else {
        ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
      }
      ws.send(`JOIN #${this.channel}`);
      this.lastData = Date.now();
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastData > 6 * 60_000) { log.warn('IRC went quiet, reconnecting'); ws.close(); return; }
        if (ws.readyState === WebSocket.OPEN) ws.send('PING :streamchat');
      }, 60_000);
    };
    ws.onmessage = ev => {
      this.lastData = Date.now();
      for (const line of String(ev.data).split('\r\n')) if (line) this.handle(parseIrc(line));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      const delay = backoff(this.attempt++);
      this.status('connecting', `Reconnecting in ${Math.round(delay / 1000)}s`);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private handle(m: IrcMsg) {
    switch (m.command) {
      case 'PING': this.ws?.send(`PONG :${m.params[0] || 'tmi.twitch.tv'}`); break;
      case 'RECONNECT': this.ws?.close(); break;
      case 'JOIN':
        this.attempt = 0;
        this.status('connected');
        break;
      case 'ROOMSTATE':
        if (m.tags['room-id'] && m.tags['room-id'] !== this.roomId) {
          this.roomId = m.tags['room-id'];
          this.onRoom().catch(e => log.warn('room setup:', e));
        }
        break;
      case 'USERSTATE':
        this.userState = { color: m.tags.color, badges: m.tags.badges, badgeInfo: m.tags['badge-info'], displayName: m.tags['display-name'] };
        this.status('connected');
        break;
      case 'PRIVMSG': this.onPrivmsg(m); break;
      case 'USERNOTICE': this.onUserNotice(m); break;
      case 'CLEARMSG': if (m.tags['target-msg-id']) hub.markDeleted('twitch', m.tags['target-msg-id']); break;
      case 'CLEARCHAT': this.onClearChat(m); break;
      case 'NOTICE': {
        const text = m.params[1] || '';
        if (/Login authentication failed|Improperly formatted auth/i.test(text)) {
          log.warn('IRC sign-in rejected, refreshing token');
          refresh().then(ok => { if (!ok) log.warn('continuing signed out'); this.ws?.close(); });
        } else {
          log.info('notice:', text);
          hub.emit('notice', { platform: 'twitch', text });
        }
        break;
      }
    }
  }

  private async onRoom() {
    await emotes.loadChannel('twitch', this.roomId);
    if (signedIn()) {
      await this.loadBadges().catch(e => log.warn('badges:', e));
      await this.loadMyEmotes().catch(e => log.warn('your emotes:', e));
      this.connectEventSub();
      this.pollStream();
      if (this.streamTimer) clearInterval(this.streamTimer);
      this.streamTimer = setInterval(() => this.pollStream(), 60_000);
    }
  }

  // Live status, viewer count and start time for the stats bar.
  private async pollStream() {
    if (this.stopped || !signedIn() || !this.roomId) return;
    const s = (await helix('GET', `/streams?user_id=${this.roomId}`).catch(() => null))?.data?.[0];
    if (this.stopped) return;
    const patch = s ? { live: true, viewers: Number(s.viewer_count) || 0, startedAt: Date.parse(s.started_at) || undefined } : { live: false, viewers: undefined, startedAt: undefined };
    const cur = hub.status.twitch;
    if (cur.live !== patch.live || cur.viewers !== patch.viewers || cur.startedAt !== patch.startedAt) hub.patchStatus('twitch', patch);
  }

  /** Twitch user id for a login. */
  async userIdFor(login: string): Promise<string> {
    login = login.replace(/^@/, '').toLowerCase();
    const seen = hub.findUserByLogin('twitch', login);
    if (seen && /^\d+$/.test(seen.id)) return seen.id;
    const u = (await helix('GET', `/users?login=${encodeURIComponent(login)}`))?.data?.[0];
    if (!u) throw new UserError(`No Twitch user called ${login}.`);
    return u.id;
  }

  async command(c: ParsedCommand): Promise<string> {
    if (!signedIn()) throw new UserError('Sign in to Twitch to use commands.');
    if (!this.roomId) throw new UserError('Not connected to Twitch chat yet.');
    const me = secrets.twitch.userId!, room = this.roomId;
    const q = `broadcaster_id=${room}&moderator_id=${me}`;
    const need = (scope: string, what: string) => {
      if (!secrets.twitch.scopes?.includes(scope)) throw new UserError(`Sign in to Twitch again (Settings → Accounts) to allow ${what}.`);
    };
    const chatSettings = async (body: Record<string, unknown>, ok: string) => {
      need('moderator:manage:chat_settings', 'changing chat modes');
      await helix('PATCH', `/chat/settings?${q}`, body);
      return ok;
    };
    switch (c.name) {
      case 'ban': { const u = needUser(c); await this.moderate({ type: 'ban', userId: await this.userIdFor(u), login: u, reason: c.args.slice(1).join(' ') }); return `Banned ${u}`; }
      case 'unban': { const u = needUser(c); await this.moderate({ type: 'unban', userId: await this.userIdFor(u), login: u }); return `Unbanned ${u}`; }
      case 'timeout': {
        const u = needUser(c);
        const d = parseDuration(c.args[1]);
        const secs = Math.max(1, Math.min(1209600, d ?? 600));
        await this.moderate({ type: 'timeout', userId: await this.userIdFor(u), login: u, seconds: secs, reason: c.args.slice(d != null ? 2 : 1).join(' ') });
        return `Timed out ${u} for ${fmtDuration(secs)}`;
      }
      case 'me': if (!c.rest) throw new UserError('Usage: /me <text>'); await this.send(`/me ${c.rest}`); return '';
      case 'clear': await helix('DELETE', `/moderation/chat?${q}`); return 'Chat cleared';
      case 'slow': { const s = Math.max(3, Math.min(120, parseDuration(c.args[0]) ?? 30)); return chatSettings({ slow_mode: true, slow_mode_wait_time: s }, `Slow mode on (${s}s)`); }
      case 'slowoff': return chatSettings({ slow_mode: false }, 'Slow mode off');
      case 'emoteonly': return chatSettings({ emote_mode: true }, 'Emote-only mode on');
      case 'emoteonlyoff': return chatSettings({ emote_mode: false }, 'Emote-only mode off');
      case 'followers': { const m = Math.min(129600, Math.round((parseDuration(c.args[0]) ?? 0) / 60)); return chatSettings({ follower_mode: true, follower_mode_duration: m }, m ? `Followers-only mode on (${fmtDuration(m * 60)})` : 'Followers-only mode on'); }
      case 'followersoff': return chatSettings({ follower_mode: false }, 'Followers-only mode off');
      case 'subscribers': return chatSettings({ subscriber_mode: true }, 'Subscribers-only mode on');
      case 'subscribersoff': return chatSettings({ subscriber_mode: false }, 'Subscribers-only mode off');
      case 'uniquechat': return chatSettings({ unique_chat_mode: true }, 'Unique-chat mode on');
      case 'uniquechatoff': return chatSettings({ unique_chat_mode: false }, 'Unique-chat mode off');
      case 'shoutout': { need('moderator:manage:shoutouts', 'shoutouts'); const u = needUser(c); await helix('POST', `/chat/shoutouts?from_broadcaster_id=${room}&to_broadcaster_id=${await this.userIdFor(u)}&moderator_id=${me}`); return `Shoutout sent to ${u}`; }
      case 'announce': { need('moderator:manage:announcements', 'announcements'); if (!c.rest) throw new UserError('Usage: /announce <text>'); await helix('POST', `/chat/announcements?${q}`, { message: c.rest.slice(0, 500) }); return ''; }
      case 'raid': { need('channel:manage:raids', 'raids'); const u = needUser(c); await helix('POST', `/raids?from_broadcaster_id=${room}&to_broadcaster_id=${await this.userIdFor(u)}`); return `Raiding ${u}. Twitch starts it in about 90 seconds.`; }
      case 'unraid': need('channel:manage:raids', 'raids'); await helix('DELETE', `/raids?broadcaster_id=${room}`); return 'Raid cancelled';
      case 'mod': { need('channel:manage:moderators', 'adding moderators'); const u = needUser(c); await helix('POST', `/moderation/moderators?broadcaster_id=${room}&user_id=${await this.userIdFor(u)}`); return `${u} is now a moderator`; }
      case 'unmod': { need('channel:manage:moderators', 'removing moderators'); const u = needUser(c); await helix('DELETE', `/moderation/moderators?broadcaster_id=${room}&user_id=${await this.userIdFor(u)}`); return `${u} is no longer a moderator`; }
      case 'vip': { need('channel:manage:vips', 'VIPs'); const u = needUser(c); await helix('POST', `/channels/vips?broadcaster_id=${room}&user_id=${await this.userIdFor(u)}`); return `${u} is now a VIP`; }
      case 'unvip': { need('channel:manage:vips', 'VIPs'); const u = needUser(c); await helix('DELETE', `/channels/vips?broadcaster_id=${room}&user_id=${await this.userIdFor(u)}`); return `${u} is no longer a VIP`; }
    }
    throw new Unsupported();
  }

  private async loadBadges() {
    const [g, c] = await Promise.all([helix('GET', '/chat/badges/global'), helix('GET', `/chat/badges?broadcaster_id=${this.roomId}`)]);
    for (const set of [...(g?.data || []), ...(c?.data || [])]) {
      for (const v of set.versions) this.badges.set(`${set.set_id}/${v.id}`, { title: v.title, url: v.image_url_2x });
    }
  }

  private async loadMyEmotes() {
    if (!secrets.twitch.scopes?.includes('user:read:emotes')) return;
    let cursor = '';
    this.myEmotes.clear();
    for (let page = 0; page < 20; page++) {
      const j = await helix('GET', `/chat/emotes/user?user_id=${secrets.twitch.userId}&broadcaster_id=${this.roomId}${cursor ? `&after=${cursor}` : ''}`);
      for (const e of j?.data || []) this.myEmotes.set(e.name, { id: e.id, name: e.name });
      cursor = j?.pagination?.cursor;
      if (!cursor) break;
    }
  }

  nativeEmoteList() {
    return [...this.myEmotes.values()].map(e => ({ name: e.name, url: emoteUrl(e.id), src: 'twitch' as const }));
  }

  private parseBadges(badgeTag = '', infoTag = ''): Badge[] {
    const out: Badge[] = [];
    const info = new Map(infoTag.split(',').filter(Boolean).map(x => x.split('/') as [string, string]));
    for (const b of badgeTag.split(',').filter(Boolean)) {
      const [set, ver] = b.split('/');
      const found = this.badges.get(b);
      let title = found?.title || set;
      if (set === 'subscriber' && info.get('subscriber')) title = `Subscriber (${info.get('subscriber')} months)`;
      out.push({ id: b, title, url: found?.url });
    }
    return out;
  }

  private user(tags: Record<string, string>, loginFallback: string): ChatUser {
    const login = tags.login || loginFallback;
    const name = tags['display-name'] || login;
    const badges = this.parseBadges(tags.badges, tags['badge-info']);
    return {
      id: tags['user-id'] || login,
      login, name,
      color: tags.color || defaultColor(login),
      badges,
      mod: tags.mod === '1' || badges.some(b => b.id.startsWith('moderator')),
      broadcaster: badges.some(b => b.id.startsWith('broadcaster')),
    };
  }

  private nativeEmotes(tag: string | undefined, text: string): NativeEmote[] {
    if (!tag) return [];
    const chars = Array.from(text);
    const out: NativeEmote[] = [];
    for (const group of tag.split('/')) {
      const [id, ranges] = group.split(':');
      if (!ranges) continue;
      for (const r of ranges.split(',')) {
        const [s, e] = r.split('-').map(Number);
        out.push({ start: s, end: e, name: chars.slice(s, e + 1).join(''), url: emoteUrl(id), src: 'twitch' });
      }
    }
    return out;
  }

  private onPrivmsg(m: IrcMsg) {
    let text = m.params[1] || '';
    let action = false;
    const am = /^\u0001ACTION (.*)\u0001$/.exec(text);
    if (am) { text = am[1]; action = true; }
    // Chat clients append an invisible character to dodge Twitch's duplicate-message filter.
    text = text.replace(/[\s͏​-‍\u{E0000}]+$/u, '');
    const login = m.prefix.split('!')[0];
    const user = this.user(m.tags, login);
    const parts = toParts('twitch', this.roomId, text, this.nativeEmotes(m.tags.emotes, text));
    const msg: ChatMessage = {
      kind: 'chat', id: m.tags.id || localId('tw'), platform: 'twitch',
      ts: Number(m.tags['tmi-sent-ts']) || Date.now(),
      user, text, parts,
      flags: { action, firstMsg: m.tags['first-msg'] === '1' },
    };
    if (m.tags['reply-parent-display-name']) {
      msg.reply = { user: m.tags['reply-parent-display-name'], text: m.tags['reply-parent-msg-body'] || '' };
    }
    hub.push(msg);
    const bits = Number(m.tags.bits || 0);
    if (bits > 0) {
      hub.push({
        kind: 'event', id: `bits-${msg.id}`, platform: 'twitch', ts: msg.ts, type: 'bits', user,
        title: `${user.name} cheered ${bits} bits`, amount: bits, parts, alert: bits >= settings.alerts.minBits,
      });
    }
  }

  private onUserNotice(m: IrcMsg) {
    const t = m.tags;
    const kind = t['msg-id'];
    const login = t.login || '';
    const user = this.user(t, login);
    const text = m.params[1] || '';
    const parts = text ? toParts('twitch', this.roomId, text, this.nativeEmotes(t.emotes, text)) : undefined;
    const base = { kind: 'event' as const, id: t.id || localId('twn'), platform: 'twitch' as const, ts: Number(t['tmi-sent-ts']) || Date.now(), user, parts };
    const sys = t['system-msg'] || '';
    let ev: EventMessage | null = null;
    switch (kind) {
      case 'sub': case 'resub': {
        const months = Number(t['msg-param-cumulative-months'] || 1);
        ev = { ...base, type: kind, amount: months, alert: true, title: kind === 'sub' ? `${user.name} subscribed` : `${user.name} resubscribed for ${months} months` };
        break;
      }
      case 'subgift':
        if (t['msg-param-community-gift-id']) return; // part of a bigger gift; that one is shown instead
        ev = { ...base, type: 'giftsub', amount: 1, alert: true, title: `${user.name} gifted a sub to ${t['msg-param-recipient-display-name']}` };
        break;
      case 'submysterygift': {
        const n = Number(t['msg-param-mass-gift-count'] || 1);
        ev = { ...base, type: 'giftsub', amount: n, alert: true, title: `${user.name} gifted ${n} subs` };
        break;
      }
      case 'raid': {
        const n = Number(t['msg-param-viewerCount'] || 0);
        ev = { ...base, type: 'raid', amount: n, alert: true, title: `${t['msg-param-displayName'] || user.name} is raiding with ${n} viewers` };
        break;
      }
      case 'announcement':
        ev = { ...base, type: 'announcement', title: `Announcement from ${user.name}` };
        break;
      default:
        if (sys) ev = { ...base, type: 'announcement', title: sys };
    }
    if (ev) hub.push(ev);
  }

  private onClearChat(m: IrcMsg) {
    const userId = m.tags['target-user-id'];
    if (!userId) return; // whole chat cleared: ignore, keep our history
    hub.clearUser('twitch', userId);
    const login = m.params[1] || '';
    const dur = Number(m.tags['ban-duration'] || 0);
    hub.push({
      kind: 'event', id: localId('twban'), platform: 'twitch', ts: Date.now(),
      type: dur ? 'timeout' : 'ban',
      title: dur ? `${login} was timed out for ${fmtDuration(dur)}` : `${login} was banned`,
    });
  }

  // ---------------- EventSub (follows, redemptions) ----------------

  private connectEventSub(url = 'wss://eventsub.wss.twitch.tv/ws') {
    if (this.stopped || !signedIn()) return;
    const isReconnect = url !== 'wss://eventsub.wss.twitch.tv/ws';
    const old = this.es;
    const es = new WebSocket(url);
    es.onmessage = async ev => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      const type = msg.metadata?.message_type;
      if (type === 'session_welcome') {
        this.es = es;
        if (old && old !== es) old.close();
        this.esAttempt = 0;
        // Subscriptions carry over when Twitch moves us to a new server.
        if (!isReconnect) await this.subscribeEvents(msg.payload.session.id);
      } else if (type === 'session_reconnect') {
        this.connectEventSub(msg.payload.session.reconnect_url);
      } else if (type === 'notification') {
        this.onEventSub(msg.payload.subscription.type, msg.payload.event, msg.metadata.message_id);
      }
    };
    es.onclose = () => {
      if (this.es !== es || this.stopped) return;
      this.es = null;
      setTimeout(() => this.connectEventSub(), backoff(this.esAttempt++));
    };
    es.onerror = () => {};
  }

  private async subscribeEvents(sessionId: string) {
    const me = secrets.twitch.userId!;
    const transport = { method: 'websocket', session_id: sessionId };
    const subs: any[] = [
      { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: this.roomId, moderator_user_id: me } },
    ];
    if (me === this.roomId) {
      subs.push({ type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: { broadcaster_user_id: this.roomId } });
    }
    for (const s of subs) {
      try { await helix('POST', '/eventsub/subscriptions', { ...s, transport }); }
      catch (e: any) { log.warn(`can't receive ${s.type}: ${e.message}`); }
    }
  }

  private onEventSub(type: string, e: any, id: string) {
    if (type === 'channel.follow') {
      const user: ChatUser = { id: e.user_id, login: e.user_login, name: e.user_name, badges: [], color: defaultColor(e.user_login) };
      hub.push({ kind: 'event', id, platform: 'twitch', ts: Date.now(), type: 'follow', user, title: `${e.user_name} followed`, alert: true });
    } else if (type === 'channel.channel_points_custom_reward_redemption.add') {
      const user: ChatUser = { id: e.user_id, login: e.user_login, name: e.user_name, badges: [], color: defaultColor(e.user_login) };
      hub.push({
        kind: 'event', id, platform: 'twitch', ts: Date.now(), type: 'redeem', user,
        title: `${e.user_name} redeemed ${e.reward?.title}`, amount: e.reward?.cost,
        parts: e.user_input ? toParts('twitch', this.roomId, e.user_input) : undefined,
      });
    }
  }

  // ---------------- Actions ----------------

  async send(text: string, replyTo?: string) {
    if (!signedIn()) throw new UserError('Sign in to Twitch to send messages.');
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new UserError('Not connected to Twitch chat yet.');
    text = text.replace(/[\r\n]+/g, ' ').trim();
    if (!text) return;
    this.ws.send(`${replyTo ? `@reply-parent-msg-id=${replyTo} ` : ''}PRIVMSG #${this.channel} :${text}`);
    // Twitch doesn't echo your own messages back, so show it ourselves.
    let action = false;
    let body = text;
    if (/^\/me /i.test(text)) { action = true; body = text.slice(4); }
    const native: NativeEmote[] = [];
    let pos = 0;
    for (const word of body.split(/(\s+)/)) {
      const len = Array.from(word).length;
      const e = this.myEmotes.get(word);
      if (e) native.push({ start: pos, end: pos + len - 1, name: word, url: emoteUrl(e.id), src: 'twitch' });
      pos += len;
    }
    const login = secrets.twitch.login!;
    const user = this.user({ 'display-name': this.userState.displayName || login, color: this.userState.color || '', badges: this.userState.badges || '', 'badge-info': this.userState.badgeInfo || '', 'user-id': secrets.twitch.userId || login }, login);
    const parent = replyTo ? hub.get('twitch', replyTo) : undefined;
    hub.push({
      kind: 'chat', id: localId('tw-self'), platform: 'twitch', ts: Date.now(), user, text: body,
      parts: toParts('twitch', this.roomId, body, native), flags: { action, self: true },
      reply: parent && parent.kind === 'chat' ? { user: parent.user.name, text: parent.text } : undefined,
    });
  }

  async moderate(a: ModAction) {
    const q = `broadcaster_id=${this.roomId}&moderator_id=${secrets.twitch.userId}`;
    if (a.type === 'delete') await helix('DELETE', `/moderation/chat?${q}&message_id=${encodeURIComponent(a.messageId)}`);
    else if (a.type === 'timeout') await helix('POST', `/moderation/bans?${q}`, { data: { user_id: a.userId, duration: Math.max(1, Math.min(1209600, a.seconds)), reason: a.reason || '' } });
    else if (a.type === 'ban') await helix('POST', `/moderation/bans?${q}`, { data: { user_id: a.userId, reason: a.reason || '' } });
    else if (a.type === 'unban') await helix('DELETE', `/moderation/bans?${q}&user_id=${a.userId}`);
  }

  async userCard(userId: string, login: string): Promise<UserCard> {
    const card: UserCard = { platform: 'twitch', id: userId, login, name: login, profileUrl: `https://twitch.tv/${login}` };
    if (!signedIn()) return card;
    const u = (await helix('GET', `/users?id=${encodeURIComponent(userId)}`).catch(() => null))?.data?.[0];
    if (u) { card.name = u.display_name; card.avatar = u.profile_image_url; card.createdAt = u.created_at; }
    const f = await helix('GET', `/channels/followers?broadcaster_id=${this.roomId}&user_id=${encodeURIComponent(userId)}`).catch(() => null);
    if (f) card.followedAt = f.data?.[0]?.followed_at ?? null;
    return card;
  }
}

export function emoteUrl(id: string) {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;
}

export function fmtDuration(sec: number) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}
