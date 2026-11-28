// HTTP + WebSocket server: serves the chat app and OBS overlays, the control API,
// the live event stream, and the Kick webhook endpoint.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { hub, localId, type HubEvent } from './hub.ts';
import { settings, secrets, saveSecrets, updateSettings, resetTheme, DEFAULT_ALERTS } from './config.ts';
import { emotes } from './emotes.ts';
import { recentLog, logger } from './log.ts';
import { connectors, restartChanged, runCommand, moderateEverywhere } from './connectors/index.ts';
import { missingTwitchScopes, startTwitchLogin, twitchDeviceFlow, twitchLogout } from './connectors/twitch.ts';
import { kickCallback, kickLoginUrl, kickLogout } from './connectors/kick.ts';
import { viewers, type ViewerRef } from './viewers.ts';
import { search, logUsage } from './chatlog.ts';
import { COMMANDS } from './commands.ts';
import { tailscaleInfo, enableFunnel, pingWebhook } from './tailscale.ts';
import { updateState } from './update.ts';
import pkg from '../package.json' with { type: 'json' };
import { UserError } from './connectors/base.ts';
import type { EventMessage, Item, Platform } from './types.ts';
import { PLATFORMS } from './types.ts';
import { deliver } from './deliver.ts';

const log = logger('server');
export const VERSION: string = pkg.version;
let webhookPortInUse = 0;
let overlayHidden = false;

const WEB_DIR = path.resolve(process.env.STREAMCHAT_WEB || path.join(import.meta.dirname, '..', '..', 'web'));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webp': 'image/webp',
};

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function cookies(req: http.IncomingMessage) {
  const out: Record<string, string> = {};
  for (const c of (req.headers.cookie || '').split(';')) {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  }
  return out;
}

function appAuthed(req: http.IncomingMessage, url: URL) {
  const k = url.searchParams.get('key') || String(req.headers['x-streamchat-key'] || '') || cookies(req).sc_key || '';
  return !!k && safeEq(k, secrets.accessKey);
}

