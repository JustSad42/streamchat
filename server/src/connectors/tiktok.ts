// TikTok LIVE through the unofficial tiktok-live-connector library (signing via Euler Stream).
// Read-only: TikTok has no way for third-party apps to send chat or moderate.

import { TikTokLiveConnection, WebcastEvent, ControlEvent, SignConfig } from 'tiktok-live-connector';
import type { Badge, ChatUser, ModAction, Part } from '../types.ts';
import { hub, localId } from '../hub.ts';
import { toParts } from '../emotes.ts';
import { secrets, settings } from '../config.ts';
import { logger } from '../log.ts';
import { backoff, UserError, type Connector, type UserCard } from './base.ts';
import { defaultColor } from './twitch.ts';

const log = logger('tiktok');
// While you're offline StreamChat only runs TikTok's cheap "is live?" check (a plain page fetch,
// no signing, so it doesn't use your Euler Stream quota), then connects properly once you go LIVE.
const OFFLINE_POLL_MS = 20_000;

const img = (m: any): string | undefined => m?.urlList?.[0] || m?.url_list?.[0] || undefined;

export class TikTokConnector implements Connector {
  platform = 'tiktok' as const;
  private conn: any = null;
  private stopped = true;
  private username = '';
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private likeBuckets = new Map<string, { n: number; at: number }>();
  private viewers = 0;
  private wasOffline = false;
  private startedAt = 0;

  emoteChannelId() { return undefined; }

  async start() {
    this.stopped = false;
    this.username = (settings.tiktok.username || '').replace(/^@/, '').trim().toLowerCase();
    if (!settings.tiktok.enabled || !this.username) {
      hub.setStatus('tiktok', { state: 'off', detail: this.username ? 'Turned off' : 'No username set' });
      return;
    }
    hub.selfNames.tiktok = [this.username];
    if (secrets.tiktok.eulerKey) SignConfig.apiKey = secrets.tiktok.eulerKey;
    this.connect();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const c = this.conn;
    this.conn = null;
    if (c) await c.disconnect().catch(() => {});
    hub.setStatus('tiktok', { state: 'off' });
  }

  async restart() { await this.stop(); await this.start(); }

