// Kick through its official public API.
// Incoming chat and events arrive as signed webhooks (Kick POSTs them to a public HTTPS URL,
// e.g. a Tailscale Funnel). Sending and moderation use the REST API with your Kick sign-in.

import crypto from 'node:crypto';
import type { Badge, ChatUser, ModAction } from '../types.ts';
import { hub, localId } from '../hub.ts';
import { emotes, toParts, type NativeEmote } from '../emotes.ts';
import { secrets, saveSecrets, settings } from '../config.ts';
import { logger } from '../log.ts';
import { UserError, type Connector, type UserCard } from './base.ts';
import { defaultColor, fmtDuration } from './twitch.ts';
import { needUser, parseDuration, Unsupported, type ParsedCommand } from '../commands.ts';

const log = logger('kick');
const API = 'https://api.kick.com/public/v1';
export const KICK_SCOPES = ['user:read', 'channel:read', 'chat:write', 'events:subscribe', 'moderation:ban', 'moderation:chat_message:manage'];
const EVENTS = ['chat.message.sent', 'channel.followed', 'channel.subscription.new', 'channel.subscription.renewal',
  'channel.subscription.gifts', 'kicks.gifted', 'moderation.banned', 'livestream.status.updated', 'channel.reward.redemption.updated'];

// ---------------- OAuth 2.1 + PKCE ----------------

const pending = new Map<string, { verifier: string; redirect: string; at: number }>();

export function kickLoginUrl(origin: string) {
  const { clientId, clientSecret } = secrets.kick;
  if (!clientId || !clientSecret) throw new UserError('Add your Kick Client ID and Client Secret first (Settings → Kick).');
  // Kick's sign-in page mangles 127.0.0.1 redirect URLs, so always use "localhost" for local setups.
  const base = (settings.publicUrl || origin).replace(/\/+$/, '').replace('//127.0.0.1', '//localhost');
  const redirect = `${base}/auth/kick/callback`;
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60_000) pending.delete(k);
  pending.set(state, { verifier, redirect, at: Date.now() });
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: KICK_SCOPES.join(' '),
    code_challenge: challenge, code_challenge_method: 'S256', state,
  });
  return { url: `https://id.kick.com/oauth/authorize?${q}`, redirect };
}

export async function kickCallback(code: string, state: string) {
  const p = pending.get(state);
  if (!p) throw new UserError('This sign-in link expired. Start again from the app.');
  pending.delete(state);
  const r = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: secrets.kick.clientId!, client_secret: secrets.kick.clientSecret!,
      redirect_uri: p.redirect, code_verifier: p.verifier, code,
    }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new UserError(`Kick refused the sign-in: ${j.error_description || j.error || r.status}`);
  storeTokens(j);
  const me = (await kickApi('GET', '/users'))?.data?.[0];
  secrets.kick.userId = me?.user_id;
  secrets.kick.username = me?.name;
  saveSecrets();
  log.info(`signed in as ${me?.name}`);
}

function storeTokens(j: any) {
  secrets.kick.accessToken = j.access_token;
  if (j.refresh_token) secrets.kick.refreshToken = j.refresh_token;
  secrets.kick.expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
  secrets.kick.scopes = String(j.scope || '').split(' ').filter(Boolean);
  saveSecrets();
}

export function kickLogout() {
  const { clientId, clientSecret, accessToken } = secrets.kick;
  if (accessToken) {
    fetch(`https://id.kick.com/oauth/revoke?${new URLSearchParams({ token: accessToken, token_hint_type: 'access_token' })}`, { method: 'POST' }).catch(() => {});
  }
  secrets.kick = { clientId, clientSecret };
  saveSecrets();
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const { clientId, clientSecret, refreshToken } = secrets.kick;
    if (!clientId || !clientSecret || !refreshToken) return false;
    const r = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
    }).catch(() => null);
    if (!r) return false;
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      log.warn(`token refresh failed (${j.error || r.status}); sign in again`);
      if (r.status === 400 || r.status === 401) { secrets.kick = { clientId, clientSecret }; saveSecrets(); }
      return false;
    }
    storeTokens(j);
    return true;
  })().finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

