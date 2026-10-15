import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface AiConsentSubject {
  appId: string;
  userId: string | null;
  deviceId: string;
}

export type AiConsentVerdict =
  | { allowed: true; version: number }
  | { allowed: false; reason: 'missing' | 'withdrawn' | 'outdated' };

export interface AiConsentReader {
  check(subject: AiConsentSubject): Promise<AiConsentVerdict>;
}

export interface AiConsentReaderOptions {
  db: Kysely<DB>;
  currentVersion: (appId: string) => Promise<number>;
}

export function createAiConsentReader(options: AiConsentReaderOptions): AiConsentReader {
  void options;
  throw new Error('NotImplemented: createAiConsentReader');
}
