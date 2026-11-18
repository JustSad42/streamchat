// Tests for commands, blocked words, first-time chatters, viewer links and the chat log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STREAMCHAT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'streamchat-test2-'));

const { parseCommand, parseDuration } = await import('../src/commands.ts');
const { hub } = await import('../src/hub.ts');
const { settings } = await import('../src/config.ts');
const { viewers, FIRST_CHATTER_WARMUP_MS } = await import('../src/viewers.ts');
const chatlog = await import('../src/chatlog.ts');

let n = 0;
const msg = (platform: any, login: string, text: string, extra: any = {}) => ({
  kind: 'chat' as const, id: `t${n++}`, platform, ts: Date.now(), text, parts: [{ t: 'text', v: text }], flags: {},
  user: { id: `${login}-id`, login, name: login, badges: [] }, ...extra,
});

test('slash commands and durations are parsed', () => {
  assert.deepEqual(parseCommand('/timeout @Bob 10m spam'), { name: 'timeout', args: ['@Bob', '10m', 'spam'], rest: '@Bob 10m spam', raw: '/timeout @Bob 10m spam' });
  assert.equal(parseCommand('/so friend')!.name, 'shoutout');
  assert.equal(parseCommand('hello /ban'), null);
  assert.equal(parseCommand('//not a command'), null);
  assert.equal(parseDuration('10m'), 600);
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('90'), 90);
  assert.equal(parseDuration('2d'), 172800);
  assert.equal(parseDuration('spam'), null);
  assert.equal(parseDuration('10mx'), null);
});

test('blocked words are flagged as whole words, regexes work', () => {
  settings.filters.terms = [{ pattern: 'badword' }, { pattern: 'buy\\s+followers', regex: true }];
  const a: any = msg('twitch', 'x', 'this is a BadWord here');
  const b: any = msg('twitch', 'y', 'badwordsmith is fine');
  const c: any = msg('kick', 'z', 'Buy   followers now');
  hub.push(a); hub.push(b); hub.push(c);
  assert.equal(a.flags.blocked, true);
  assert.equal(b.flags.blocked, undefined);
  assert.equal(c.flags.blocked, true);
  settings.filters.terms = [];
});

test('first-time chatters on Kick only count after the warm-up period', () => {
  viewers.trackingSince.kick = Date.now() - 60_000; // just started tracking
  const early: any = msg('kick', 'newbie1', 'hi');
  hub.push(early);
  assert.equal(early.flags.firstMsg, undefined);
  viewers.trackingSince.kick = Date.now() - FIRST_CHATTER_WARMUP_MS - 1000;
  const fresh: any = msg('kick', 'newbie2', 'hello');
  hub.push(fresh);
  assert.equal(fresh.flags.firstMsg, true);
  const again: any = msg('kick', 'newbie2', 'me again');
  hub.push(again);
  assert.equal(again.flags.firstMsg, undefined);
});

test('linking accounts shares nickname and note, and tags messages', () => {
  const a = { platform: 'twitch' as const, id: 'bob-tw', login: 'bob', name: 'Bob' };
  const b = { platform: 'kick' as const, id: 'bob-k', login: 'bob_tv', name: 'bob_tv' };
  viewers.update(a, { nick: 'Bobby', note: 'regular' });
  viewers.link(a, b);
  assert.equal(viewers.get('kick', 'bob-k')!.nick, 'Bobby');
  assert.equal(viewers.get('kick', 'bob-k')!.note, 'regular');
  assert.deepEqual(viewers.tag('twitch', 'bob-tw'), { nick: 'Bobby', hasNote: true, linked: ['kick'] });
  assert.equal(viewers.find('bobby').length, 2);
  viewers.unlink(b);
  assert.equal(viewers.get('twitch', 'bob-tw')!.group, undefined);
});

test('chat is saved to the log, searchable, and restored', async () => {
  chatlog.startLogging();
  const m1: any = msg('twitch', 'alice', 'the giveaway starts at nine');
  const m2: any = msg('kick', 'carol', 'nice giveaway');
  const m3: any = msg('tiktok', 'dave', 'unrelated');
  hub.push(m1); hub.push(m2); hub.push(m3);
  hub.markDeleted('kick', m2.id);
  chatlog.flush();
  const r = await chatlog.search({ q: 'giveaway' });
  assert.deepEqual(r.results.map(i => i.id), [m2.id, m1.id]); // newest first
  assert.equal((r.results[0] as any).deleted, true);
  const byUser = await chatlog.search({ user: 'ali' });
  assert.deepEqual(byUser.results.map(i => i.id), [m1.id]);
  const onlyKick = await chatlog.search({ q: 'giveaway', platform: 'kick' });
  assert.equal(onlyKick.results.length, 1);
  const recent = chatlog.recentFromLogs(2);
  assert.deepEqual(recent.map(i => i.id), [m2.id, m3.id]);
  assert.equal((recent[0] as any).deleted, true);
});