  private retry(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), ms);
  }

  private offline(detail = 'Not live right now. Connects by itself within about 20 seconds of you going LIVE.') {
    if (!this.wasOffline) log.info(`@${this.username} is not live; waiting`);
    this.wasOffline = true;
    this.startedAt = 0;
    hub.setStatus('tiktok', { state: 'waiting', channel: this.username, live: false, detail, canSend: false, canModerate: false });
    this.retry(OFFLINE_POLL_MS);
  }

  private async connect() {
    if (this.stopped) return;
    if (this.conn) { const old = this.conn; this.conn = null; old.removeAllListeners?.(); old.disconnect().catch(() => {}); }
    const conn = new TikTokLiveConnection(this.username, {
      signApiKey: secrets.tiktok.eulerKey || undefined,
      processInitialData: false,
      enableExtendedGiftInfo: false,
    });
    this.conn = conn;
    // Cheap check first; if it fails for some reason, fall through to a full connect.
    const live = await conn.fetchIsLive().catch(() => null);
    if (this.conn !== conn || this.stopped) return;
    if (live === false) { this.conn = null; this.offline(); return; }
    if (hub.status.tiktok.state !== 'connected') hub.setStatus('tiktok', { state: 'connecting', channel: this.username, canSend: false, canModerate: false, detail: 'You are LIVE. Connecting…' });
    this.wire(conn);
    try {
      const state = await conn.connect();
      if (this.conn !== conn) return;
      this.attempt = 0;
      this.wasOffline = false;
      const created = Number((state?.roomInfo as any)?.create_time || (state?.roomInfo as any)?.data?.create_time || 0);
      this.startedAt = created ? created * 1000 : Date.now();
      log.info(`connected to @${this.username} (room ${state.roomId})`);
      hub.setStatus('tiktok', { state: 'connected', channel: this.username, live: true, canSend: false, canModerate: false, startedAt: this.startedAt, viewers: this.viewers || undefined });
    } catch (e: any) {
      if (this.conn !== conn) return;
      const name = e?.constructor?.name || '';
      const msg = String(e?.message || e);
      if (name === 'UserOfflineError' || /offline|not live|isn't online|LIVE has ended/i.test(msg)) {
        this.offline();
      } else {
        const delay = Math.max(15_000, backoff(this.attempt++));
        let detail = msg.slice(0, 200);
        if (/rate ?limit|429/i.test(msg) || name === 'SignatureRateLimitError') detail = 'Euler Stream rate limit reached. Add a free API key in Settings → TikTok, or wait.';
        else if (name === 'InvalidUniqueIdError' || /not found|doesn't exist|does not exist/i.test(msg)) detail = `Couldn't find the TikTok account @${this.username}. Check the username.`;
        log.warn('connect failed:', msg);
        hub.setStatus('tiktok', { state: 'error', channel: this.username, detail: `${detail} Retrying in ${Math.round(delay / 1000)}s.` });
        this.retry(delay);
      }
    }
  }

  private user(u: any, identity?: any): ChatUser {
    const login = String(u?.uniqueId || u?.displayId || u?.nickname || 'unknown').toLowerCase();
    const badges: Badge[] = [];
    if (identity?.isAnchor) badges.push({ id: 'tiktok:broadcaster', title: 'Host' });
    if (identity?.isModeratorOfAnchor) badges.push({ id: 'tiktok:moderator', title: 'Moderator' });
    if (identity?.isSubscriberOfAnchor) badges.push({ id: 'tiktok:subscriber', title: 'Subscriber' });
    const fanLevel = u?.fansClub?.data?.level || u?.fansClubInfo?.fansLevel;
    if (fanLevel) badges.push({ id: 'tiktok:fan', title: `Fan club level ${fanLevel}` });
    return {
      id: String(u?.userId || u?.id || login),
      login,
      name: u?.nickname || login,
      color: defaultColor(login),
      avatar: img(u?.avatarThumb),
      badges,
      mod: !!identity?.isModeratorOfAnchor,
      broadcaster: !!identity?.isAnchor || login === this.username,
    };
  }

  private wire(conn: any) {
    const live = () => this.conn === conn && !this.stopped;
    const id = (d: any, p: string) => String(d?.common?.msgId || d?.msgId || localId(p));

    conn.on(WebcastEvent.CHAT, (d: any) => {
      if (!live()) return;
      const text: string = d.comment ?? d.content ?? '';
      const user = this.user(d.user, d.userIdentity);
      let parts: Part[] = toParts('tiktok', undefined, text);
      // Subscriber emotes come as a separate list with insert positions.
      const list: any[] = (d.emotes || []).filter((e: any) => img(e?.emote?.image));
      if (list.length) {
        const chars = Array.from(text);
        parts = [];
        let pos = 0;
        for (const e of [...list].sort((a, b) => a.index - b.index)) {
          const at = Math.min(chars.length, Math.max(pos, e.index));
          if (at > pos) parts.push(...toParts('tiktok', undefined, chars.slice(pos, at).join('')));
          parts.push({ t: 'emote', name: e.emote.emoteId || 'emote', url: img(e.emote.image)!, src: 'tiktok' });
          pos = at;
        }
        if (pos < chars.length) parts.push(...toParts('tiktok', undefined, chars.slice(pos).join('')));
      }
      hub.push({ kind: 'chat', id: id(d, 'tt'), platform: 'tiktok', ts: Number(d.common?.createTime) || Date.now(), user, text, parts, flags: {} });
    });

    conn.on(WebcastEvent.EMOTE, (d: any) => {
      if (!live()) return;
      const user = this.user(d.user, d.userIdentity);
      const parts: Part[] = (d.emoteList || []).filter((e: any) => img(e.image)).map((e: any) => ({ t: 'emote', name: e.emoteId || 'sticker', url: img(e.image)!, src: 'tiktok' }));
      if (parts.length) hub.push({ kind: 'chat', id: id(d, 'tte'), platform: 'tiktok', ts: Date.now(), user, text: '', parts, flags: {} });
    });

    conn.on(WebcastEvent.GIFT, (d: any) => {
      if (!live()) return;
      const giftType = d.giftDetails?.giftType ?? d.gift?.type;
      if (giftType === 1 && !d.repeatEnd) return; // streak still going; we show it once it ends
      const user = this.user(d.user, d.userIdentity);
      const name = d.giftDetails?.giftName || d.gift?.name || d.extendedGiftInfo?.name || 'a gift';
      const count = Math.max(1, Number(d.repeatCount || 1));
      const diamonds = Number(d.giftDetails?.diamondCount ?? d.gift?.diamondCount ?? d.extendedGiftInfo?.diamond_count ?? 0);
      const image = d.giftDetails?.giftImage?.giftPictureUrl || img(d.gift?.image) || img(d.gift?.icon) || d.extendedGiftInfo?.image?.url_list?.[0];
      hub.push({
        kind: 'event', id: id(d, 'ttg'), platform: 'tiktok', ts: Date.now(), type: 'gift', user,
        title: `${user.name} sent ${count > 1 ? `${count}× ` : ''}${name}`,
        amount: diamonds * count, image,
        alert: diamonds * count >= settings.alerts.minDiamonds,
      });
    });

    conn.on(WebcastEvent.FOLLOW, (d: any) => {
      if (!live()) return;
      const user = this.user(d.user, d.userIdentity);
      hub.push({ kind: 'event', id: id(d, 'ttf'), platform: 'tiktok', ts: Date.now(), type: 'follow', user, title: `${user.name} followed`, alert: true });
    });

    conn.on(WebcastEvent.SHARE, (d: any) => {
      if (!live()) return;
      const user = this.user(d.user, d.userIdentity);
      hub.push({ kind: 'event', id: id(d, 'tts'), platform: 'tiktok', ts: Date.now(), type: 'share', user, title: `${user.name} shared the stream`, alert: true });
    });

    conn.on(WebcastEvent.SUB_NOTIFY, (d: any) => {
      if (!live()) return;
      const user = this.user(d.user);
      const months = Number(d.subMonth || 1);
      hub.push({ kind: 'event', id: id(d, 'ttsub'), platform: 'tiktok', ts: Date.now(), type: months > 1 ? 'resub' : 'sub', user, amount: months, alert: true,
        title: months > 1 ? `${user.name} subscribed for ${months} months` : `${user.name} subscribed` });
    });

    // Likes arrive constantly; batch them per user so they don't flood the events list.
    conn.on(WebcastEvent.LIKE, (d: any) => {
      if (!live()) return;
      const user = this.user(d.user, d.userIdentity);
      const b = this.likeBuckets.get(user.id) || { n: 0, at: 0 };
      b.n += Number(d.likeCount || 1);
      if (Date.now() - b.at > 60_000) {
        hub.push({ kind: 'event', id: localId('ttl'), platform: 'tiktok', ts: Date.now(), type: 'like', user, amount: b.n, title: `${user.name} liked the stream${b.n > 1 ? ` ×${b.n}` : ''}`, alert: true });
        b.n = 0;
        b.at = Date.now();
      }
      this.likeBuckets.set(user.id, b);
      if (this.likeBuckets.size > 5000) this.likeBuckets.clear();
    });

    conn.on(WebcastEvent.ROOM_USER, (d: any) => {
      if (!live() || !d.viewerCount || d.viewerCount === this.viewers) return;
      this.viewers = Number(d.viewerCount);
      hub.patchStatus('tiktok', { viewers: this.viewers, detail: `${this.viewers.toLocaleString('en-US')} watching` });
    });

    conn.on(WebcastEvent.IM_DELETE, (d: any) => {
      if (!live()) return;
      for (const m of d.deleteMsgIdsList || []) hub.markDeleted('tiktok', String(m));
      for (const u of d.deleteUserIdsList || []) hub.clearUser('tiktok', String(u));
    });

    conn.on(WebcastEvent.STREAM_END, () => {
      if (!live()) return;
      log.info('stream ended');
      hub.push({ kind: 'event', id: localId('ttend'), platform: 'tiktok', ts: Date.now(), type: 'live', title: 'TikTok LIVE ended' });
      this.viewers = 0;
      this.offline('Stream ended. Connects again by itself when you go LIVE.');
    });

    conn.on(ControlEvent.DISCONNECTED, () => {
      if (!live() || hub.status.tiktok.state === 'waiting') return;
      log.warn('disconnected, reconnecting');
      hub.setStatus('tiktok', { state: 'connecting', channel: this.username, detail: 'Reconnecting…' });
      this.retry(backoff(this.attempt++));
    });

    conn.on(ControlEvent.ERROR, (e: any) => {
      // Connect failures are handled (and explained) in connect(); only log errors during a stream.
      if (!live() || hub.status.tiktok.state !== 'connected') return;
      const inner = e?.exception?.message ? ` (${e.exception.message})` : '';
      log.warn(`error: ${e?.info || e?.message || e}${inner}`);
    });
  }

  async send(): Promise<void> {
    throw new UserError("TikTok doesn't let other apps send chat messages.");
  }

  async moderate(_a: ModAction): Promise<void> {
    throw new UserError("TikTok doesn't let other apps moderate chat. Use TikTok LIVE Studio or the app.");
  }

  async userCard(userId: string, login: string): Promise<UserCard> {
    const last = hub.userHistory('tiktok', userId).at(-1);
    return { platform: 'tiktok', id: userId, login, name: last?.user.name || login, avatar: last?.user.avatar, profileUrl: `https://www.tiktok.com/@${login}` };
  }
}
