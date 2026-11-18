// Talks to the Tailscale command-line tool on this machine so StreamChat can make (and show) the
// public webhook address Kick needs, instead of you typing commands. Only Funnel ports 443, 8443
// and 10000 are allowed by Tailscale; StreamChat uses 8443, or 10000 if 8443 is taken.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { logger } from './log.ts';

const log = logger('tailscale');
const FUNNEL_PORTS = [8443, 10000];

function cli(): string | null {
  const candidates = process.platform === 'win32'
    ? [`${process.env.ProgramFiles || 'C:\\Program Files'}\\Tailscale\\tailscale.exe`, 'tailscale.exe']
    : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale', '/opt/homebrew/bin/tailscale', 'tailscale'];
  for (const c of candidates) if (!c.includes('\\') && !c.includes('/') ? true : fs.existsSync(c)) return c;
  return null;
}

function run(args: string[], timeout = 8000): Promise<{ ok: boolean; out: string }> {
  const bin = cli();
  if (!bin) return Promise.resolve({ ok: false, out: 'not installed' });
  return new Promise(resolve => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 4_000_000 }, (err: any, stdout, stderr) => {
      if (err?.code === 'ENOENT') return resolve({ ok: false, out: 'not installed' });
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() || String(err?.message || '') });
    });
  });
}

export interface TailscaleInfo {
  installed: boolean;
  running: boolean;          // signed in and connected
  dnsName?: string;          // e.g. my-pc.tail1234.ts.net
  funnelPort?: number;       // public port pointing at our webhook port, if set up
  webhookUrl?: string;
  error?: string;
}

export async function tailscaleInfo(webhookPort: number): Promise<TailscaleInfo> {
  const st = await run(['status', '--json']);
  if (!st.ok && /not installed|ENOENT/i.test(st.out)) return { installed: false, running: false };
  let j: any = null;
  try { j = JSON.parse(st.out.slice(st.out.indexOf('{'))); } catch { /* not JSON */ }
  if (!j) return { installed: !/not installed/.test(st.out), running: false, error: st.out.slice(0, 200) || 'Tailscale is not running' };
  const running = j.BackendState === 'Running';
  const dnsName = String(j.Self?.DNSName || '').replace(/\.$/, '') || undefined;
  const info: TailscaleInfo = { installed: true, running, dnsName };
  if (!running) { info.error = j.BackendState === 'NeedsLogin' ? 'Tailscale needs you to sign in.' : `Tailscale is ${j.BackendState || 'stopped'}.`; return info; }
  const port = await funnelPortFor(webhookPort);
  if (port && dnsName) { info.funnelPort = port; info.webhookUrl = webhookUrlFor(dnsName, port); }
  return info;
}

export const webhookUrlFor = (dns: string, port: number) => `https://${dns}${port === 443 ? '' : `:${port}`}/webhooks/kick`;

/** Which public Funnel port (if any) forwards to our webhook listener. */
async function funnelPortFor(webhookPort: number): Promise<number | null> {
  const fs_ = await run(['funnel', 'status', '--json']);
  let j: any = null;
  try { j = JSON.parse(fs_.out.slice(fs_.out.indexOf('{'))); } catch { return null; }
  const allow = j.AllowFunnel || {};
  for (const [hostPort, handlers] of Object.entries<any>(j.Web || {})) {
    if (!allow[hostPort]) continue;
    for (const h of Object.values<any>(handlers?.Handlers || {})) {
      if (typeof h?.Proxy === 'string' && new RegExp(`(127\\.0\\.0\\.1|localhost):${webhookPort}/?$`).test(h.Proxy)) {
        return Number(hostPort.split(':').pop());
      }
    }
  }
  return null;
}

async function usedPorts(): Promise<Set<number>> {
  const r = await run(['serve', 'status', '--json']);
  const used = new Set<number>();
  try {
    const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
    for (const k of Object.keys(j.TCP || {})) used.add(Number(k));
  } catch { /* nothing served */ }
  return used;
}

/**
 * Turns on Tailscale Funnel for the webhook port. If Funnel isn't allowed on the tailnet yet,
 * Tailscale prints a link where you allow it; that link is returned so the app can open it.
 */
export async function enableFunnel(webhookPort: number): Promise<{ ok: boolean; webhookUrl?: string; enableUrl?: string; message: string }> {
  const before = await tailscaleInfo(webhookPort);
  if (!before.installed) return { ok: false, message: 'Tailscale is not installed on this machine.' };
  if (!before.running) return { ok: false, message: before.error || 'Tailscale is not connected.' };
  if (before.webhookUrl) return { ok: true, webhookUrl: before.webhookUrl, message: 'Already set up.' };
  const used = await usedPorts();
  const port = FUNNEL_PORTS.find(p => !used.has(p));
  if (!port) return { ok: false, message: 'Tailscale Funnel ports 8443 and 10000 are both in use by something else.' };
  const r = await run(['funnel', '--bg', `--https=${port}`, `http://127.0.0.1:${webhookPort}`], 25000);
  const link = /(https:\/\/login\.tailscale\.com\/[^\s]+)/.exec(r.out)?.[1];
  const after = await tailscaleInfo(webhookPort);
  if (after.webhookUrl) {
    log.info(`Funnel on: ${after.webhookUrl}`);
    return { ok: true, webhookUrl: after.webhookUrl, message: 'Webhook address created.' };
  }
  if (link) return { ok: false, enableUrl: link, message: 'Tailscale needs you to allow Funnel once. Open the link, allow it, then click the button again.' };
  if (/access denied|permission|operator/i.test(r.out)) {
    return { ok: false, message: process.platform === 'win32'
      ? 'Tailscale refused. Open a terminal as administrator and run the command shown below once.'
      : 'Tailscale refused. Run the command below with sudo once.' };
  }
  return { ok: false, message: r.out.slice(0, 300) || 'Tailscale did not turn Funnel on.' };
}

/** Checks the webhook address answers, by calling it the way Kick would (through Tailscale). */
export async function pingWebhook(url: string, token: string): Promise<{ ok: boolean; message: string }> {
  const ping = url.replace(/\/webhooks\/kick\/?$/, '') + `/webhooks/kick/ping?t=${encodeURIComponent(token)}`;
  try {
    const r = await fetch(ping, { signal: AbortSignal.timeout(10000) });
    const t = await r.text();
    if (r.ok && t.includes(token)) return { ok: true, message: 'The webhook address reaches StreamChat.' };
    return { ok: false, message: `The address answered, but not from this StreamChat (HTTP ${r.status}).` };
  } catch (e: any) {
    return { ok: false, message: `Couldn't reach the webhook address (${e?.cause?.code || e?.message || 'error'}).` };
  }
}
