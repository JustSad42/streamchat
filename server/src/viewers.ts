// Everyone who has chatted in your channel: first/last seen, message count, plus your own
// nickname and notes for them, and links between the same person's accounts on different platforms.
// Stored in data/viewers.json.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ChatMessage, Platform, ViewerTag } from './types.ts';
import { PLATFORMS } from './types.ts';
import { DATA_DIR } from './config.ts';
import { logger } from './log.ts';

const log = logger('viewers');
const FILE = path.join(DATA_DIR, 'viewers.json');
// Kick and TikTok don't say whether a message is someone's first, so StreamChat works it out
// from who it has seen. Right after install everyone looks new, so wait this long first.
export const FIRST_CHATTER_WARMUP_MS = 3 * 864e5;

export interface Viewer {
  platform: Platform;
  id: string;
  login: string;
  name: string;
  firstSeen: number;
  lastSeen: number;
  messages: number;
  nick?: string;
  note?: string;
  group?: string;     // viewers sharing a group are the same person on different platforms
}

export type ViewerRef = Pick<Viewer, 'platform' | 'id' | 'login' | 'name'>;

const key = (platform: string, id: string) => `${platform}:${id}`;

class ViewerStore {
  private map = new Map<string, Viewer>();
  private groups = new Map<string, Set<string>>();
  trackingSince: Record<Platform, number> = { twitch: 0, kick: 0, tiktok: 0 };
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor() {
    try {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      for (const v of j.viewers || []) this.index(v);
      Object.assign(this.trackingSince, j.trackingSince || {});
    } catch (e: any) {
      if (e.code !== 'ENOENT') log.warn(`could not read viewers.json: ${e.message}`);
    }
    process.on('exit', () => this.flush());
  }

  private index(v: Viewer) {
    this.map.set(key(v.platform, v.id), v);
    if (v.group) {
      let g = this.groups.get(v.group);
      if (!g) this.groups.set(v.group, (g = new Set()));
      g.add(key(v.platform, v.id));
    }
  }

  private changed() {
    this.dirty = true;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 5000);
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, trackingSince: this.trackingSince, viewers: [...this.map.values()] }));
      fs.renameSync(tmp, FILE);
    } catch (e: any) { log.warn(`could not save viewers.json: ${e.message}`); }
  }

  /** Records a chat message. Returns true when this is the first time StreamChat has seen this person. */
  seen(m: ChatMessage): boolean {
    const now = m.ts || Date.now();
    if (!this.trackingSince[m.platform]) this.trackingSince[m.platform] = now;
    const k = key(m.platform, m.user.id);
    const v = this.map.get(k);
    if (v) {
      v.lastSeen = now;
      v.messages++;
      v.login = m.user.login;
      v.name = m.user.name;
      this.changed();
      return false;
    }
    this.index({ platform: m.platform, id: m.user.id, login: m.user.login, name: m.user.name, firstSeen: now, lastSeen: now, messages: 1 });
    this.changed();
    return true;
  }

  /** True once StreamChat has watched this platform long enough to tell new chatters from regulars. */
  warmedUp(platform: Platform, now = Date.now()) {
    return !!this.trackingSince[platform] && now - this.trackingSince[platform] > FIRST_CHATTER_WARMUP_MS;
  }

  get(platform: Platform, id: string) { return this.map.get(key(platform, id)); }

  /** Make sure a viewer exists (e.g. someone you look up before they have chatted). */
  ensure(r: ViewerRef): Viewer {
    const k = key(r.platform, r.id);
    let v = this.map.get(k);
    if (!v) {
      v = { ...r, firstSeen: 0, lastSeen: 0, messages: 0 };
      this.index(v);
      this.changed();
    }
    return v;
  }

  update(r: ViewerRef, patch: { nick?: string; note?: string }) {
    const v = this.ensure(r);
    if (typeof patch.nick === 'string') v.nick = patch.nick.trim().slice(0, 40) || undefined;
    if (typeof patch.note === 'string') v.note = patch.note.slice(0, 2000) || undefined;
    // Nicknames and notes are shared by all of a person's linked accounts.
    for (const o of this.linked(v)) {
      if ('nick' in patch) o.nick = v.nick;
      if ('note' in patch) o.note = v.note;
    }
    this.changed();
    return v;
  }

  linked(v: Viewer): Viewer[] {
    if (!v.group) return [];
    return [...(this.groups.get(v.group) || [])].filter(k => k !== key(v.platform, v.id)).map(k => this.map.get(k)!).filter(Boolean);
  }

  link(a: ViewerRef, b: ViewerRef) {
    const va = this.ensure(a), vb = this.ensure(b);
    if (va === vb) return va;
    const target = va.group || vb.group || crypto.randomBytes(6).toString('hex');
    for (const v of [va, ...this.linked(va), vb, ...this.linked(vb)]) {
      if (v.group && v.group !== target) this.groups.get(v.group)?.delete(key(v.platform, v.id));
      v.group = target;
      this.index(v);
    }
    // Keep one nickname/note for the person.
    const nick = va.nick || vb.nick, note = [va.note, vb.note].filter(Boolean).filter((x, i, arr) => arr.indexOf(x) === i).join('\n\n') || undefined;
    for (const v of [va, ...this.linked(va)]) { v.nick = nick; v.note = note; }
    this.changed();
    return va;
  }

  unlink(r: { platform: Platform; id: string }) {
    const v = this.get(r.platform, r.id);
    if (!v?.group) return;
    const g = this.groups.get(v.group);
    g?.delete(key(v.platform, v.id));
    if (g && g.size === 1) { const last = this.map.get([...g][0]); if (last) last.group = undefined; this.groups.delete(v.group); }
    v.group = undefined;
    this.changed();
  }

  /** People matching a name, across platforms, most recently active first. */
  find(q: string, limit = 20, exclude?: Platform) {
    q = q.toLowerCase().replace(/^@/, '').trim();
    if (!q) return [];
    const out: Viewer[] = [];
    for (const v of this.map.values()) {
      if (exclude && v.platform === exclude) continue;
      if (v.login.toLowerCase().includes(q) || v.name.toLowerCase().includes(q) || v.nick?.toLowerCase().includes(q)) out.push(v);
    }
    const starts = (v: Viewer) => v.login.startsWith(q) || v.name.toLowerCase().startsWith(q) ? 1 : 0;
    return out.sort((a, b) => starts(b) - starts(a) || b.lastSeen - a.lastSeen).slice(0, limit);
  }

  tag(platform: Platform, id: string): ViewerTag | undefined {
    const v = this.get(platform, id);
    if (!v) return undefined;
    const linked = this.linked(v).map(o => o.platform).filter((p, i, a) => a.indexOf(p) === i);
    if (!v.nick && !v.note && !linked.length) return undefined;
    return { nick: v.nick, hasNote: !!v.note || undefined, linked: linked.length ? linked : undefined };
  }

  stats() {
    const byPlatform = Object.fromEntries(PLATFORMS.map(p => [p, 0])) as Record<Platform, number>;
    for (const v of this.map.values()) byPlatform[v.platform]++;
    return byPlatform;
  }
}

export const viewers = new ViewerStore();