const signedIn = () => !!(secrets.kick.accessToken && secrets.kick.userId);

async function kickApi(method: string, path: string, body?: unknown, retry = true): Promise<any> {
  if (!secrets.kick.accessToken) throw new UserError('Sign in to Kick first.');
  if ((secrets.kick.expiresAt || 0) - Date.now() < 120_000) await refresh();
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${secrets.kick.accessToken}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && retry && (await refresh())) return kickApi(method, path, body, false);
  if (r.status === 204) return null;
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Kick puts the useful reason in "data" ("webhook not enabled for app") and a generic one in "message".
    const reason = typeof j.data === 'string' && j.data ? j.data : j.message || r.statusText;
    throw new KickApiError(r.status, reason);
  }
  return j;
}

export class KickApiError extends UserError {
  status: number;
  reason: string;
  constructor(status: number, reason: string) {
    super(friendlyKickError(status, reason));
    this.status = status;
    this.reason = reason;
  }
}

export const WEBHOOKS_OFF_HELP = 'Webhooks are turned off in your Kick app. On kick.com go to Settings → Developer → your app, turn on Webhooks, paste the Webhook URL from StreamChat and save.';

function friendlyKickError(status: number, reason: string) {
  if (/webhook not enabled/i.test(reason)) return WEBHOOKS_OFF_HELP;
  if (status === 403 || /scope/i.test(reason)) return `Kick says your sign-in is missing a permission (${reason}). Check the scopes in your Kick app, then sign out and in again.`;
  if (status === 429) return 'Kick is rate-limiting requests. Wait a minute.';
  return `Kick: ${reason}`;
}

// ---------------- Webhook signature ----------------

let publicKey: crypto.KeyObject | null = null;
export function setKickPublicKeyForTest(k: crypto.KeyObject) { publicKey = k; }
async function kickPublicKey(force = false) {
  if (publicKey && !force) return publicKey;
  const r = await fetch(`${API}/public-key`);
  const j: any = await r.json();
  publicKey = crypto.createPublicKey(j.data.public_key);
  return publicKey;
}

async function verify(headers: Record<string, string | string[] | undefined>, body: Buffer) {
  const id = String(headers['kick-event-message-id'] || '');
  const ts = String(headers['kick-event-message-timestamp'] || '');
  const sig = String(headers['kick-event-signature'] || '');
  if (!id || !ts || !sig) return false;
  const data = Buffer.concat([Buffer.from(`${id}.${ts}.`), body]);
  const check = (k: crypto.KeyObject) => crypto.verify('sha256', data, k, Buffer.from(sig, 'base64'));
  if (check(await kickPublicKey())) return true;
  return check(await kickPublicKey(true)); // Kick may have rotated its key
}

// ---------------- Connector ----------------

const BADGE_TITLES: Record<string, string> = {
  broadcaster: 'Broadcaster', moderator: 'Moderator', vip: 'VIP', og: 'OG', founder: 'Founder', verified: 'Verified',
  staff: 'Kick Staff', subscriber: 'Subscriber', sub_gifter: 'Sub Gifter', sidekick: 'Sidekick', trainwreckstv: 'Trainwreck',
};

export class KickConnector implements Connector {
  platform = 'kick' as const;
  private stopped = true;
  private broadcasterId: number | null = null;
  private slug = '';
  private seen = new Set<string>();
  private subBadges: { months: number; url: string }[] = [];
  private lastWebhook = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastError = '';
  /** Where setup stands, for the checklist in Settings. */
  setup = { subscribed: false, error: '' as string };

  get lastEventAt() { return this.lastWebhook; }

  emoteChannelId() { return this.broadcasterId ? String(this.broadcasterId) : undefined; }

