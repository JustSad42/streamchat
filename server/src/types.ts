// Shared message model. Every connector turns its platform's data into these shapes,
// so the desktop app and the OBS overlay only ever deal with one format.

export type Platform = 'twitch' | 'kick' | 'tiktok' | 'youtube';
export const PLATFORMS: Platform[] = ['twitch', 'kick', 'tiktok', 'youtube'];

export interface Badge {
  id: string;          // e.g. "moderator", "subscriber/12"
  title: string;
  url?: string;        // image; when missing the UI draws a built-in icon for `id`
}

export type EmoteSource = 'twitch' | 'kick' | 'tiktok' | 'youtube' | '7tv' | 'ffz' | 'bttv';

export type Part =
  | { t: 'text'; v: string }
  | { t: 'emote'; name: string; url: string; src: EmoteSource; zw?: boolean; w?: number; h?: number; overlays?: Part[] }
  | { t: 'mention'; v: string }
  | { t: 'link'; v: string; href: string };

export interface ChatUser {
  id: string;
  login: string;       // lower-case handle used for mentions and lookups
  name: string;        // display name
  color?: string;
  avatar?: string;
  badges: Badge[];
  mod?: boolean;
  broadcaster?: boolean;
}

export interface Flags {
  mention?: boolean;      // mentions you
  highlight?: string;     // color of the matching highlight rule
  firstMsg?: boolean;      // first message ever in your channel
  blocked?: boolean;      // matched a blocked word
  action?: boolean;       // Twitch /me
  self?: boolean;         // sent by you
}

export interface ChatMessage {
  kind: 'chat';
  id: string;
  platform: Platform;
  ts: number;
  user: ChatUser;
  text: string;
  parts: Part[];
  flags: Flags;
  reply?: { user: string; text: string };
  deleted?: boolean;
  viewer?: ViewerTag;
}

// What the app shows next to a chatter: your nickname for them, whether you left a note,
// and which other platforms you linked them on.
export interface ViewerTag { nick?: string; hasNote?: boolean; linked?: Platform[] }

export type EventType =
  | 'follow' | 'sub' | 'resub' | 'giftsub' | 'raid' | 'bits' | 'announcement'
  | 'gift' | 'like' | 'share' | 'kicks' | 'redeem' | 'ban' | 'timeout' | 'live';

export interface EventMessage {
  kind: 'event';
  id: string;
  platform: Platform;
  ts: number;
  type: EventType;
  user?: ChatUser;
  title: string;        // short headline: "xyz subscribed for 12 months"
  parts?: Part[];       // attached user message, already parsed
  amount?: number;      // bits, gift count, diamonds, kicks, viewers
  image?: string;       // gift image etc.
  alert?: boolean;      // worth an on-stream alert
}

export type Item = ChatMessage | EventMessage;

export type ConnState = 'off' | 'connecting' | 'connected' | 'waiting' | 'error';
export interface PlatformStatus {
  state: ConnState;
  detail?: string;      // human-readable reason
  channel?: string;
  loggedInAs?: string;  // account for sending/moderation
  canSend?: boolean;
  canModerate?: boolean;
  live?: boolean;
  viewers?: number;
  startedAt?: number;   // stream start (ms) while live
  setup?: string;       // machine-readable reason something needs setting up, e.g. 'kick-webhooks'
}

export type ModAction =
  | { type: 'delete'; messageId: string }
  | { type: 'timeout'; userId: string; login: string; seconds: number; reason?: string }
  | { type: 'ban'; userId: string; login: string; reason?: string }
  | { type: 'unban'; userId: string; login: string };
