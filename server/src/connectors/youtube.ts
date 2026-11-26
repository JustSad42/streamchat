// YouTube live chat through the same public web endpoints the youtube.com chat popout uses.
// No API key or sign-in (the official Data API quota only covers a few hours of polling a day), so it is read-only.

import type { Badge, ChatUser, Item, ModAction, Part } from '../types.ts';
import { hub, localId } from '../hub.ts';
import { toParts } from '../emotes.ts';
import { settings } from '../config.ts';
import { logger } from '../log.ts';
import { backoff, UserError, type Connector, type UserCard } from './base.ts';
import { defaultColor } from './twitch.ts';

const log = logger('youtube');
const OFFLINE_POLL_MS = 60_000;
const META_MS = 30_000;
const RECHECK_MS = 120_000;   // in a waiting room: look again for a stream that went live instead
const FRESH_MS = 120_000;     // older events come from chat history, so they don't raise alerts
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'SOCS=CAI', // skips the EU cookie consent page
};

/** "@name", "name", a channel id or a channel link → the path on youtube.com ('' if unusable). */
export function channelPath(input: string): string {
  const s = input.trim().replace(/^(https?:\/\/)?((www|m)\.)?youtube\.com\//i, '').replace(/^\/+/, '').split(/[?#]/)[0];
  const [a = '', b = ''] = s.split('/');
  const id = a === 'channel' ? b : a;
  if (/^UC[\w-]{22}$/.test(id)) return `channel/${id}`;
  if ((a === 'c' || a === 'user') && b) return `${a}/${encodeURIComponent(b)}`;
  const handle = a.replace(/^@/, '');
  if (!handle || /\s|:/.test(handle) || ['watch', 'live', 'channel', 'c', 'user'].includes(handle)) return '';
  return `@${encodeURIComponent(handle)}`;
}

export function initialData(html: string): any {
  const m = html.match(/(?:var ytInitialData|window\["ytInitialData"\])\s*=\s*(\{.*?\});\s*<\/script>/s);
  if (!m) throw new Error('YouTube sent a page StreamChat does not understand');
  return JSON.parse(m[1]);
}

const url = (u?: string) => (u?.startsWith('//') ? `https:${u}` : u);
const thumb = (t: any) => url(t?.thumbnails?.at(-1)?.url);
const plain = (t: any): string => t?.simpleText ?? (t?.runs || []).map((r: any) => r.text ?? r.emoji?.emojiId ?? '').join('');

export function messageParts(message: any): { text: string; parts: Part[] } {
  const parts: Part[] = [];
  let text = '', pending = '';
  const flush = () => { if (pending) parts.push(...toParts('youtube', undefined, pending)); pending = ''; };
  for (const r of message?.runs || []) {
    const e = r.emoji;
    if (e?.isCustomEmoji) {
      const name = e.shortcuts?.[0] || 'emoji';
      const src = thumb(e.image);
      text += name;
      if (!src) { pending += name; continue; }
      flush();
      parts.push({ t: 'emote', name, url: src, src: 'youtube' });
    } else {
      const v: string = r.text ?? e?.emojiId ?? ''; // standard emoji ids are the character itself
      text += v;
      pending += v;
    }
  }
  flush();
  return { text, parts };
}

function user(r: any, channelId: string): ChatUser {
  const name: string = plain(r.authorName) || 'unknown';
  const badges: Badge[] = [];
  let mod = false, broadcaster = false;
  for (const x of r.authorBadges || []) {
    const b = x.liveChatAuthorBadgeRenderer;
    if (!b) continue;
    const icon = b.icon?.iconType;
    if (icon === 'OWNER') { broadcaster = true; badges.push({ id: 'youtube:broadcaster', title: 'Owner' }); }
    else if (icon === 'MODERATOR') { mod = true; badges.push({ id: 'youtube:moderator', title: 'Moderator' }); }
    else if (icon === 'VERIFIED') badges.push({ id: 'youtube:verified', title: 'Verified' });
    else if (b.customThumbnail) badges.push({ id: 'youtube:subscriber', title: b.tooltip || 'Member', url: thumb(b.customThumbnail) });
  }
  const login = name.replace(/^@/, '').toLowerCase();
  return { id: channelId || login, login, name: name.replace(/^@/, ''), color: defaultColor(login), avatar: thumb(r.authorPhoto), badges, mod, broadcaster };
}

/** One chat renderer → a message or event (undefined for notices we don't show). */
export function toItem(item: any): Item | undefined {
  const [kind, r] = Object.entries<any>(item || {})[0] || [];
  if (!r) return undefined;
  const ts = Math.floor(Number(r.timestampUsec) / 1000) || Date.now();
  const base = { id: String(r.id || localId('yt')), platform: 'youtube' as const, ts };
  const alert = Date.now() - ts < FRESH_MS;

  if (kind === 'liveChatTextMessageRenderer') {
    return { kind: 'chat', ...base, user: user(r, r.authorExternalChannelId), ...messageParts(r.message), flags: {} };
  }
  if (kind === 'liveChatPaidMessageRenderer' || kind === 'liveChatPaidStickerRenderer') {
    const u = user(r, r.authorExternalChannelId);
    const what = kind === 'liveChatPaidStickerRenderer' ? 'Super Sticker' : 'Super Chat';
    const { parts } = messageParts(r.message);
    return { kind: 'event', ...base, type: 'gift', user: u, alert, parts: parts.length ? parts : undefined, image: thumb(r.sticker),
      title: `${u.name} sent a ${plain(r.purchaseAmountText)} ${what}` };
  }
  if (kind === 'liveChatMembershipItemRenderer') {
    const u = user(r, r.authorExternalChannelId);
    const milestone = plain(r.headerPrimaryText);
    const { parts } = messageParts(r.message);
    return { kind: 'event', ...base, type: milestone ? 'resub' : 'sub', user: u, alert, parts: parts.length ? parts : undefined,
      amount: Number(milestone.match(/\d+/)?.[0]) || 1,
      title: milestone ? `${u.name}: ${milestone}` : `${u.name} became a member` };
  }
  if (kind === 'liveChatSponsorshipsGiftPurchaseAnnouncementRenderer') {
    const h = r.header?.liveChatSponsorshipsHeaderRenderer;
    if (!h) return undefined;
    const u = user(h, r.authorExternalChannelId);
    const count = Number(plain(h.primaryText).match(/\d+/)?.[0]) || 1;
    return { kind: 'event', ...base, type: 'giftsub', user: u, alert, amount: count,
      title: `${u.name} gifted ${count} membership${count > 1 ? 's' : ''}` };
  }
  return undefined;
}

/** Live state from an updated_metadata answer; undefined if it says nothing about viewers. */
export function viewership(meta: any): { live: boolean; viewers?: number } | undefined {
  const v = meta?.actions?.find((a: any) => a.updateViewershipAction)?.updateViewershipAction.viewCount?.videoViewCountRenderer;
  if (!v) return undefined;
  const live = !!v.isLive && !/waiting/i.test(plain(v.viewCount)); // an upcoming stream counts people "waiting"
  return { live, viewers: live ? Number(v.originalViewCount) || undefined : undefined };
}

export function handleAction(a: any) {
  const add = a.addChatItemAction?.item || a.replaceChatItemAction?.replacementItem;
  if (add) { const it = toItem(add); if (it) hub.push(it); return; }
  const one = a.removeChatItemAction || a.markChatItemAsDeletedAction;
  if (one) hub.markDeleted('youtube', one.targetItemId);
  const all = a.removeChatItemByAuthorAction || a.markChatItemsByAuthorAsDeletedAction;
  if (all) hub.clearUser('youtube', all.externalChannelId);
}

async function request(path: string, body?: unknown) {
  const res = await fetch(`https://www.youtube.com/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { ...HEADERS, 'Content-Type': 'application/json' } : HEADERS,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw Object.assign(new Error(`YouTube answered ${res.status}`), { status: res.status });
  return res.text();
}

export class YouTubeConnector implements Connector {
  platform = 'youtube' as const;
  private run = 0; // bumped on stop, so an older loop notices it was replaced
  private timer: NodeJS.Timeout | null = null;
  private channel = '';
  private path = '';
  private attempt = 0;
  private live = false;
  private waitingLogged = false;

  emoteChannelId() { return undefined; }

  async start() {
    const input = (settings.youtube.channel || '').trim();
    this.path = channelPath(input);
    this.channel = this.path.startsWith('@') ? decodeURIComponent(this.path.slice(1)) : input;
    if (!settings.youtube.enabled || !this.path) {
      hub.setStatus('youtube', { state: 'off', detail: !input ? 'No channel set' : !this.path ? 'Enter your @handle or channel link' : 'Turned off' });
      return;
    }
    hub.selfNames.youtube = this.path.startsWith('@') ? [this.channel.toLowerCase()] : [];
    this.live = false;
    this.attempt = 0;
    this.connect(++this.run);
  }

  async stop() {
    this.run++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    hub.setStatus('youtube', { state: 'off' });
  }

  async restart() { await this.stop(); await this.start(); }

  private sleep(ms: number) { return new Promise<void>(r => { this.timer = setTimeout(r, ms); }); }

  /** Follow the channel until stopped: find its stream, read the chat, wait, repeat. */
  private async connect(run: number) {
    while (run === this.run) {
      let pause = OFFLINE_POLL_MS;
      try {
        const detail = await this.read(run);
        this.attempt = 0;
        if (run !== this.run) return;
        if (detail === 'recheck') { pause = 0; } else {
          if (!this.waitingLogged) log.info(`${this.channel} is not live; waiting`);
          this.waitingLogged = true;
          this.live = false;
          hub.setStatus('youtube', { state: 'waiting', channel: this.channel, live: false, detail, canSend: false, canModerate: false });
        }
      } catch (e: any) {
        if (run !== this.run) return;
        pause = Math.max(10_000, backoff(this.attempt++));
        const why = e.status === 404 ? `Couldn't find the YouTube channel "${this.channel}". Check the handle.` : String(e.message || e).slice(0, 200);
        log.warn('connect failed:', why);
        hub.setStatus('youtube', { state: 'error', channel: this.channel, detail: `${why} Retrying in ${Math.round(pause / 1000)}s.` });
      }
      await this.sleep(pause);
    }
  }

  // Returns why it stopped reading: a status line to show while waiting, or 'recheck'.
  private async read(run: number): Promise<string> {
    const idle = 'Not live right now. Connects by itself within about a minute of you going LIVE.';
    const page = await request(`${this.path}/live`);
    const videoId: string | undefined = initialData(page)?.currentVideoEndpoint?.watchEndpoint?.videoId;
    if (!videoId) return idle;
    const html = await request(`live_chat?is_popout=1&v=${encodeURIComponent(videoId)}`);
    const chat = initialData(html)?.contents?.liveChatRenderer;
    if (!chat) return 'The current stream has no live chat. Checking again in a minute.';
    // The second menu entry is "Live chat" (every message); the default "Top chat" filters some out.
    const menu = chat.header?.liveChatHeaderRenderer?.viewSelector?.sortFilterSubMenuRenderer?.subMenuItems;
    let next: any = menu?.[1]?.continuation?.reloadContinuationData || Object.values(chat.continuations?.[0] || {})[0];
    const clientVersion = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1] || '2.20260101.00.00';
    const context = { client: { clientName: 'WEB', clientVersion, hl: 'en' } };
    // Only present when YouTube serves the full player to this address (usually not to data centres).
    const started = Date.parse(page.match(/"startTimestamp":"([^"]+)"/)?.[1] || '') || undefined;
    const since = Date.now();
    let metaAt = 0, viewers: number | undefined, connected = false;

    while (next?.continuation) {
      if (Date.now() - metaAt >= META_MS) {
        metaAt = Date.now();
        const now = await request('youtubei/v1/updated_metadata?prettyPrint=false', { context, videoId }).then(t => viewership(JSON.parse(t))).catch(() => undefined);
        if (run !== this.run) return 'recheck';
        if (now) {
          if (this.live && !now.live) break;
          this.live = now.live;
          viewers = now.viewers;
        }
        if (connected) this.status(viewers, started);
      }
      const res = JSON.parse(await request('youtubei/v1/live_chat/get_live_chat?prettyPrint=false', { context, continuation: next.continuation }));
      if (run !== this.run) return 'recheck';
      const c = res?.continuationContents?.liveChatContinuation;
      if (!c) break;
      if (!connected) { connected = true; this.waitingLogged = false; log.info(`reading chat of ${this.channel} (video ${videoId})`); this.status(viewers, started); }
      this.attempt = 0;
      for (const a of c.actions || []) handleAction(a);
      if (!this.live && Date.now() - since > RECHECK_MS) return 'recheck';
      next = Object.values(c.continuations?.[0] || {})[0];
      await this.sleep(Math.min(4000, Math.max(1000, Number(next?.timeoutMs) || 3000)));
      if (run !== this.run) return 'recheck';
    }
    if (this.live) {
      log.info('stream ended');
      hub.push({ kind: 'event', id: localId('ytend'), platform: 'youtube', ts: Date.now(), type: 'live', title: 'YouTube stream ended' });
    }
    return idle;
  }

  private status(viewers: number | undefined, startedAt: number | undefined) {
    hub.setStatus('youtube', {
      state: 'connected', channel: this.channel, live: this.live, viewers, startedAt: this.live ? startedAt : undefined, canSend: false, canModerate: false,
      detail: !this.live ? 'In the waiting room of your upcoming stream.' : viewers != null ? `${viewers.toLocaleString('en-US')} watching` : 'Live',
    });
  }

  async send(): Promise<void> {
    throw new UserError("StreamChat can only read YouTube chat. Send from YouTube.");
  }

  async moderate(_a: ModAction): Promise<void> {
    throw new UserError('StreamChat can only read YouTube chat. Moderate in YouTube Studio.');
  }

  async userCard(userId: string, login: string): Promise<UserCard> {
    const last = hub.userHistory('youtube', userId).at(-1);
    const profileUrl = /^UC[\w-]{22}$/.test(userId) ? `https://www.youtube.com/channel/${userId}` : `https://www.youtube.com/@${encodeURIComponent(login)}`;
    return { platform: 'youtube', id: userId, login, name: last?.user.name || login, avatar: last?.user.avatar, profileUrl };
  }
}
