// Third-party emotes: 7TV (Twitch + Kick), FrankerFaceZ and BetterTTV (Twitch).
// Also turns message text into parts (text / emote / mention / link) for every platform.

import { EventEmitter } from 'node:events';
import type { EmoteSource, Part, Platform } from './types.ts';
import { settings } from './config.ts';
import { logger } from './log.ts';

const log = logger('emotes');

export interface Emote { name: string; url: string; src: EmoteSource; zw?: boolean; w?: number; h?: number }
type EmoteMap = Map<string, Emote>;
interface Sets { seventv: EmoteMap; ffz: EmoteMap; bttv: EmoteMap }
const emptySets = (): Sets => ({ seventv: new Map(), ffz: new Map(), bttv: new Map() });

// Native emote occurrence found by a connector (positions are in code points, end inclusive).
export interface NativeEmote { start: number; end: number; name: string; url: string; src: EmoteSource }

const BTTV_ZERO_WIDTH = new Set(['SoSnowy', 'IceCold', 'SantaHat', 'TopHat', 'ReinDeer', 'CandyCane', 'cvMask', 'cvHazmat']);

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { headers: { 'User-Agent': 'StreamChat/0.1' }, signal: AbortSignal.timeout(15000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

// ---------- 7TV ----------

function sevenTvEmote(e: any): Emote | null {
  const d = e.data;
  if (!d?.host?.url) return null;
  const files: any[] = d.host.files || [];
  const pick = files.find(f => f.name === '2x.webp') || files.find(f => f.name.endsWith('.webp')) || files[0];
  const base = d.host.url.startsWith('//') ? 'https:' + d.host.url : d.host.url;
  const one = files.find(f => f.name === '1x.webp');
  return {
    name: e.name,
    url: `${base}/${pick?.name || '2x.webp'}`,
    src: '7tv',
    zw: ((e.flags ?? 0) & 1) === 1 || ((d.flags ?? 0) & 256) === 256,
    w: one?.width, h: one?.height,
  };
}

function sevenTvSet(set: any): EmoteMap {
  const m: EmoteMap = new Map();
  for (const e of set?.emotes || []) {
    const em = sevenTvEmote(e);
    if (em) m.set(em.name, em);
  }
  return m;
}

// ---------- FFZ ----------

function ffzSets(json: any, setIds?: number[]): EmoteMap {
  const m: EmoteMap = new Map();
  const sets = json?.sets || {};
  for (const id of setIds ?? Object.keys(sets)) {
    for (const e of sets[id]?.emoticons || []) {
      if (e.hidden || e.modifier) continue; // modifiers are effects (flip, spin...), not images
      const urls = e.animated || e.urls || {};
      let url: string = urls['2'] || urls['1'] || urls['4'];
      if (!url) continue;
      if (url.startsWith('//')) url = 'https:' + url;
      if (e.animated) url += url.endsWith('.webp') ? '' : '.webp';
      m.set(e.name, { name: e.name, url, src: 'ffz', w: e.width, h: e.height });
    }
  }
  return m;
}

// ---------- BTTV ----------

function bttvList(list: any[]): EmoteMap {
  const m: EmoteMap = new Map();
  for (const e of list || []) {
    m.set(e.code, {
      name: e.code,
      url: `https://cdn.betterttv.net/emote/${e.id}/2x.webp`,
      src: 'bttv',
      zw: BTTV_ZERO_WIDTH.has(e.code),
      w: e.width, h: e.height,
    });
  }
  return m;
}

// ---------- Store ----------

class EmoteStore extends EventEmitter {
  private global = emptySets();
  private channels = new Map<string, Sets>();     // `${platform}:${channelId}`
  private sevenTvSetOf = new Map<string, string>(); // channel key -> 7TV set id
  private sevenTvUserOf = new Map<string, string>();
  private ws: WebSocket | null = null;
  private wsSubs = new Set<string>();
  private reloadTimers = new Map<string, NodeJS.Timeout>();

  async loadGlobals() {
    const [s, f, b] = await Promise.allSettled([
      getJson('https://7tv.io/v3/emote-sets/global'),
      getJson('https://api.frankerfacez.com/v1/set/global'),
      getJson('https://api.betterttv.net/3/cached/emotes/global'),
    ]);
    if (s.status === 'fulfilled') this.global.seventv = sevenTvSet(s.value); else log.warn('7TV global:', s.reason);
    if (f.status === 'fulfilled') this.global.ffz = ffzSets(f.value, f.value?.default_sets); else log.warn('FFZ global:', f.reason);
    if (b.status === 'fulfilled') this.global.bttv = bttvList(b.value); else log.warn('BTTV global:', b.reason);
    log.info(`global emotes: 7TV ${this.global.seventv.size}, FFZ ${this.global.ffz.size}, BTTV ${this.global.bttv.size}`);
    this.emit('changed');
  }

  // channelId: Twitch user id, or Kick user id.
  async loadChannel(platform: Platform, channelId: string) {
    if (platform === 'tiktok' || !channelId) return;
    const key = `${platform}:${channelId}`;
    const sets = emptySets();
    const jobs: Promise<void>[] = [];

    jobs.push(getJson(`https://7tv.io/v3/users/${platform}/${channelId}`).then(j => {
      if (!j) return;
      sets.seventv = sevenTvSet(j.emote_set);
      if (j.emote_set?.id) this.sevenTvSetOf.set(key, j.emote_set.id);
      if (j.user?.id) this.sevenTvUserOf.set(key, j.user.id);
    }).catch(e => log.warn(`7TV ${platform} channel:`, e)));

    if (platform === 'twitch') {
      jobs.push(getJson(`https://api.frankerfacez.com/v1/room/id/${channelId}`).then(j => {
        if (j) sets.ffz = ffzSets(j);
      }).catch(e => log.warn('FFZ channel:', e)));
      jobs.push(getJson(`https://api.betterttv.net/3/cached/users/twitch/${channelId}`).then(j => {
        if (j) sets.bttv = bttvList([...(j.channelEmotes || []), ...(j.sharedEmotes || [])]);
      }).catch(e => log.warn('BTTV channel:', e)));
    }

    await Promise.all(jobs);
    this.channels.set(key, sets);
    log.info(`${platform} channel emotes: 7TV ${sets.seventv.size}, FFZ ${sets.ffz.size}, BTTV ${sets.bttv.size}`);
    this.watch7tv(key);
    this.emit('changed');
  }

  // For tests: set a channel's emotes without network access.
  injectChannel(platform: Platform, channelId: string, list: Emote[]) {
    const sets = emptySets();
    for (const e of list) sets[e.src === '7tv' ? 'seventv' : e.src === 'ffz' ? 'ffz' : 'bttv'].set(e.name, e);
    this.channels.set(`${platform}:${channelId}`, sets);
  }

  dropChannel(platform: Platform, channelId: string) {
    this.channels.delete(`${platform}:${channelId}`);
  }

  private enabled(): Record<keyof Sets, boolean> {
    return { seventv: settings.emotes.sevenTv, ffz: settings.emotes.ffz, bttv: settings.emotes.bttv };
  }

  lookup(platform: Platform, channelId: string | undefined, word: string): Emote | undefined {
    const on = this.enabled();
    const ch = channelId ? this.channels.get(`${platform}:${channelId}`) : undefined;
    const order: (keyof Sets)[] = ['seventv', 'bttv', 'ffz'];
    if (ch) for (const k of order) { if (on[k]) { const e = ch[k].get(word); if (e) return e; } }
    // Globals: 7TV globals everywhere it's supported; FFZ/BTTV globals only on Twitch.
    if (platform === 'tiktok') return undefined;
    for (const k of order) {
      if (!on[k] || (platform === 'kick' && k !== 'seventv')) continue;
      const e = this.global[k].get(word);
      if (e) return e;
    }
    return undefined;
  }

  // All emotes usable in a channel, for autocomplete in the app.
  list(platform: Platform, channelId: string | undefined) {
    const out = new Map<string, Emote>();
    const on = this.enabled();
    const add = (m: EmoteMap) => { for (const [k, v] of m) if (!out.has(k)) out.set(k, v); };
    const ch = channelId ? this.channels.get(`${platform}:${channelId}`) : undefined;
    for (const k of ['seventv', 'bttv', 'ffz'] as const) if (on[k] && ch) add(ch[k]);
    for (const k of ['seventv', 'bttv', 'ffz'] as const) {
      if (!on[k] || platform === 'tiktok' || (platform === 'kick' && k !== 'seventv')) continue;
      add(this.global[k]);
    }
    return [...out.values()];
  }

  // ---------- 7TV live updates (EventAPI) ----------

  private watch7tv(key: string) {
    const setId = this.sevenTvSetOf.get(key);
    const userId = this.sevenTvUserOf.get(key);
    const subs: string[] = [];
    if (setId) subs.push(`emote_set.update|${setId}`);
    if (userId) subs.push(`user.update|${userId}`);
    let added = false;
    for (const s of subs) if (!this.wsSubs.has(s)) { this.wsSubs.add(s); added = true; }
    if (!this.ws) this.connect7tv();
    else if (added && this.ws.readyState === WebSocket.OPEN) this.sendSubs();
  }

  private connect7tv() {
    const ws = new WebSocket('wss://events.7tv.io/v3');
    this.ws = ws;
    ws.onopen = () => this.sendSubs();
    ws.onmessage = ev => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.op !== 0) return; // only dispatches matter
      const type: string = msg.d?.type || '';
      const objectId: string = msg.d?.body?.id || '';
      for (const [key, setId] of this.sevenTvSetOf) {
        const userId = this.sevenTvUserOf.get(key);
        if ((type.startsWith('emote_set') && objectId === setId) || (type.startsWith('user') && objectId === userId)) {
          this.scheduleReload(key);
        }
      }
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.wsSubs.size) setTimeout(() => { if (!this.ws) this.connect7tv(); }, 5000 + Math.random() * 5000);
    };
    ws.onerror = () => { /* onclose handles reconnect */ };
  }

  private sendSubs() {
    for (const s of this.wsSubs) {
      const [type, id] = s.split('|');
      this.ws?.send(JSON.stringify({ op: 35, d: { type, condition: { object_id: id } } }));
    }
  }

  private scheduleReload(key: string) {
    clearTimeout(this.reloadTimers.get(key));
    this.reloadTimers.set(key, setTimeout(() => {
      const [platform, id] = key.split(':') as [Platform, string];
      log.info(`7TV emote change on ${platform}, reloading`);
      this.loadChannel(platform, id).catch(() => {});
    }, 1500));
  }
}

