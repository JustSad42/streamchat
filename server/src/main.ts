// StreamChat server entry point.
//   HOST           address to listen on (default 127.0.0.1; use 0.0.0.0 in Docker)
//   PORT           app + overlay port (default 8787)
//   WEBHOOK_PORT   Kick-webhook-only port (default 8788; 0 = off)
//   STREAMCHAT_DATA  folder for settings.json / secrets.json

import { DATA_DIR, secrets } from './config.ts';
import { emotes } from './emotes.ts';
import { startAll } from './connectors/index.ts';
import { startServer } from './server.ts';
import { logger } from './log.ts';
import { hub } from './hub.ts';
import { recentFromLogs, startLogging } from './chatlog.ts';
import { startUpdateChecks } from './update.ts';

const log = logger('main');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const webhookPort = Number(process.env.WEBHOOK_PORT ?? 8788);

process.on('unhandledRejection', e => log.error('unhandled:', e as Error));
process.on('uncaughtException', e => log.error('uncaught:', e));

log.info(`data folder: ${DATA_DIR}`);
// Bring back the latest chat from the saved log, so a restart doesn't empty the window.
const restored = recentFromLogs(600);
hub.restore(restored);
if (restored.length) log.info(`restored ${restored.length} messages from the chat log`);
startLogging();
startUpdateChecks();
startServer(host, port, webhookPort);
if (!process.env.STREAMCHAT_QUIET_KEY) {
  const shown = host === '0.0.0.0' || host === '::' ? '<this-machine>' : host;
  log.info(`open the chat app: http://${shown}:${port}/app?key=${secrets.accessKey}`);
}

emotes.loadGlobals().catch(e => log.warn('global emotes:', e));
setInterval(() => emotes.loadGlobals().catch(() => {}), 6 * 3600_000);
startAll();

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));

// When started by the desktop app, exit if the app goes away (e.g. it crashed).
const parent = Number(process.env.STREAMCHAT_PARENT_PID || 0);
if (parent) {
  setInterval(() => {
    try { process.kill(parent, 0); } catch { log.info('desktop app closed, stopping'); process.exit(0); }
  }, 3000).unref();
}
