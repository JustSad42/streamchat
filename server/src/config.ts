// Settings (safe to show in the app) and secrets (tokens, keys) stored as JSON in the data folder.
// The data folder is STREAMCHAT_DATA, or ./data next to where the server runs.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from './log.ts';

const log = logger('config');

export const DATA_DIR = path.resolve(process.env.STREAMCHAT_DATA || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export interface HighlightRule { pattern: string; color: string; regex?: boolean; enabled?: boolean }
export interface FilterRule { pattern: string; regex?: boolean }

export interface FilterSettings {
  terms: FilterRule[];
  hideFromOverlay: boolean;  // never show matching messages on stream
  hideInApp: boolean;        // hide them in the chat window too (otherwise shown dimmed)
  action: 'none' | 'delete' | 'timeout';
  timeoutSeconds: number;
  exemptMods: boolean;       // mods, VIP-like staff and you are never acted on
}

export interface OverlayTheme {
  fontFamily: string;
  fontSize: number;          // px
  fontWeight: number;
  textColor: string;
  nameBold: boolean;
  useUserColors: boolean;
  bgMode: 'bubble' | 'none' | 'panel'; // a bubble per message, no background, or one panel behind all chat
  bgColor: string;           // message bubble background
  bgOpacity: number;         // 0..1
  radius: number;
  padding: number;
  gap: number;
  showBadges: boolean;
  showPlatformIcon: boolean;
  showTimestamps: boolean;
  textShadow: boolean;
  outline: boolean;
  emoteScale: number;        // emote height relative to the line (1 = 1.6em)
  maxMessages: number;
  fadeAfter: number;         // seconds; 0 = never
  animation: 'slide' | 'fade' | 'pop' | 'none';
  direction: 'up' | 'down';  // up: newest at the bottom, pushes older up
  showEvents: boolean;
  hideCommands: boolean;     // messages starting with "!"
  hideUsers: string[];       // bots etc. (logins, any platform)
  platforms: Record<'twitch' | 'kick' | 'tiktok' | 'youtube', boolean>;
  customCss: string;
}

export interface AlertSettings {
  enabled: boolean;
  durationSec: number;
  types: Record<'follow' | 'sub' | 'giftsub' | 'raid' | 'bits' | 'gift' | 'kicks' | 'share' | 'like', boolean>;
  minBits: number;
  minDiamonds: number;       // TikTok gift value (coins)
  accent: string;
  fontFamily: string;
  volume: number;            // 0..1 for the built-in chime; 0 = silent
}

export interface Settings {
  twitch: { channel: string; enabled: boolean };
  kick: { channel: string; enabled: boolean; webhookUrl: string };
  tiktok: { username: string; enabled: boolean };
  youtube: { channel: string; enabled: boolean };
  emotes: { sevenTv: boolean; ffz: boolean; bttv: boolean };
  highlights: HighlightRule[];
  highlightMentions: boolean;
  firstChatter: boolean;     // mark people chatting for the first time
  filters: FilterSettings;
  logs: { enabled: boolean; keepDays: number };
  overlay: OverlayTheme;
  alerts: AlertSettings;
  publicUrl: string;         // how your browser reaches this server; used for Kick sign-in
}

export interface Secrets {
  accessKey: string;         // needed by the chat app / control API
  overlayKey: string;        // needed by OBS overlay URLs (read-only)
  twitch: {
    clientId?: string;
    accessToken?: string; refreshToken?: string; expiresAt?: number;
    login?: string; userId?: string; scopes?: string[];
  };
  kick: {
    clientId?: string; clientSecret?: string;
    accessToken?: string; refreshToken?: string; expiresAt?: number;
    userId?: number; username?: string; scopes?: string[];
  };
  tiktok: { eulerKey?: string };
}

export const DEFAULT_THEME: OverlayTheme = {
  fontFamily: 'Inter',
  fontSize: 22,
  fontWeight: 600,
  textColor: '#ffffff',
  nameBold: true,
  useUserColors: true,
  bgMode: 'bubble',
  bgColor: '#0b0d12',
  bgOpacity: 0.55,
  radius: 12,
  padding: 10,
  gap: 8,
  showBadges: true,
  showPlatformIcon: true,
  showTimestamps: false,
  textShadow: true,
  outline: false,
  emoteScale: 1,
  maxMessages: 30,
  fadeAfter: 0,
  animation: 'slide',
  direction: 'up',
  showEvents: true,
  hideCommands: true,
  hideUsers: ['nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'botrixoficial', 'kickbot'],
  platforms: { twitch: true, kick: true, tiktok: true, youtube: true },
  customCss: '',
};

export const DEFAULT_ALERTS: AlertSettings = {
  enabled: true,
  durationSec: 6,
  types: { follow: true, sub: true, giftsub: true, raid: true, bits: true, gift: true, kicks: true, share: false, like: false },
  minBits: 1,
  minDiamonds: 1,
  accent: '#8b5cf6',
  fontFamily: 'Inter',
  volume: 0.5,
};

const DEFAULT_SETTINGS: Settings = {
  twitch: { channel: '', enabled: true },
  kick: { channel: '', enabled: true, webhookUrl: '' },
  tiktok: { username: '', enabled: true },
  youtube: { channel: '', enabled: true },
  emotes: { sevenTv: true, ffz: true, bttv: true },
  highlights: [],
  highlightMentions: true,
  firstChatter: true,
  filters: { terms: [], hideFromOverlay: true, hideInApp: false, action: 'none', timeoutSeconds: 60, exemptMods: true },
  logs: { enabled: true, keepDays: 90 },
  overlay: DEFAULT_THEME,
  alerts: DEFAULT_ALERTS,
  publicUrl: '',
};

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

function readJson<T>(file: string): Partial<T> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
    if (e.code !== 'ENOENT') log.warn(`could not read ${path.basename(file)}: ${e.message}`);
    return {};
  }
}

