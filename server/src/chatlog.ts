// Saves all chat and events to data/logs/YYYY-MM-DD.jsonl (one JSON object per line), restores the
// latest messages after a restart, and searches past days.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Item, Platform } from './types.ts';
import { DATA_DIR, settings } from './config.ts';
import { hub, type HubEvent } from './hub.ts';
import { viewers } from './viewers.ts';
import { logger } from './log.ts';

const log = logger('logs');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const pad = (n: number) => String(n).padStart(2, '0');
export const dayOf = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fileFor = (day: string) => path.join(LOG_DIR, `${day}.jsonl`);

// Lines are buffered and written once a second (and on exit), so busy chat doesn't block the server.
let buffer: { day: string; line: string }[] = [];
let flushTimer: NodeJS.Timeout | null = null;

function write(ts: number, obj: unknown) {
  if (!settings.logs.enabled) return;
  buffer.push({ day: dayOf(ts), line: JSON.stringify(obj) + '\n' });
  if (!flushTimer) flushTimer = setTimeout(flush, 1000);
}

export function flush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!buffer.length) return;
  const byDay = new Map<string, string>();
  for (const b of buffer) byDay.set(b.day, (byDay.get(b.day) || '') + b.line);
  buffer = [];
  for (const [day, text] of byDay) {
    try { fs.appendFileSync(fileFor(day), text); } catch (e: any) { log.warn(`could not write the chat log: ${e.message}`); }
  }
}
process.on('exit', flush);

export function startLogging() {
  hub.on('hub', (ev: HubEvent) => {
    if (ev.op === 'item') {
      if (ev.item.id.startsWith('test-')) return;
      write(ev.item.ts, ev.item);
    } else if (ev.op === 'delete') write(Date.now(), { op: 'del', platform: ev.platform, id: ev.id });
    else if (ev.op === 'clearUser') write(Date.now(), { op: 'clear', platform: ev.platform, userId: ev.userId, ts: Date.now() });
  });
  prune();
  setInterval(prune, 6 * 3600_000).unref();
}

function logFiles() {
  try {
    return fs.readdirSync(LOG_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch { return []; }
}

export function prune() {
  const keep = Math.max(1, settings.logs.keepDays || 90);
  const cutoff = dayOf(Date.now() - keep * 864e5);
  for (const f of logFiles()) {
    if (f.slice(0, 10) < cutoff) {
      try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch { /* in use: try next time */ }
    }
  }
}

/** Reads the last `maxBytes` of a file as lines (the first, possibly cut, line is dropped). */
function tailLines(file: string, maxBytes: number): string[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } catch { return []; }
  finally { if (fd !== null) fs.closeSync(fd); }
}

/** The newest `n` items from the saved logs (today and the day before), with deletions applied. */
export function recentFromLogs(n: number): Item[] {
  const files = logFiles().slice(-2);
  const out: Item[] = [];
  const del = new Set<string>();
  const cleared = new Map<string, number>();
  for (const f of files) {
    for (const line of tailLines(path.join(LOG_DIR, f), 3_000_000)) {
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.op === 'del') del.add(`${o.platform}:${o.id}`);
      else if (o.op === 'clear') cleared.set(`${o.platform}:${o.userId}`, o.ts);
      else if (o.kind) out.push(o);
    }
  }
  const recent = out.slice(-n);
  for (const it of recent) {
    if (it.kind !== 'chat') continue;
    const c = cleared.get(`${it.platform}:${it.user.id}`);
    if (del.has(`${it.platform}:${it.id}`) || (c && it.ts <= c)) it.deleted = true;
  }
  return recent;
}

export interface SearchQuery {
  q?: string;            // words that must all appear (case-insensitive)
  user?: string;         // login, display name or nickname
  userId?: string;       // exact user (with platform)
  platform?: Platform | '';
  kind?: 'chat' | 'events' | 'all';
  days?: number;         // how far back; 0 = everything kept
  before?: number;       // only items older than this (for "load more")
  limit?: number;
}

/** Search the saved logs, newest first. */
export async function search(sq: SearchQuery): Promise<{ results: Item[]; more: boolean; scannedDays: number }> {
  const limit = Math.min(500, Math.max(1, sq.limit || 200));
  const words = (sq.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const user = (sq.user || '').toLowerCase().replace(/^@/, '').trim();
  const kind = sq.kind || 'chat';
  const now = Date.now();
  const fromDay = sq.days ? dayOf(now - (sq.days - 1) * 864e5) : '';
  // Logins of everyone linked to a nickname/name match, so "from:bob" also finds bob_tv on Kick.
  const userKeys = new Set<string>();
  if (user) for (const v of viewers.find(user, 200)) { userKeys.add(`${v.platform}:${v.id}`); for (const o of viewers.linked(v)) userKeys.add(`${o.platform}:${o.id}`); }

  const matches = (it: any) => {
    if (sq.before && it.ts >= sq.before) return false;
    if (sq.platform && it.platform !== sq.platform) return false;
    if (kind === 'chat' && it.kind !== 'chat') return false;
    if (kind === 'events' && it.kind !== 'event') return false;
    if (sq.userId && (it.user?.id !== sq.userId)) return false;
    if (user) {
      const u = it.user;
      if (!u) return false;
      const ok = u.login?.toLowerCase().includes(user) || u.name?.toLowerCase().includes(user) || userKeys.has(`${it.platform}:${u.id}`);
      if (!ok) return false;
    }
    if (words.length) {
      const hay = (it.kind === 'chat' ? it.text : `${it.title} ${(it.parts || []).map((p: any) => p.v || p.name || '').join(' ')}`).toLowerCase();
      if (!words.every(w => hay.includes(w))) return false;
    }
    return true;
  };

  flush();
  const files = logFiles().filter(f => !fromDay || f.slice(0, 10) >= fromDay).reverse();
  const results: Item[] = [];
  let scanned = 0;
  for (const f of files) {
    if (sq.before && f.slice(0, 10) > dayOf(sq.before)) continue;
    scanned++;
    const found: Item[] = [];
    const del = new Set<string>();
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(LOG_DIR, f), 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.op === 'del') { del.add(`${o.platform}:${o.id}`); continue; }
      if (o.op) continue;
      if (matches(o)) found.push(o);
    }
    for (const it of found) if (it.kind === 'chat' && del.has(`${it.platform}:${it.id}`)) it.deleted = true;
    results.push(...found.reverse());
    if (results.length > limit) break;
  }
  return { results: results.slice(0, limit), more: results.length > limit, scannedDays: scanned };
}

/** Disk space used by the logs, for the settings page. */
export function logUsage() {
  let bytes = 0;
  const files = logFiles();
  for (const f of files) { try { bytes += fs.statSync(path.join(LOG_DIR, f)).size; } catch { /* gone */ } }
  return { days: files.length, bytes, oldest: files[0]?.slice(0, 10) || null };
}