  async start() {
    this.stopped = false;
    if (!settings.kick.enabled) { hub.setStatus('kick', { state: 'off', detail: 'Turned off' }); return; }
    if (!secrets.kick.clientId || !secrets.kick.clientSecret) {
      hub.setStatus('kick', { state: 'off', detail: 'Add your Kick app keys in Settings' });
      return;
    }
    if (!signedIn()) { hub.setStatus('kick', { state: 'off', detail: 'Sign in to Kick in Settings' }); return; }
    if (hub.status.kick.state !== 'error') hub.setStatus('kick', { state: 'connecting', detail: 'Setting up Kick events…' });
    try {
      this.slug = (settings.kick.channel || secrets.kick.username || '').toLowerCase().trim();
      const ch = (await kickApi('GET', '/channels'))?.data?.[0]; // no params = your own channel
      this.broadcasterId = ch?.broadcaster_user_id ?? secrets.kick.userId!;
      this.slug = ch?.slug || this.slug;
      hub.selfNames.kick = [secrets.kick.username?.toLowerCase(), this.slug].filter(Boolean) as string[];
      if (settings.kick.channel && settings.kick.channel.toLowerCase() !== this.slug) {
        log.warn(`Kick only sends events for the signed-in account's channel (${this.slug}), not ${settings.kick.channel}`);
      }
      emotes.loadChannel('kick', String(this.broadcasterId)).catch(() => {});
      this.loadSubBadges().catch(() => {});
      this.applyStream(ch);
      await this.subscribe();
      this.setup = { subscribed: true, error: '' };
      if (this.lastError) log.info('Kick events are set up');
      this.lastError = '';
      this.updateStatus(ch?.stream?.is_live);
      this.pollTimer = setInterval(() => this.pollStream(), 60_000);
    } catch (e: any) {
      const webhooksOff = e instanceof KickApiError && /webhook not enabled/i.test(e.reason);
      this.setup = { subscribed: false, error: webhooksOff ? 'webhooks-off' : e.message };
      // Log each distinct problem once; keep retrying quietly so it connects as soon as it's fixed.
      if (e.message !== this.lastError) log.warn('setup failed:', e.message);
      this.lastError = e.message;
      hub.setStatus('kick', { state: 'error', detail: e.message, channel: this.slug || undefined, loggedInAs: secrets.kick.username, setup: webhooksOff ? 'kick-webhooks' : undefined });
      if (!this.stopped) this.retryTimer = setTimeout(() => { if (!this.stopped) this.start(); }, webhooksOff ? 20_000 : 60_000);
      return;
    }
    this.refreshTimer = setInterval(() => {
      if ((secrets.kick.expiresAt || 0) - Date.now() < 15 * 60_000) refresh();
    }, 5 * 60_000);
  }

  private applyStream(ch: any) {
    const st = ch?.stream;
    if (!st) return;
    const startedAt = st.is_live && st.start_time && !st.start_time.startsWith('0001') ? Date.parse(st.start_time) : undefined;
    const patch = { live: !!st.is_live, viewers: st.is_live ? Number(st.viewer_count) || 0 : undefined, startedAt };
    const cur = hub.status.kick;
    if (cur.live !== patch.live || cur.viewers !== patch.viewers || cur.startedAt !== patch.startedAt) hub.patchStatus('kick', patch);
  }

  private async pollStream() {
    if (this.stopped) return;
    const ch = (await kickApi('GET', '/channels').catch(() => null))?.data?.[0];
    if (ch && !this.stopped) this.applyStream(ch);
  }

  /** Kick user id for a channel name (slug), for /ban etc. */
  async userIdFor(login: string): Promise<string> {
    login = login.replace(/^@/, '').toLowerCase();
    const seen = hub.findUserByLogin('kick', login);
    if (seen && /^\d+$/.test(seen.id)) return seen.id;
    const ch = (await kickApi('GET', `/channels?slug=${encodeURIComponent(login)}`))?.data?.[0];
    if (!ch?.broadcaster_user_id) throw new UserError(`No Kick user called ${login}.`);
    return String(ch.broadcaster_user_id);
  }

