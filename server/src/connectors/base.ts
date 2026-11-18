import type { ModAction, Platform } from '../types.ts';
import type { ParsedCommand } from '../commands.ts';

export interface UserCard {
  platform: Platform;
  id: string;
  login: string;
  name: string;
  avatar?: string;
  createdAt?: string;
  followedAt?: string | null;
  profileUrl: string;
  extra?: Record<string, string>;
}

export interface Connector {
  platform: Platform;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  send(text: string, replyTo?: string): Promise<void>;
  moderate(action: ModAction): Promise<void>;
  userCard(userId: string, login: string): Promise<UserCard>;
  emoteChannelId(): string | undefined;
  /** Run a slash command; returns a short confirmation. Throws Unsupported if this platform can't. */
  command?(c: ParsedCommand): Promise<string>;
}

export class UserError extends Error {}

export function backoff(attempt: number) {
  return Math.min(60000, 1000 * 2 ** Math.min(attempt, 6)) * (0.75 + Math.random() * 0.5);
}
