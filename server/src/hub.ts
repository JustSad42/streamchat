// Central hub: keeps recent chat in memory, per-user history for user cards,
// applies highlight rules and fans everything out to connected clients.

import { EventEmitter } from 'node:events';
import type { ChatMessage, EventMessage, Item, Platform, PlatformStatus } from './types.ts';
import { settings } from './config.ts';
import { viewers } from './viewers.ts';

const MAX_ITEMS = 1500;
const MAX_USER_HISTORY = 100;

export type HubEvent =
  | { op: 'item'; item: Item }
  | { op: 'delete'; platform: Platform; id: string }
  | { op: 'clearUser'; platform: Platform; userId: string }
  | { op: 'status'; status: Record<Platform, PlatformStatus> }
  | { op: 'settings' }
  | { op: 'viewer'; platform: Platform; userId: string; tag: ChatMessage['viewer'] }
  | { op: 'alertTest'; item: EventMessage };

class Hub extends EventEmitter {
  items: Item[] = [];
  private byUser = new Map<string, ChatMessage[]>();
  private byId = new Map<string, Item>();
  status: Record<Platform, PlatformStatus> = {
    twitch: { state: 'off' }, kick: { state: 'off' }, tiktok: { state: 'off' },
  };
  // Names you're logged in as / streaming as, per platform, for mention detection.
  selfNames: Record<Platform, string[]> = { twitch: [], kick: [], tiktok: [] };
  private highlightCache: { src: string; rules: { test: (s: string) => boolean; color: string }[] } = { src: '', rules: [] };
  private filterCache: { src: string; test: (s: string) => boolean } = { src: '', test: () => false };

  /** Put back messages from the saved log after a restart (already decorated, not re-announced). */
  restore(list: Item[]) {
    for (const item of list) {
      const key = `${item.platform}:${item.id}`;
      if (this.byId.has(key)) continue;
      this.items.push(item);
      this.byId.set(key, item);
      if (item.kind === 'chat') {
        const uk = `${item.platform}:${item.user.id}`;
        let l = this.byUser.get(uk);
        if (!l) this.byUser.set(uk, (l = []));
        l.push(item);
        if (l.length > MAX_USER_HISTORY) l.shift();
      }
    }
    if (this.items.length > MAX_ITEMS) for (const old of this.items.splice(0, this.items.length - MAX_ITEMS)) this.byId.delete(`${old.platform}:${old.id}`);
  }

  /** Tell clients a viewer's nickname/note/links changed (updates every linked account too). */
  viewerChanged(platform: Platform, userId: string) {
    const v = viewers.get(platform, userId);
    for (const x of v ? [v, ...viewers.linked(v)] : [{ platform, id: userId }]) {
      const tag = viewers.tag(x.platform, x.id);
      for (const m of this.byUser.get(`${x.platform}:${x.id}`) || []) m.viewer = tag;
      this.emit('hub', { op: 'viewer', platform: x.platform, userId: x.id, tag } satisfies HubEvent);
    }
  }

  push(item: Item) {
    const key = `${item.platform}:${item.id}`;
    if (this.byId.has(key)) return; // duplicate (e.g. our own sent message echoed back)
    if (item.kind === 'chat') this.decorate(item);
    this.items.push(item);
    this.byId.set(key, item);
    if (this.items.length > MAX_ITEMS) {
      const old = this.items.shift()!;
      this.byId.delete(`${old.platform}:${old.id}`);
    }
    if (item.kind === 'chat') {
      const uk = `${item.platform}:${item.user.id}`;
      let list = this.byUser.get(uk);
      if (!list) this.byUser.set(uk, (list = []));
      list.push(item);
      if (list.length > MAX_USER_HISTORY) list.shift();
    }
    this.emit('hub', { op: 'item', item } satisfies HubEvent);
  }