  private updateStatus(live?: boolean) {
    const ago = this.lastWebhook ? Math.round((Date.now() - this.lastWebhook) / 1000) : -1;
    hub.setStatus('kick', {
      state: 'connected', channel: this.slug, loggedInAs: secrets.kick.username, canSend: true, canModerate: true,
      live: live ?? hub.status.kick.live,
      viewers: hub.status.kick.viewers, startedAt: hub.status.kick.startedAt,
      detail: ago < 0 ? 'Connected. Send a message in your Kick chat to check messages arrive.' : undefined,
    });
  }

  private async subscribe() {
    const existing = (await kickApi('GET', '/events/subscriptions'))?.data || [];
    const have = new Set(existing.map((s: any) => s.event));
    const missing = EVENTS.filter(e => !have.has(e));
    if (missing.length) {
      const r = await kickApi('POST', '/events/subscriptions', { events: missing.map(name => ({ name, version: 1 })), method: 'webhook' });
      for (const s of r?.data || []) if (s.error) log.warn(`can't receive ${s.name}: ${s.error}`);
    }
    log.info(`subscribed to ${EVENTS.length - missing.length} existing + ${missing.length} new Kick event types`);
  }

  private async loadSubBadges() {
    // Subscriber badge images aren't in the public API; kick.com's own channel endpoint has them.
    const r = await fetch(`https://kick.com/api/v2/channels/${this.slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return;
    const j: any = await r.json();
    this.subBadges = (j.subscriber_badges || []).map((b: any) => ({ months: b.months, url: b.badge_image?.src })).filter((b: any) => b.url).sort((a: any, b: any) => b.months - a.months);
  }

  async stop() {
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.refreshTimer = this.retryTimer = this.pollTimer = null;
    if (this.broadcasterId) emotes.dropChannel('kick', String(this.broadcasterId));
    hub.setStatus('kick', { state: 'off' });
  }

  async restart() { await this.stop(); await this.start(); }

  // Called by the HTTP server for POST /webhooks/kick. Returns the HTTP status to answer with.
  async webhook(headers: Record<string, string | string[] | undefined>, body: Buffer): Promise<number> {
    if (!(await verify(headers, body).catch(e => { log.warn('signature check failed:', e); return false; }))) return 401;
    const msgId = String(headers['kick-event-message-id']);
    if (this.seen.has(msgId)) return 200;
    this.seen.add(msgId);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2000));
    const type = String(headers['kick-event-type'] || '');
    let e: any;
    try { e = JSON.parse(body.toString('utf8')); } catch { return 400; }
    const first = !this.lastWebhook;
    this.lastWebhook = Date.now();
    if (first && !this.stopped) this.updateStatus();
    if (this.stopped) return 200;
    try { this.onEvent(type, e, msgId); } catch (err) { log.error(`bad ${type} payload:`, err); }
    return 200;
  }

  private user(u: any): ChatUser {
    const login = String(u?.channel_slug || u?.username || 'anonymous').toLowerCase();
    const badges: Badge[] = [];
    for (const b of u?.identity?.badges || []) {
      let url: string | undefined;
      if (b.type === 'subscriber' && this.subBadges.length) url = this.subBadges.find(s => (b.count || 1) >= s.months)?.url || this.subBadges.at(-1)?.url;
      const title = b.type === 'subscriber' && b.count ? `Subscriber (${b.count} months)` : b.text || BADGE_TITLES[b.type] || b.type;
      badges.push({ id: `kick:${b.type}`, title, url });
    }
    return {
      id: String(u?.user_id ?? login), login, name: u?.username || 'Anonymous',
      color: u?.identity?.username_color || defaultColor(login),
      avatar: u?.profile_picture || undefined,
      badges,
      mod: badges.some(b => b.id === 'kick:moderator'),
      broadcaster: badges.some(b => b.id === 'kick:broadcaster') || String(u?.user_id) === String(this.broadcasterId),
    };
  }

  parseContent(content: string) {
    // "[emote:37226:KEKW]" -> emote; everything else goes through the normal word parser.
    const native: NativeEmote[] = [];
    let text = '';
    let pos = 0; // in code points
    const re = /\[emote:(\d+):([^\]]*)\]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const before = content.slice(last, m.index);
      text += before;
      pos += Array.from(before).length;
      const name = m[2] || 'emote';
      native.push({ start: pos, end: pos + Array.from(name).length - 1, name, url: `https://files.kick.com/emotes/${m[1]}/fullsize`, src: 'kick' });
      text += name;
      pos += Array.from(name).length;
      last = re.lastIndex;
    }
    text += content.slice(last);
    return { text, parts: toParts('kick', this.emoteChannelId(), text, native) };
  }

