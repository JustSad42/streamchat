import { TwitchConnector } from './twitch.ts';
import { KickConnector } from './kick.ts';
import { TikTokConnector } from './tiktok.ts';
import { settings, type Settings } from '../config.ts';
import { PLATFORMS, type ModAction, type Platform } from '../types.ts';
import { hub, type HubEvent } from '../hub.ts';
import { viewers } from '../viewers.ts';
import { COMMANDS, findCommand, parseCommand, Unsupported } from '../commands.ts';
import { UserError, type Connector } from './base.ts';
import { logger } from '../log.ts';

const log = logger('mod');

export const connectors = {
  twitch: new TwitchConnector(),
  kick: new KickConnector(),
  tiktok: new TikTokConnector(),
};

export async function startAll() {
  await Promise.all(PLATFORMS.map(p => connectors[p].start().catch(() => {})));
}

// Restart only the platforms whose connection settings changed.
export async function restartChanged(before: Settings) {
  const jobs: Promise<void>[] = [];
  for (const p of PLATFORMS) {
    const a: any = { ...(before as any)[p] }, b: any = { ...(settings as any)[p] };
    delete a.webhookUrl; delete b.webhookUrl;
    if (JSON.stringify(a) !== JSON.stringify(b)) jobs.push(connectors[p].restart());
  }
  await Promise.all(jobs);
}

export interface CommandResult { platform: Platform; ok: boolean; message: string }

/** Runs a slash command on one platform, or on every platform you can send to. */
export async function runCommand(target: Platform | 'all', text: string): Promise<{ results: CommandResult[]; help?: typeof COMMANDS }> {
  const c = parseCommand(text);
  if (!c) throw new UserError('Not a command.');
  if (c.name === 'help') return { results: [], help: COMMANDS };
  const info = findCommand(c.name);
  if (!info) throw new UserError(`Unknown command /${c.name}. Type /help to see them all.`);
  const targets: Platform[] = target === 'all' ? PLATFORMS.filter(p => hub.status[p].canSend) : [target];
  if (!targets.length) throw new UserError('Sign in to Twitch or Kick to use commands.');
  const usable = targets.filter(p => info.platforms.includes(p));
  if (!usable.length) throw new UserError(`/${c.name} only works on ${info.platforms.map(p => p[0].toUpperCase() + p.slice(1)).join(' and ')}.`);
  const results = await Promise.all(usable.map(async (p): Promise<CommandResult> => {
    try {
      const fn = (connectors[p] as Connector).command;
      if (!fn) throw new Unsupported();
      return { platform: p, ok: true, message: await fn.call(connectors[p], c) };
    } catch (e: any) {
      return { platform: p, ok: false, message: e instanceof Unsupported ? `/${c.name} isn't available here` : e.message };
    }
  }));
  return { results };
}

/** Ban/timeout/unban someone on their platform and every linked account you can moderate. */
export async function moderateEverywhere(platform: Platform, action: Extract<ModAction, { userId: string }>) {
  const v = viewers.get(platform, action.userId);
  const targets = [{ platform, userId: action.userId, login: action.login }];
  if (v) for (const o of viewers.linked(v)) targets.push({ platform: o.platform, userId: o.id, login: o.login });
  const results: CommandResult[] = [];
  for (const t of targets) {
    if (!hub.status[t.platform].canModerate) { if (t.platform !== platform) results.push({ platform: t.platform, ok: false, message: 'not signed in as a moderator' }); continue; }
    try {
      await connectors[t.platform].moderate({ ...action, userId: t.userId, login: t.login } as ModAction);
      results.push({ platform: t.platform, ok: true, message: t.login });
    } catch (e: any) { results.push({ platform: t.platform, ok: false, message: e.message }); }
  }
  return results;
}

// Blocked words: delete or time out matching messages automatically if you chose that.
hub.on('hub', (ev: HubEvent) => {
  if (ev.op !== 'item' || ev.item.kind !== 'chat' || !ev.item.flags.blocked) return;
  const m = ev.item;
  const f = settings.filters;
  if (f.action === 'none' || !hub.status[m.platform].canModerate) return;
  if (m.flags.self || m.user.broadcaster || (f.exemptMods && m.user.mod)) return;
  const c = connectors[m.platform];
  const job = f.action === 'timeout'
    ? c.moderate({ type: 'timeout', userId: m.user.id, login: m.user.login, seconds: Math.max(1, f.timeoutSeconds || 60), reason: 'Blocked word' })
    : c.moderate({ type: 'delete', messageId: m.id });
  job.then(() => log.info(`${f.action === 'timeout' ? 'timed out' : 'deleted message from'} ${m.user.login} on ${m.platform} (blocked word)`))
    .catch(e => log.warn(`blocked-word ${f.action} failed on ${m.platform}: ${e.message}`));
});
