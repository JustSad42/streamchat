// Checks GitHub for a newer StreamChat release (every 6 hours) so the app can say so.
// The desktop app installs its own updates; a server installed with install.sh updates itself
// nightly (or with `sudo streamchat update`).

import { logger } from './log.ts';

const log = logger('update');
export const REPO = 'JustSad42/streamchat';

export interface UpdateInfo { latest: string; notes: string; url: string; checkedAt: number }
let info: UpdateInfo | null = null;

export function newer(a: string, b: string) {
  const pa = a.replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

async function check() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'StreamChat-update-check' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return;
    const j: any = await r.json();
    info = { latest: String(j.tag_name || '').replace(/^v/, ''), notes: String(j.body || '').slice(0, 2000), url: j.html_url, checkedAt: Date.now() };
  } catch (e: any) { log.info(`update check failed: ${e.message}`); }
}

export function startUpdateChecks() {
  if (process.env.STREAMCHAT_NO_UPDATE_CHECK) return;
  setTimeout(check, 20_000).unref();
  setInterval(check, 6 * 3600_000).unref();
}

/** What the app shows about updates for this server. */
export function updateState(current: string) {
  const available = !!info?.latest && newer(info.latest, current);
  return {
    current,
    latest: info?.latest || null,
    available,
    notes: available ? info!.notes : '',
    url: info?.url || `https://github.com/${REPO}/releases`,
    // How this server gets updated, so the app can say the right thing.
    via: process.env.STREAMCHAT_PARENT_PID ? 'desktop' : process.env.STREAMCHAT_INSTALL === 'script' ? 'script' : 'manual',
  };
}
