// Offline tests for the YouTube connector: channel input and chat action parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STREAMCHAT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'streamchat-yt-'));

const { channelPath, initialData, toItem, handleAction, viewership } = await import('../src/connectors/youtube.ts');
const { hub } = await import('../src/hub.ts');

const UC = 'UC' + 'a'.repeat(22);
const usec = () => String(Date.now() * 1000);
const chat = (id: string, extra: object = {}) => ({ liveChatTextMessageRenderer: {
  id, timestampUsec: usec(), authorName: { simpleText: '@Some.Viewer' }, authorExternalChannelId: UC,
  message: { runs: [{ text: 'hi ' }, { emoji: { emojiId: '😏' } }, { emoji: { isCustomEmoji: true, shortcuts: [':wave:'], image: { thumbnails: [{ url: 'https://yt3.ggpht.com/w' }] } } }] },
  ...extra,
} });

test('channel input is reduced to a youtube.com path', () => {
  assert.equal(channelPath('@Name'), '@Name');
  assert.equal(channelPath(' name '), '@name');
  assert.equal(channelPath('https://www.youtube.com/@Name/live?x=1'), '@Name');
  assert.equal(channelPath(`youtube.com/channel/${UC}`), `channel/${UC}`);
  assert.equal(channelPath(UC), `channel/${UC}`);
  assert.equal(channelPath('https://youtube.com/c/Old'), 'c/Old');
  for (const bad of ['', 'two words', 'https://youtube.com/watch?v=abc', 'https://example.com/x']) assert.equal(channelPath(bad), '', bad);
});

test('page data is extracted', () => {
  assert.deepEqual(initialData('<script>var ytInitialData = {"a":"};"};</script>'), { a: '};' });
  assert.throws(() => initialData('<html>consent</html>'));
});

test('chat messages keep text, emoji, badges and the viewer id', () => {
  const m: any = toItem(chat('m1', { authorBadges: [{ liveChatAuthorBadgeRenderer: { icon: { iconType: 'MODERATOR' } } }] }));
  assert.equal(m.platform, 'youtube');
  assert.equal(m.user.id, UC);
  assert.equal(m.user.login, 'some.viewer');
  assert.equal(m.user.mod, true);
  assert.equal(m.text, 'hi 😏:wave:');
  assert.deepEqual(m.parts, [{ t: 'text', v: 'hi 😏' }, { t: 'emote', name: ':wave:', url: 'https://yt3.ggpht.com/w', src: 'youtube' }]);
});

test('Super Chats and memberships become events; old ones raise no alert', () => {
  const base = { timestampUsec: usec(), authorName: { simpleText: '@fan' }, authorExternalChannelId: UC };
  const paid: any = toItem({ liveChatPaidMessageRenderer: { ...base, id: 'p', purchaseAmountText: { simpleText: '$5.00' } } });
  assert.deepEqual([paid.type, paid.title, paid.alert], ['gift', 'fan sent a $5.00 Super Chat', true]);
  const old: any = toItem({ liveChatPaidMessageRenderer: { ...base, id: 'o', timestampUsec: '1000000', purchaseAmountText: { simpleText: '$1' } } });
  assert.equal(old.alert, false);
  const joined: any = toItem({ liveChatMembershipItemRenderer: { ...base, id: 'j', headerSubtext: { runs: [{ text: 'Welcome!' }] } } });
  assert.deepEqual([joined.type, joined.title], ['sub', 'fan became a member']);
  const months: any = toItem({ liveChatMembershipItemRenderer: { ...base, id: 'k', headerPrimaryText: { runs: [{ text: 'Member for ' }, { text: '5' }, { text: ' months' }] } } });
  assert.deepEqual([months.type, months.amount], ['resub', 5]);
  const gifted: any = toItem({ liveChatSponsorshipsGiftPurchaseAnnouncementRenderer: { id: 'g', timestampUsec: usec(), authorExternalChannelId: UC,
    header: { liveChatSponsorshipsHeaderRenderer: { authorName: { simpleText: '@fan' }, primaryText: { runs: [{ text: 'Gifted ' }, { text: '10' }, { text: ' memberships' }] } } } } });
  assert.deepEqual([gifted.type, gifted.amount, gifted.title], ['giftsub', 10, 'fan gifted 10 memberships']);
  assert.equal(toItem({ liveChatViewerEngagementMessageRenderer: { id: 'x' } }), undefined);
});

test('live, waiting and unknown viewer counts are told apart', () => {
  const meta = (text: string, isLive: boolean) => ({ actions: [{ other: {} }, { updateViewershipAction: { viewCount: { videoViewCountRenderer: { viewCount: { simpleText: text }, isLive, originalViewCount: '95' } } } }], description: 'waiting on the deck' });
  assert.deepEqual(viewership(meta('95 watching now', true)), { live: true, viewers: 95 });
  assert.deepEqual(viewership(meta('95 waiting', true)), { live: false, viewers: undefined });
  assert.deepEqual(viewership(meta('95 views', false)), { live: false, viewers: undefined });
  assert.equal(viewership({}), undefined);
});

test('add and delete actions reach the hub', () => {
  handleAction({ addChatItemAction: { item: chat('d1') } });
  handleAction({ addChatItemAction: { item: chat('d2') } });
  handleAction({ removeChatItemAction: { targetItemId: 'd1' } });
  assert.equal((hub.get('youtube', 'd1') as any).deleted, true);
  assert.equal((hub.get('youtube', 'd2') as any).deleted, undefined);
  handleAction({ removeChatItemByAuthorAction: { externalChannelId: UC } });
  assert.equal((hub.get('youtube', 'd2') as any).deleted, true);
});