export const emotes = new EmoteStore();

// ---------- Text -> parts ----------

const URL_RE = /^(?:https?:\/\/\S+|www\.\S+\.\S+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|tv|gg|io|me|co|uk|de|app|dev|ly|link|be|xyz)(?:\/\S*)?)$/i;

// Split plain text into words; look each one up as an emote, mention or link.
function wordsToParts(platform: Platform, channelId: string | undefined, text: string, out: Part[]) {
  for (const tok of text.split(/(\s+)/)) {
    if (!tok) continue;
    if (/^\s+$/.test(tok)) { out.push({ t: 'text', v: tok }); continue; }
    const em = emotes.lookup(platform, channelId, tok);
    if (em) { pushEmote(out, { t: 'emote', name: em.name, url: em.url, src: em.src, zw: em.zw, w: em.w, h: em.h }); continue; }
    if (/^@[\p{L}\p{N}_.-]{2,}$/u.test(tok)) { out.push({ t: 'mention', v: tok }); continue; }
    if (URL_RE.test(tok)) {
      const href = /^https?:\/\//i.test(tok) ? tok : 'https://' + tok;
      out.push({ t: 'link', v: tok, href });
      continue;
    }
    out.push({ t: 'text', v: tok });
  }
}

// Zero-width emotes stack on top of the previous emote instead of standing alone.
function pushEmote(out: Part[], e: Extract<Part, { t: 'emote' }>) {
  if (e.zw) {
    let i = out.length - 1;
    while (i >= 0 && out[i].t === 'text' && /^\s*$/.test((out[i] as any).v)) i--;
    const prev = out[i];
    if (prev && prev.t === 'emote') {
      out.length = i + 1; // drop the whitespace between them
      (prev.overlays ||= []).push(e);
      return;
    }
  }
  out.push(e);
}

function mergeText(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (p.t === 'text' && last?.t === 'text') last.v += p.v;
    else out.push(p);
  }
  return out;
}

export function toParts(platform: Platform, channelId: string | undefined, text: string, native: NativeEmote[] = []): Part[] {
  const parts: Part[] = [];
  if (!native.length) {
    wordsToParts(platform, channelId, text, parts);
    return mergeText(parts);
  }
  const chars = Array.from(text); // native positions are in code points
  const sorted = [...native].sort((a, b) => a.start - b.start);
  let pos = 0;
  for (const n of sorted) {
    if (n.start < pos) continue;
    if (n.start > pos) wordsToParts(platform, channelId, chars.slice(pos, n.start).join(''), parts);
    pushEmote(parts, { t: 'emote', name: n.name, url: n.url, src: n.src });
    pos = n.end + 1;
  }
  if (pos < chars.length) wordsToParts(platform, channelId, chars.slice(pos).join(''), parts);
  return mergeText(parts);
}