  private onEvent(type: string, e: any, msgId: string) {
    const ts = Date.parse(e.created_at) || Date.now();
    switch (type) {
      case 'chat.message.sent': {
        const { text, parts } = this.parseContent(e.content || '');
        const user = this.user(e.sender);
        hub.push({
          kind: 'chat', id: e.message_id || msgId, platform: 'kick', ts, user, text, parts, flags: {},
          reply: e.replies_to ? { user: e.replies_to.sender?.username || '', text: this.parseContent(e.replies_to.content || '').text } : undefined,
        });
        break;
      }
      case 'channel.followed': {
        const user = this.user(e.follower);
        hub.push({ kind: 'event', id: msgId, platform: 'kick', ts, type: 'follow', user, title: `${user.name} followed`, alert: true });
        break;
      }
      case 'channel.subscription.new':
      case 'channel.subscription.renewal': {
        const user = this.user(e.subscriber);
        const months = Number(e.duration || 1);
        const renew = type.endsWith('renewal');
        hub.push({ kind: 'event', id: msgId, platform: 'kick', ts, type: renew ? 'resub' : 'sub', user, amount: months, alert: true,
          title: renew ? `${user.name} resubscribed for ${months} months` : `${user.name} subscribed` });
        break;
      }
      case 'channel.subscription.gifts': {
        const anon = e.gifter?.is_anonymous;
        const user = anon ? undefined : this.user(e.gifter);
        const n = (e.giftees || []).length || 1;
        hub.push({ kind: 'event', id: msgId, platform: 'kick', ts, type: 'giftsub', user, amount: n, alert: true,
          title: `${anon ? 'Anonymous' : user!.name} gifted ${n} sub${n === 1 ? '' : 's'}` });
        break;
      }
      case 'kicks.gifted': {
        const user = this.user(e.sender);
        const g = e.gift || {};
        hub.push({ kind: 'event', id: msgId, platform: 'kick', ts, type: 'kicks', user, amount: g.amount, alert: true,
          title: `${user.name} sent ${g.amount} Kicks${g.name ? ` (${g.name})` : ''}`,
          parts: g.message ? this.parseContent(g.message).parts : undefined });
        break;
      }
      case 'moderation.banned': {
        const banned = this.user(e.banned_user);
        hub.clearUser('kick', banned.id);
        const exp = e.metadata?.expires_at ? Date.parse(e.metadata.expires_at) : 0;
        const secs = exp ? Math.max(1, Math.round((exp - (Date.parse(e.metadata.created_at) || Date.now())) / 1000)) : 0;
        hub.push({ kind: 'event', id: msgId, platform: 'kick', ts, type: secs ? 'timeout' : 'ban',
          title: secs ? `${banned.name} was timed out for ${fmtDuration(secs)}` : `${banned.name} was banned` });
        break;
      }
      case 'livestream.status.updated':
        hub.patchStatus('kick', { live: !!e.is_live });
        hub.push({ kind: 'event', id: msgId, platform: 'kick', ts, type: 'live', title: e.is_live ? `Kick stream started: ${e.title || ''}` : 'Kick stream ended' });
        break;
      case 'channel.reward.redemption.updated': {
        if (e.status !== 'pending' && e.status !== 'accepted') break;
        const user = this.user(e.redeemer);
        hub.push({ kind: 'event', id: msgId, platform: 'kick', ts, type: 'redeem', user, amount: e.reward?.cost,
          title: `${user.name} redeemed ${e.reward?.title}`, parts: e.user_input ? toParts('kick', this.emoteChannelId(), e.user_input) : undefined });
        break;
      }
    }
  }

