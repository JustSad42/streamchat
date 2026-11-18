// Slash commands typed in the message box (/ban, /timeout, /slow, /shoutout…). The app sends the
// raw text; this parses it and runs it on each target platform that supports the command.

import type { Platform } from './types.ts';
import { UserError } from './connectors/base.ts';

export interface ParsedCommand { name: string; args: string[]; rest: string; raw: string }

export interface CommandInfo { name: string; usage: string; desc: string; platforms: Platform[]; aliases?: string[] }

const TK: Platform[] = ['twitch', 'kick'];
const T: Platform[] = ['twitch'];

export const COMMANDS: CommandInfo[] = [
  { name: 'ban', usage: '/ban <user> [reason]', desc: 'Ban someone', platforms: TK },
  { name: 'unban', usage: '/unban <user>', desc: 'Lift a ban or timeout', platforms: TK, aliases: ['untimeout'] },
  { name: 'timeout', usage: '/timeout <user> [10m] [reason]', desc: 'Time someone out (default 10 minutes)', platforms: TK, aliases: ['to'] },
  { name: 'me', usage: '/me <text>', desc: 'Send an action message', platforms: TK },
  { name: 'clear', usage: '/clear', desc: 'Clear chat for everyone', platforms: T },
  { name: 'slow', usage: '/slow [seconds]', desc: 'Slow mode (default 30s)', platforms: T },
  { name: 'slowoff', usage: '/slowoff', desc: 'Turn off slow mode', platforms: T },
  { name: 'emoteonly', usage: '/emoteonly', desc: 'Emote-only mode', platforms: T },
  { name: 'emoteonlyoff', usage: '/emoteonlyoff', desc: 'Turn off emote-only mode', platforms: T },
  { name: 'followers', usage: '/followers [10m]', desc: 'Followers-only mode (optionally for at least this long)', platforms: T },
  { name: 'followersoff', usage: '/followersoff', desc: 'Turn off followers-only mode', platforms: T },
  { name: 'subscribers', usage: '/subscribers', desc: 'Subscribers-only mode', platforms: T },
  { name: 'subscribersoff', usage: '/subscribersoff', desc: 'Turn off subscribers-only mode', platforms: T },
  { name: 'uniquechat', usage: '/uniquechat', desc: 'Block repeated messages', platforms: T },
  { name: 'uniquechatoff', usage: '/uniquechatoff', desc: 'Allow repeated messages', platforms: T },
  { name: 'shoutout', usage: '/shoutout <channel>', desc: 'Twitch shoutout', platforms: T, aliases: ['so'] },
  { name: 'announce', usage: '/announce <text>', desc: 'Highlighted announcement', platforms: T },
  { name: 'raid', usage: '/raid <channel>', desc: 'Raid another channel', platforms: T },
  { name: 'unraid', usage: '/unraid', desc: 'Cancel a raid', platforms: T },
  { name: 'mod', usage: '/mod <user>', desc: 'Make someone a moderator', platforms: T },
  { name: 'unmod', usage: '/unmod <user>', desc: 'Remove a moderator', platforms: T },
  { name: 'vip', usage: '/vip <user>', desc: 'Give someone VIP', platforms: T },
  { name: 'unvip', usage: '/unvip <user>', desc: 'Remove VIP', platforms: T },
  { name: 'help', usage: '/help', desc: 'List commands', platforms: TK },
];

const byName = new Map<string, CommandInfo>();
for (const c of COMMANDS) { byName.set(c.name, c); for (const a of c.aliases || []) byName.set(a, c); }

export function findCommand(name: string) { return byName.get(name.toLowerCase()); }

export function parseCommand(text: string): ParsedCommand | null {
  const t = text.trim();
  if (!t.startsWith('/') || t.startsWith('//')) return null;
  const m = /^\/(\S+)\s*(.*)$/s.exec(t);
  if (!m) return null;
  const info = findCommand(m[1]);
  const rest = m[2].trim();
  return { name: info?.name || m[1].toLowerCase(), args: rest ? rest.split(/\s+/) : [], rest, raw: t };
}

/** "10m" → 600, "1h30m" → 5400, "90" → 90 (seconds), "2d", "1w". Null if it isn't a duration. */
export function parseDuration(s: string | undefined): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const re = /(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|wk|wks)/gi;
  let total = 0, matched = '', m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    const u = m[2][0].toLowerCase();
    total += n * ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 } as Record<string, number>)[u];
    matched += m[0];
  }
  return matched.replace(/\s/g, '').length === s.replace(/\s/g, '').length && total > 0 ? total : null;
}

export const needUser = (c: ParsedCommand) => {
  const u = c.args[0]?.replace(/^@/, '');
  if (!u) throw new UserError(`Usage: ${findCommand(c.name)?.usage || '/' + c.name + ' <user>'}`);
  return u.toLowerCase();
};

/** Thrown by a connector for a command it doesn't support. */
export class Unsupported extends Error {}