  markDeleted(platform: Platform, id: string) {
    const it = this.byId.get(`${platform}:${id}`);
    if (it && it.kind === 'chat') it.deleted = true;
    this.emit('hub', { op: 'delete', platform, id } satisfies HubEvent);
  }

  clearUser(platform: Platform, userId: string) {
    for (const m of this.byUser.get(`${platform}:${userId}`) || []) m.deleted = true;
    this.emit('hub', { op: 'clearUser', platform, userId } satisfies HubEvent);
  }

  setStatus(platform: Platform, s: PlatformStatus) {
    this.status[platform] = s;
    this.emit('hub', { op: 'status', status: this.status } satisfies HubEvent);
  }

  patchStatus(platform: Platform, s: Partial<PlatformStatus>) {
    this.setStatus(platform, { ...this.status[platform], ...s });
  }

  userHistory(platform: Platform, userId: string) {
    return this.byUser.get(`${platform}:${userId}`) || [];
  }

  findUserByLogin(platform: Platform, login: string) {
    login = login.toLowerCase();
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.kind === 'chat' && it.platform === platform && it.user.login === login) return it.user;
    }
    return undefined;
  }

  get(platform: Platform, id: string) {
    return this.byId.get(`${platform}:${id}`);
  }

  private rules() {
    const src = JSON.stringify(settings.highlights);
    if (src !== this.highlightCache.src) {
      const rules: { test: (s: string) => boolean; color: string }[] = [];
      for (const r of settings.highlights) {
        if (r.enabled === false || !r.pattern) continue;
        try {
          const re = r.regex
            ? new RegExp(r.pattern, 'i')
            : new RegExp(`(^|[^\\p{L}\\p{N}_])${r.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}_])`, 'iu');
          rules.push({ test: s => re.test(s), color: r.color || '#f59e0b' });
        } catch { /* invalid regex: skip */ }
      }
      this.highlightCache = { src, rules };
    }
    return this.highlightCache.rules;
  }

  /** Does this text contain a blocked word? */
  isBlocked(text: string) {
    const src = JSON.stringify(settings.filters.terms);
    if (src !== this.filterCache.src) {
      const res: RegExp[] = [];
      for (const r of settings.filters.terms) {
        if (!r.pattern?.trim()) continue;
        try {
          res.push(r.regex
            ? new RegExp(r.pattern, 'iu')
            : new RegExp(`(^|[^\\p{L}\\p{N}_])${r.pattern.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}($|[^\\p{L}\\p{N}_])`, 'iu'));
        } catch { /* invalid regex: skip */ }
      }
      this.filterCache = { src, test: s => res.some(re => re.test(s)) };
    }
    return this.filterCache.test(text);
  }

  private decorate(m: ChatMessage) {
    const names = this.selfNames[m.platform];
    if (names.includes(m.user.login)) m.flags.self = true;
    // First-time chatters: Twitch tells us; for Kick and TikTok, it's whoever StreamChat hasn't seen before.
    const firstSeen = !m.flags.self && viewers.seen(m);
    if (m.platform !== 'twitch' && firstSeen && viewers.warmedUp(m.platform, m.ts)) m.flags.firstMsg = true;
    if (!settings.firstChatter || m.flags.self) delete m.flags.firstMsg;
    const tag = viewers.tag(m.platform, m.user.id);
    if (tag) m.viewer = tag;
    if (!m.flags.self && settings.filters.terms.length && this.isBlocked(m.text)) m.flags.blocked = true;
    if (settings.highlightMentions && !m.flags.self && names.length) {
      const lower = m.text.toLowerCase();
      for (const n of names) {
        if (!n) continue;
        const re = new RegExp(`(^|[^a-z0-9_])@?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_])`);
        if (re.test(lower)) { m.flags.mention = true; break; }
      }
    }
    for (const r of this.rules()) {
      if (r.test(m.text)) { m.flags.highlight = r.color; break; }
    }
  }
}

export const hub = new Hub();
hub.setMaxListeners(100);

let seq = 0;
export const localId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