function writeJson(file: string, data: unknown) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Fill in any fields missing from an older/partial file without losing the user's values.
function merge<T>(defaults: T, value: any): T {
  if (Array.isArray(defaults)) return (Array.isArray(value) ? value : defaults) as T;
  if (defaults && typeof defaults === 'object') {
    const out: any = { ...defaults };
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) {
        out[k] = k in (defaults as any) ? merge((defaults as any)[k], value[k]) : value[k];
      }
    }
    return out;
  }
  return (value === undefined || value === null || typeof value !== typeof defaults ? defaults : value) as T;
}

const key = () => crypto.randomBytes(18).toString('base64url');

export const settings: Settings = merge(DEFAULT_SETTINGS, readJson<Settings>(SETTINGS_FILE));
export const secrets: Secrets = (() => {
  const s = readJson<Secrets>(SECRETS_FILE) as Secrets;
  const out: Secrets = {
    accessKey: process.env.STREAMCHAT_ACCESS_KEY || s.accessKey || key(),
    overlayKey: s.overlayKey || key(),
    twitch: s.twitch || {},
    kick: s.kick || {},
    tiktok: s.tiktok || {},
  };
  // Client IDs can also come from the environment (handy on the server).
  if (process.env.TWITCH_CLIENT_ID) out.twitch.clientId = process.env.TWITCH_CLIENT_ID;
  if (process.env.KICK_CLIENT_ID) out.kick.clientId = process.env.KICK_CLIENT_ID;
  if (process.env.KICK_CLIENT_SECRET) out.kick.clientSecret = process.env.KICK_CLIENT_SECRET;
  if (process.env.EULER_API_KEY) out.tiktok.eulerKey = process.env.EULER_API_KEY;
  return out;
})();

writeJson(SETTINGS_FILE, settings);
writeJson(SECRETS_FILE, secrets);

export function saveSettings() { writeJson(SETTINGS_FILE, settings); }
export function saveSecrets() { writeJson(SECRETS_FILE, secrets); }

// Apply a partial update coming from the app. Unknown keys are ignored, types are checked.
export function updateSettings(patch: any) {
  const next = merge(settings, patch);
  Object.assign(settings, next);
  saveSettings();
}

export function resetTheme() {
  settings.overlay = structuredClone(DEFAULT_THEME);
  saveSettings();
}