  async send(text: string, replyTo?: string) {
    if (!signedIn() || !this.broadcasterId) throw new UserError('Sign in to Kick to send messages.');
    text = text.replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
    if (!text) return;
    const r = await kickApi('POST', '/chat', { content: text, type: 'user', broadcaster_user_id: this.broadcasterId, ...(replyTo ? { reply_to_message_id: replyTo } : {}) });
    if (r?.data && r.data.is_sent === false) throw new UserError('Kick did not send the message.');
    // The message also comes back as a webhook with the same id; the hub drops the duplicate.
    const id = r?.data?.message_id || localId('kick-self');
    const { parts } = this.parseContent(text);
    const self = hub.findUserByLogin('kick', secrets.kick.username?.toLowerCase() || '') || {
      id: String(secrets.kick.userId), login: (secrets.kick.username || '').toLowerCase(), name: secrets.kick.username || 'you', badges: [], color: defaultColor(secrets.kick.username || ''),
    };
    const parent = replyTo ? hub.get('kick', replyTo) : undefined;
    hub.push({ kind: 'chat', id, platform: 'kick', ts: Date.now(), user: self, text, parts, flags: { self: true },
      reply: parent && parent.kind === 'chat' ? { user: parent.user.name, text: parent.text } : undefined });
  }

  async moderate(a: ModAction) {
    if (!this.broadcasterId) throw new UserError('Kick is not connected.');
    if (a.type === 'delete') {
      await kickApi('DELETE', `/chat/${encodeURIComponent(a.messageId)}`);
      hub.markDeleted('kick', a.messageId);
    } else if (a.type === 'timeout') {
      await kickApi('POST', '/moderation/bans', { broadcaster_user_id: this.broadcasterId, user_id: Number(a.userId), duration: Math.max(1, Math.min(10080, Math.round(a.seconds / 60))), reason: a.reason?.slice(0, 100) });
    } else if (a.type === 'ban') {
      await kickApi('POST', '/moderation/bans', { broadcaster_user_id: this.broadcasterId, user_id: Number(a.userId), reason: a.reason?.slice(0, 100) });
    } else if (a.type === 'unban') {
      await kickApi('DELETE', '/moderation/bans', { broadcaster_user_id: this.broadcasterId, user_id: Number(a.userId) });
    }
  }

  async command(c: ParsedCommand): Promise<string> {
    if (!signedIn() || !this.broadcasterId) throw new UserError('Sign in to Kick to use commands.');
    switch (c.name) {
      case 'ban': { const u = needUser(c); await this.moderate({ type: 'ban', userId: await this.userIdFor(u), login: u, reason: c.args.slice(1).join(' ') }); return `Banned ${u}`; }
      case 'unban': { const u = needUser(c); await this.moderate({ type: 'unban', userId: await this.userIdFor(u), login: u }); return `Unbanned ${u}`; }
      case 'timeout': {
        const u = needUser(c);
        const d = parseDuration(c.args[1]);
        const secs = Math.max(60, Math.min(604800, d ?? 600)); // Kick counts in whole minutes
        await this.moderate({ type: 'timeout', userId: await this.userIdFor(u), login: u, seconds: secs, reason: c.args.slice(d != null ? 2 : 1).join(' ') });
        return `Timed out ${u} for ${fmtDuration(secs)}`;
      }
      case 'me': if (!c.rest) throw new UserError('Usage: /me <text>'); await this.send(c.rest); return '';
    }
    throw new Unsupported();
  }

  async userCard(userId: string, login: string): Promise<UserCard> {
    const card: UserCard = { platform: 'kick', id: userId, login, name: login, profileUrl: `https://kick.com/${login}` };
    const u = (await kickApi('GET', `/users?id=${encodeURIComponent(userId)}`).catch(() => null))?.data?.[0];
    if (u) { card.name = u.name; card.avatar = u.profile_picture; }
    const last = hub.userHistory('kick', userId).at(-1);
    if (last?.user.avatar && !card.avatar) card.avatar = last.user.avatar;
    return card;
  }
}