function overlayAuthed(url: URL) {
  const k = url.searchParams.get('k') || '';
  return !!k && (safeEq(k, secrets.overlayKey) || safeEq(k, secrets.accessKey));
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new UserError('Request too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const b = await readBody(req);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw new UserError('Invalid JSON'); }
}

function serveFile(res: http.ServerResponse, rel: string) {
  const file = path.resolve(WEB_DIR, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

function htmlPage(res: http.ServerResponse, status: number, title: string, body: string) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0f14;color:#e7e9ee;font:15px/1.5 system-ui,sans-serif}
main{max-width:420px;padding:32px;border-radius:16px;background:#151821;border:1px solid #232735;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:#9aa1b2;margin:0}input{width:100%;box-sizing:border-box;margin-top:16px;padding:10px 12px;border-radius:10px;border:1px solid #2b3040;background:#0d0f14;color:inherit;font:inherit}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:10px;background:#7c5cff;color:#fff;font:600 15px system-ui;cursor:pointer}</style>
<main>${body}</main>`);
}

// ---------- public settings view (no secrets) ----------

function publicState() {
  return {
    version: VERSION,
    settings,
    status: hub.status,
    keys: {
      twitchClientId: secrets.twitch.clientId || '',
      kickClientId: secrets.kick.clientId || '',
      kickHasSecret: !!secrets.kick.clientSecret,
      eulerKeySet: !!secrets.tiktok.eulerKey,
    },
    accounts: {
      twitch: secrets.twitch.login || null,
      kick: secrets.kick.username || null,
    },
    overlayKey: secrets.overlayKey,
    twitchLogin: twitchDeviceFlow(),
    twitchMissingScopes: missingTwitchScopes(),
    overlayHidden,
    update: updateState(VERSION),
    commands: COMMANDS,
  };
}

// ---------- Kick setup checklist ----------

async function kickSetup() {
  const ts = await tailscaleInfo(webhookPortInUse);
  if (ts.webhookUrl && !settings.kick.webhookUrl) updateSettings({ kick: { webhookUrl: ts.webhookUrl } });
  const url = settings.kick.webhookUrl || process.env.STREAMCHAT_KICK_WEBHOOK_URL || ts.webhookUrl || '';
  const k = connectors.kick;
  const st = (ok: boolean | null, label: string, detail = '') => ({ ok, label, detail });
  const signedIn = !!secrets.kick.accessToken;
  return {
    webhookUrl: url,
    webhookPort: webhookPortInUse,
    tailscale: ts,
    inDocker: fs.existsSync('/.dockerenv'),
    funnelCommand: `tailscale funnel --bg --https=8443 http://127.0.0.1:${webhookPortInUse || 8788}`,
    steps: [
      st(!!(secrets.kick.clientId && secrets.kick.clientSecret), 'Kick app keys saved'),
      st(signedIn, 'Signed in to Kick', signedIn ? `as ${secrets.kick.username}` : ''),
      st(url ? true : ts.installed ? false : null, 'Public webhook address',
        url || (ts.installed ? (ts.running ? 'Click "Make webhook address".' : ts.error || '') : 'Install Tailscale, or paste an address you already have.')),
      st(k.setup.subscribed ? true : k.setup.error === 'webhooks-off' ? false : null, 'Webhooks turned on in your Kick app',
        k.setup.error === 'webhooks-off' ? 'Kick says webhooks are off for your app.' : k.setup.subscribed ? '' : signedIn ? 'Checking…' : ''),
      st(k.lastEventAt ? true : null, 'Messages arriving', k.lastEventAt ? `last event ${new Date(k.lastEventAt).toLocaleTimeString()}` : 'Send a message in your Kick chat to check.'),
    ],
  };
}

// ---------- alerts test ----------

function testAlert(type: string): EventMessage {
  const user = { id: 'test', login: 'streamchat_test', name: 'TestViewer', badges: [], color: '#8b5cf6' };
  const base = { kind: 'event' as const, id: localId('test'), ts: Date.now(), user, alert: true };
  switch (type) {
    case 'sub': return { ...base, platform: 'twitch', type: 'sub', title: 'TestViewer subscribed', amount: 1 };
    case 'giftsub': return { ...base, platform: 'kick', type: 'giftsub', title: 'TestViewer gifted 5 subs', amount: 5 };
    case 'raid': return { ...base, platform: 'twitch', type: 'raid', title: 'TestViewer is raiding with 42 viewers', amount: 42 };
    case 'bits': return { ...base, platform: 'twitch', type: 'bits', title: 'TestViewer cheered 500 bits', amount: 500, parts: [{ t: 'text', v: 'Great stream!' }] };
    case 'gift': return { ...base, platform: 'tiktok', type: 'gift', title: 'TestViewer sent 10× Rose', amount: 10, image: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.webp' };
    case 'kicks': return { ...base, platform: 'kick', type: 'kicks', title: 'TestViewer sent 100 Kicks', amount: 100 };
    default: return { ...base, platform: 'tiktok', type: 'follow', title: 'TestViewer followed' };
  }
}

// ---------- request handling ----------

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', 'http://x');
  const p = url.pathname;
  const method = req.method || 'GET';

  if (p === '/webhooks/kick' && method === 'POST') {
    const body = await readBody(req, 256_000);
    const status = await connectors.kick.webhook(req.headers, body);
    res.writeHead(status).end();
    return;
  }

  if (p === '/auth/kick/callback') {
    const err = url.searchParams.get('error');
    if (err) return htmlPage(res, 400, 'Kick sign-in', `<h1>Kick sign-in cancelled</h1><p>${escapeHtml(url.searchParams.get('error_description') || err)}</p>`);
    try {
      await kickCallback(url.searchParams.get('code') || '', url.searchParams.get('state') || '');
      connectors.kick.restart().catch(() => {});
      broadcastApp({ op: 'settings' });
      return htmlPage(res, 200, 'Kick sign-in', `<h1>Signed in to Kick</h1><p>You can close this tab and go back to StreamChat.</p><script>setTimeout(()=>window.close(),1500)</script>`);
    } catch (e: any) {
      return htmlPage(res, 400, 'Kick sign-in', `<h1>Kick sign-in failed</h1><p>${escapeHtml(e.message)}</p>`);
    }
  }

  if (p === '/webhooks/kick/ping') return pingReply(res, url);
  if (p === '/' ) { res.writeHead(302, { Location: '/app' }).end(); return; }
  if (p === '/health') return json(res, 200, { ok: true, version: VERSION });

  // Overlays: the page itself is public; the WebSocket checks the overlay key.
  if (p === '/overlay/chat' || p === '/overlay/chat/') return serveFile(res, 'overlay/chat.html');
  if (p === '/overlay/alerts' || p === '/overlay/alerts/') return serveFile(res, 'overlay/alerts.html');
  if (p.startsWith('/overlay/') || p.startsWith('/shared/')) return serveFile(res, p.slice(1));

  // The chat app.
  if (p === '/app' || p === '/app/') {
    if (url.searchParams.get('key')) {
      if (!appAuthed(req, url)) return htmlPage(res, 401, 'StreamChat', loginForm('That access key is wrong.'));
      res.writeHead(302, {
        'Set-Cookie': `sc_key=${encodeURIComponent(secrets.accessKey)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
        Location: '/app',
      }).end();
      return;
    }
    if (!appAuthed(req, url)) return htmlPage(res, 401, 'StreamChat', loginForm());
    return serveFile(res, 'app/index.html');
  }
  if (p.startsWith('/app/')) return serveFile(res, p.slice(1));

  if (!p.startsWith('/api/')) { res.writeHead(404).end('Not found'); return; }

  // Overlay config can be read with the overlay key.
  if (p === '/api/overlay' && method === 'GET') {
    if (!overlayAuthed(url)) return json(res, 401, { error: 'Bad overlay key' });
    return json(res, 200, { theme: settings.overlay, alerts: settings.alerts });
  }

  if (!appAuthed(req, url)) return json(res, 401, { error: 'Not signed in' });
  if (method !== 'GET' && req.headers['content-type']?.includes('application/json') !== true && method !== 'DELETE') {
    // Require JSON for writes so a plain cross-site form can't trigger them.
    return json(res, 415, { error: 'Send JSON' });
  }

  switch (`${method} ${p}`) {
    case 'GET /api/state': return json(res, 200, publicState());

    case 'GET /api/search': {
      const g = (k: string) => url.searchParams.get(k) || '';
      const r = await search({
        q: g('q'), user: g('user'), userId: g('userId') || undefined, platform: (PLATFORMS.includes(g('platform') as Platform) ? g('platform') : '') as Platform | '',
        kind: (['chat', 'events', 'all'].includes(g('kind')) ? g('kind') : 'chat') as any,
        days: Number(g('days')) || 0, before: Number(g('before')) || undefined, limit: Number(g('limit')) || 200,
      });
      return json(res, 200, r);
    }
    case 'GET /api/logs/usage': return json(res, 200, { ...logUsage(), viewers: viewers.stats() });

    case 'GET /api/viewers/find': {
      const ex = url.searchParams.get('exclude') as Platform | null;
      return json(res, 200, { viewers: viewers.find(url.searchParams.get('q') || '', 20, ex && PLATFORMS.includes(ex) ? ex : undefined) });
    }
    case 'POST /api/viewer': {
      const b = await readJson(req);
      const ref = viewerRef(b);
      viewers.update(ref, { nick: b.nick, note: b.note });
      hub.viewerChanged(ref.platform, ref.id);
      return json(res, 200, viewerView(ref));
    }
    case 'POST /api/viewer/link': {
      const b = await readJson(req);
      const a = viewerRef(b.a), c = viewerRef(b.b);
      if (a.platform === c.platform && a.id === c.id) return json(res, 400, { error: "That's the same account." });
      viewers.link(a, c);
      hub.viewerChanged(a.platform, a.id);
      return json(res, 200, viewerView(a));
    }
    case 'POST /api/viewer/unlink': {
      const b = await readJson(req);
      const r = viewerRef(b);
      const before = viewers.get(r.platform, r.id);
      const others = before ? viewers.linked(before) : [];
      viewers.unlink(r);
      hub.viewerChanged(r.platform, r.id);
      for (const o of others) hub.viewerChanged(o.platform, o.id);
      return json(res, 200, { ok: true });
    }

    case 'POST /api/command': {
      const b = await readJson(req);
      const target = b.platform === 'all' ? 'all' : PLATFORMS.includes(b.platform) ? b.platform as Platform : null;
      if (!target) return json(res, 400, { error: 'Unknown platform' });
      return json(res, 200, await runCommand(target, String(b.text || '')));
    }
    case 'POST /api/mod/all': {
      const b = await readJson(req);
      if (!PLATFORMS.includes(b.platform) || !['ban', 'timeout', 'unban'].includes(b.action?.type)) return json(res, 400, { error: 'Bad request' });
      return json(res, 200, { results: await moderateEverywhere(b.platform, b.action) });
    }

    case 'GET /api/kick/setup': return json(res, 200, await kickSetup());
    case 'POST /api/kick/funnel': {
      const r = await enableFunnel(webhookPortInUse || 8788);
      if (r.webhookUrl) updateSettings({ kick: { webhookUrl: r.webhookUrl } });
      return json(res, 200, { ...r, setup: await kickSetup() });
    }
    case 'POST /api/kick/test': {
      const u = settings.kick.webhookUrl || process.env.STREAMCHAT_KICK_WEBHOOK_URL;
      if (!u) return json(res, 400, { error: 'No webhook address yet.' });
      return json(res, 200, await pingWebhook(u, pingToken));
    }

    case 'POST /api/overlay/visibility': {
      const b = await readJson(req);
      overlayHidden = !!b.hidden;
      broadcastOverlay({ op: 'visibility', hidden: overlayHidden });
      broadcastApp({ op: 'overlayHidden', hidden: overlayHidden });
      return json(res, 200, { hidden: overlayHidden });
    }
    case 'POST /api/overlay/clear': {
      broadcastOverlay({ op: 'clear' });
      return json(res, 200, { ok: true });
    }
    case 'GET /api/log': return json(res, 200, { lines: recentLog() });

    case 'POST /api/settings': {
      const patch = await readJson(req);
      const before = structuredClone(settings);
      updateSettings(patch);
      await restartChanged(before);
      broadcastApp({ op: 'settings' });
      broadcastOverlay({ op: 'theme', theme: settings.overlay, alerts: settings.alerts });
      return json(res, 200, publicState());
    }
    case 'POST /api/theme/reset': {
      resetTheme();
      broadcastOverlay({ op: 'theme', theme: settings.overlay, alerts: settings.alerts });
      return json(res, 200, publicState());
    }
    case 'POST /api/alerts/reset': {
      settings.alerts = structuredClone(DEFAULT_ALERTS);
      updateSettings({});
      broadcastOverlay({ op: 'theme', theme: settings.overlay, alerts: settings.alerts });
      return json(res, 200, publicState());
    }
    case 'POST /api/keys': {
      const b = await readJson(req);
      const changed = new Set<Platform>();
      if (typeof b.twitchClientId === 'string' && b.twitchClientId.trim() !== (secrets.twitch.clientId || '')) {
        secrets.twitch = { clientId: b.twitchClientId.trim() }; changed.add('twitch');
      }
      if (typeof b.kickClientId === 'string' && b.kickClientId.trim() !== (secrets.kick.clientId || '')) {
        secrets.kick = { clientId: b.kickClientId.trim(), clientSecret: secrets.kick.clientSecret }; changed.add('kick');
      }
      if (typeof b.kickClientSecret === 'string' && b.kickClientSecret.trim()) {
        secrets.kick.clientSecret = b.kickClientSecret.trim(); changed.add('kick');
      }
      if (typeof b.eulerKey === 'string') { secrets.tiktok.eulerKey = b.eulerKey.trim() || undefined; changed.add('tiktok'); }
      saveSecrets();
      for (const pl of changed) connectors[pl].restart().catch(() => {});
      return json(res, 200, publicState());
    }
    case 'POST /api/overlay/new-key': {
      secrets.overlayKey = crypto.randomBytes(18).toString('base64url');
      saveSecrets();
      for (const c of overlayClients) c.close(4001, 'Overlay key changed');
      return json(res, 200, publicState());
    }

    case 'POST /api/auth/twitch/start': {
      await startTwitchLogin(() => { connectors.twitch.restart().catch(() => {}); broadcastApp({ op: 'settings' }); });
      return json(res, 200, { flow: twitchDeviceFlow() });
    }
    case 'GET /api/auth/twitch/status': return json(res, 200, { flow: twitchDeviceFlow(), account: secrets.twitch.login || null });
    case 'POST /api/auth/twitch/logout': {
      twitchLogout();
      await connectors.twitch.restart();
      return json(res, 200, publicState());
    }
    case 'POST /api/auth/kick/start': {
      const b = await readJson(req);
      return json(res, 200, kickLoginUrl(String(b.origin || `http://${req.headers.host}`)));
    }
    case 'POST /api/auth/kick/logout': {
      kickLogout();
      await connectors.kick.restart();
      return json(res, 200, publicState());
    }
    case 'POST /api/reconnect': {
      const b = await readJson(req);
      const list: Platform[] = PLATFORMS.includes(b.platform) ? [b.platform] : PLATFORMS;
      await Promise.all(list.map(pl => connectors[pl].restart()));
      return json(res, 200, { ok: true });
    }

    case 'POST /api/send': {
      const b = await readJson(req);
      const text = String(b.text || '').trim();
      if (!text) return json(res, 400, { error: 'Empty message' });
      const targets: Platform[] = b.platform === 'all'
        ? PLATFORMS.filter(pl => hub.status[pl].canSend)
        : [b.platform as Platform];
      if (!targets.length) return json(res, 400, { error: 'No platform you can send to. Sign in to Twitch or Kick in Settings.' });
      const results = await Promise.allSettled(targets.map(pl => connectors[pl].send(text, b.platform === 'all' ? undefined : b.replyTo)));
      const errors = results.map((r, i) => r.status === 'rejected' ? `${targets[i]}: ${(r.reason as Error).message}` : null).filter(Boolean);
      if (errors.length === targets.length) return json(res, 400, { error: errors.join('; ') });
      return json(res, 200, { ok: true, errors });
    }
    case 'POST /api/mod': {
      const b = await readJson(req);
      if (!PLATFORMS.includes(b.platform)) return json(res, 400, { error: 'Unknown platform' });
      await connectors[b.platform as Platform].moderate(b.action);
      return json(res, 200, { ok: true });
    }
    case 'GET /api/user': {
      const pl = url.searchParams.get('platform') as Platform;
      if (!PLATFORMS.includes(pl)) return json(res, 400, { error: 'Unknown platform' });
      const id = url.searchParams.get('id') || '';
      const login = url.searchParams.get('login') || '';
      const card = await connectors[pl].userCard(id, login).catch(() => ({ platform: pl, id, login, name: login, profileUrl: '' }));
      return json(res, 200, { card, history: hub.userHistory(pl, id), viewer: viewerView({ platform: pl, id, login, name: card.name || login }) });
    }
    case 'GET /api/emotes': {
      const pl = url.searchParams.get('platform') as Platform;
      if (!PLATFORMS.includes(pl)) return json(res, 400, { error: 'Unknown platform' });
      const list: { name: string; url: string; src: string }[] = emotes.list(pl, connectors[pl].emoteChannelId()).map(e => ({ name: e.name, url: e.url, src: e.src }));
      if (pl === 'twitch') list.unshift(...connectors.twitch.nativeEmoteList());
      return json(res, 200, { emotes: list });
    }
    case 'POST /api/alerts/test': {
      const b = await readJson(req);
      const item = testAlert(String(b.type || 'follow'));
      broadcastOverlay({ op: 'alertTest', item });
      return json(res, 200, { ok: true });
    }
  }
  return json(res, 404, { error: 'Unknown endpoint' });
}

const pingToken = crypto.randomBytes(12).toString('hex');
function pingReply(res: http.ServerResponse, url: URL) {
  // Lets the app check the public webhook address really reaches this StreamChat.
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  res.end(url.searchParams.get('t') === pingToken ? `streamchat ${pingToken}` : 'streamchat');
}

function viewerRef(b: any): ViewerRef {
  if (!b || !PLATFORMS.includes(b.platform) || !b.id) throw new UserError('Missing viewer');
  return { platform: b.platform, id: String(b.id), login: String(b.login || b.id).toLowerCase(), name: String(b.name || b.login || b.id) };
}

function viewerView(r: ViewerRef) {
  const v = viewers.get(r.platform, r.id);
  return {
    nick: v?.nick || '', note: v?.note || '', firstSeen: v?.firstSeen || 0, lastSeen: v?.lastSeen || 0, messages: v?.messages || 0,
    linked: v ? viewers.linked(v).map(o => ({ platform: o.platform, id: o.id, login: o.login, name: o.name, lastSeen: o.lastSeen, messages: o.messages })) : [],
  };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
}

function loginForm(error = '') {
  return `<h1>StreamChat</h1><p>${error ? escapeHtml(error) : 'Enter the access key shown when the server started (or in data/secrets.json).'}</p>
<form method="get" action="/app"><input name="key" type="password" placeholder="Access key" autofocus required><button>Open chat</button></form>`;
}

// ---------- WebSocket fan-out ----------

const appClients = new Set<WebSocket>();
const overlayClients = new Set<WebSocket>();

function send(ws: WebSocket, msg: unknown) {
  deliver(ws, JSON.stringify(msg));
}
function broadcastApp(msg: unknown) { const s = JSON.stringify(msg); for (const c of appClients) deliver(c, s); }
function broadcastOverlay(msg: unknown) { const s = JSON.stringify(msg); for (const c of overlayClients) deliver(c, s); }

hub.on('hub', (ev: HubEvent) => {
  broadcastApp(ev);
  if (ev.op === 'status' || ev.op === 'viewer') return;
  // Blocked-word messages never reach the stream.
  if (ev.op === 'item' && ev.item.kind === 'chat' && ev.item.flags.blocked && settings.filters.hideFromOverlay) return;
  broadcastOverlay(ev);
});
hub.on('notice', (n: { platform: Platform; text: string }) => broadcastApp({ op: 'notice', ...n }));
emotes.on('changed', () => broadcastApp({ op: 'emotesChanged' }));

function recent(n: number, filter?: (i: Item) => boolean) {
  const out: Item[] = [];
  for (let i = hub.items.length - 1; i >= 0 && out.length < n; i--) {
    if (!filter || filter(hub.items[i])) out.push(hub.items[i]);
  }
  return out.reverse();
}

// ---------- start ----------

export function startServer(host: string, port: number, webhookPort: number) {
  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    handle(req, res).catch(e => {
      if (!(e instanceof UserError)) log.error(`${req.method} ${req.url?.split('?')[0]}:`, e);
      if (!res.headersSent) json(res, e instanceof UserError ? 400 : 500, { error: e.message || 'Server error' });
      else res.end();
    });
  };
  const server = http.createServer(onRequest);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const role = url.searchParams.get('role') === 'overlay' ? 'overlay' : 'app';
    const ok = role === 'overlay' ? overlayAuthed(url) : appAuthed(req, url);
    if (!ok) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const set = role === 'overlay' ? overlayClients : appClients;
      set.add(ws);
      ws.on('close', () => set.delete(ws));
      ws.on('error', () => {});
      ws.on('message', raw => { if (String(raw) === 'ping') ws.send('pong'); });
      if (role === 'overlay') {
        send(ws, { op: 'hello', theme: settings.overlay, alerts: settings.alerts, hidden: overlayHidden, history: recent(settings.overlay.maxMessages * 2, i => i.kind === 'chat' && !i.deleted && !(i.flags.blocked && settings.filters.hideFromOverlay)) });
      } else {
        send(ws, { op: 'hello', status: hub.status, overlayHidden, history: recent(600) });
      }
    });
  });

  const onListenError = (p: number) => (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') log.error(`Port ${p} is already in use by another program. Close it or pick another port.`);
    else log.error(`can't listen on ${host}:${p}:`, e);
    process.exit(2);
  };
  server.on('error', onListenError(port));
  server.listen(port, host, () => log.info(`listening on http://${host}:${port}`));

  // Separate listener that only accepts Kick webhooks, so it can be exposed to the internet
  // (e.g. with Tailscale Funnel) without exposing the app.
  webhookPortInUse = webhookPort;
  if (webhookPort) {
    const hook = http.createServer((req, res) => {
      const p = (req.url || '').split('?')[0];
      if (p === '/webhooks/kick' && req.method === 'POST') return onRequest(req, res);
      if (p === '/webhooks/kick/ping') return pingReply(res, new URL(req.url || '/', 'http://x'));
      if (p === '/health') return json(res, 200, { ok: true });
      res.writeHead(404).end();
    });
    hook.on('error', (e: NodeJS.ErrnoException) => log.warn(`Kick webhook port ${webhookPort} unavailable (${e.code}); Kick events won't arrive on it`));
    hook.listen(webhookPort, host, () => log.info(`Kick webhooks on http://${host}:${webhookPort}/webhooks/kick`));
  }
  return server;
}
