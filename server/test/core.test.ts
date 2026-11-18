// Offline tests for message parsing, emotes, highlights and Kick webhook verification.
//   node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.STREAMCHAT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'streamchat-test-'));

const { emotes, toParts } = await import('../src/emotes.ts');
const { parseIrc } = await import('../src/connectors/twitch.ts');
const { KickConnector, setKickPublicKeyForTest } = await import('../src/connectors/kick.ts');
const { hub } = await import('../src/hub.ts');
const { settings } = await import('../src/config.ts');

emotes.injectChannel('twitch', '1', [
  { name: 'Clueless', url: 'https://cdn.7tv.app/emote/a/2x.webp', src: '7tv' },
  { name: 'RainTime', url: 'https://cdn.7tv.app/emote/b/2x.webp', src: '7tv', zw: true },
  { name: 'LULE', url: 'https://cdn.betterttv.net/emote/c/2x.webp', src: 'bttv' },
  { name: 'monkaW', url: 'https://cdn.frankerfacez.com/emote/d/2', src: 'ffz' },
]);
emotes.injectChannel('kick', '7', [{ name: 'catJAM', url: 'https://cdn.7tv.app/emote/e/2x.webp', src: '7tv' }]);

test('third-party emotes from 7TV, BTTV and FFZ are recognised', () => {
  const parts = toParts('twitch', '1', 'hi Clueless and LULE monkaW');
  const names = parts.filter(p => p.t === 'emote').map(p => (p as any).name);
  assert.deepEqual(names, ['Clueless', 'LULE', 'monkaW']);
  assert.equal(parts[0].t, 'text');
});

test('zero-width emotes stack on the emote before them', () => {
  const parts = toParts('twitch', '1', 'Clueless RainTime wow');
  assert.equal(parts.length, 2);
  const e = parts[0] as any;
  assert.equal(e.name, 'Clueless');
  assert.equal(e.overlays[0].name, 'RainTime');
  assert.deepEqual(parts[1], { t: 'text', v: ' wow' });
});

test('a zero-width emote with nothing before it stays on its own', () => {
  const parts = toParts('twitch', '1', 'RainTime');
  assert.equal((parts[0] as any).name, 'RainTime');
  assert.equal((parts[0] as any).overlays, undefined);
});

test('emote providers can be turned off', () => {
  settings.emotes.bttv = false;
  const parts = toParts('twitch', '1', 'LULE');
  assert.deepEqual(parts, [{ t: 'text', v: 'LULE' }]);
  settings.emotes.bttv = true;
});

test('FFZ and BTTV are not used on Kick, 7TV is', () => {
  const parts = toParts('kick', '7', 'catJAM LULE');
  assert.equal((parts[0] as any).name, 'catJAM');
  assert.deepEqual(parts.slice(1), [{ t: 'text', v: ' LULE' }]);
});

test('native emote positions are code points (emoji before an emote)', () => {
  const text = '😀 Kappa hi';
  const parts = toParts('twitch', '1', text, [{ start: 2, end: 6, name: 'Kappa', url: 'u', src: 'twitch' }]);
  assert.deepEqual(parts[0], { t: 'text', v: '😀 ' });
  assert.equal((parts[1] as any).name, 'Kappa');
  assert.deepEqual(parts[2], { t: 'text', v: ' hi' });
});

test('mentions and links become their own parts', () => {
  const parts = toParts('twitch', '1', '@someone check twitch.tv/foo');
  assert.deepEqual(parts[0], { t: 'mention', v: '@someone' });
  assert.equal(parts.at(-1)!.t, 'link');
  assert.equal((parts.at(-1) as any).href, 'https://twitch.tv/foo');
});

test('Twitch IRC lines with tags are parsed', () => {
  const m = parseIrc('@badge-info=subscriber/14;badges=moderator/1,subscriber/12;color=#FF0000;display-name=Some\\sUser;emotes=25:0-4;id=abc;user-id=42 :someuser!someuser@someuser.tmi.twitch.tv PRIVMSG #chan :Kappa hello there');
  assert.equal(m.command, 'PRIVMSG');
  assert.equal(m.tags['display-name'], 'Some User');
  assert.equal(m.tags.emotes, '25:0-4');
  assert.deepEqual(m.params, ['#chan', 'Kappa hello there']);
  assert.equal(m.prefix.split('!')[0], 'someuser');
});

test('mentions of your name and highlight words are flagged', () => {
  hub.selfNames.twitch = ['streamer'];
  settings.highlights = [{ pattern: 'giveaway', color: '#00ff00' }];
  const base = { kind: 'chat' as const, platform: 'twitch' as const, ts: 0, user: { id: 'u', login: 'viewer', name: 'viewer', badges: [] }, parts: [], flags: {} };
  const a: any = { ...base, id: 'm1', text: 'hey @Streamer nice', flags: {} };
  const b: any = { ...base, id: 'm2', text: 'is the GIVEAWAY still on', flags: {} };
  const c: any = { ...base, id: 'm3', text: 'streamers are cool', flags: {} };
  hub.push(a); hub.push(b); hub.push(c);
  assert.equal(a.flags.mention, true);
  assert.equal(b.flags.highlight, '#00ff00');
  assert.equal(c.flags.mention, undefined);
});

test('Kick webhooks: signature checked, chat parsed with emotes', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  setKickPublicKeyForTest(publicKey);
  const kick = new KickConnector();
  (kick as any).stopped = false;
  (kick as any).broadcasterId = 7;
  const body = Buffer.from(JSON.stringify({
    message_id: 'kick-msg-1',
    sender: { user_id: 5, username: 'Viewer', channel_slug: 'viewer', identity: { username_color: '#123456', badges: [{ type: 'moderator', text: 'Moderator' }] } },
    content: 'gg [emote:37226:KEKW] catJAM',
    created_at: '2026-01-01T00:00:00Z',
  }));
  const id = 'evt-1', ts = '2026-01-01T00:00:00Z';
  const sig = crypto.sign('sha256', Buffer.concat([Buffer.from(`${id}.${ts}.`), body]), privateKey).toString('base64');
  const headers = { 'kick-event-message-id': id, 'kick-event-message-timestamp': ts, 'kick-event-signature': sig, 'kick-event-type': 'chat.message.sent' };

  let got: any = null;
  const listener = (ev: any) => { if (ev.op === 'item' && ev.item.id === 'kick-msg-1') got = ev.item; };
  hub.on('hub', listener);
  assert.equal(await kick.webhook(headers, body), 200);
  hub.off('hub', listener);
  assert.ok(got, 'message reached the hub');
  assert.equal(got.text, 'gg KEKW catJAM');
  const em = got.parts.filter((p: any) => p.t === 'emote');
  assert.equal(em[0].url, 'https://files.kick.com/emotes/37226/fullsize');
  assert.equal(em[1].name, 'catJAM');
  assert.equal(got.user.mod, true);

  const forged = { ...headers, 'kick-event-message-id': 'evt-2' }; // signature no longer matches
  assert.equal(await kick.webhook(forged, body), 401);
});
