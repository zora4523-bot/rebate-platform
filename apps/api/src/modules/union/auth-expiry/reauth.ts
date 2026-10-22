import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { Clock, FieldCrypto } from '../../platform/index.ts';
import type { RegisteredPlatform } from '../domain/types.ts';
import type { UnionAuditWriter } from '../pids/service.ts';

export type ReauthMode = 'oauth' | 'manual' | 'none';

export interface SiteOAuthProvider {
  authorizeUrl(input: {
    appId: string;
    unionAccountId: string;
    state: string;
    expiresAt: Date;
  }): Promise<string>;
  exchange(input: { appId: string; unionAccountId: string; code: string }): Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date | null;
  }>;
}

export interface SiteReauthOptions {
  db: Kysely<DB>;
  clock: Clock;
  crypto: FieldCrypto;
  auditWriter: (db: Kysely<DB>) => UnionAuditWriter;
  config: Pick<ContentReader, 'configValue'>;
  modes?: Partial<Readonly<Record<RegisteredPlatform, ReauthMode>>>;
  oauth: Partial<Readonly<Record<RegisteredPlatform, SiteOAuthProvider>>>;
  randomBytes?: (n: number) => Buffer;
}

export type SiteReauthErrorCode =
  'account_not_found' | 'reauth_unsupported' | 'reauth_manual' | 'provider_missing';

export class SiteReauthError extends Error {
  declare code: SiteReauthErrorCode;

  constructor(code: SiteReauthErrorCode) {
    super('NotImplemented: SiteReauthError');
    void code;
    throw new Error('NotImplemented: SiteReauthError');
  }
}

export interface SiteReauth {
  reauthMode(appId: string, platform: RegisteredPlatform): Promise<ReauthMode>;
  start(input: {
    appId: string;
    unionAccountId: string;
    adminId: string;
    reason: string | null;
    ip: string | null;
  }): Promise<{ sessionId: string; authUrl: string; expiresAt: Date }>;
  callback(input: { state: string; code: string | null; error: string | null }): Promise<{
    sessionId: string | null;
    status: 'succeeded' | 'failed' | 'expired' | 'invalid';
  }>;
  result(input: { appId: string; unionAccountId: string; sessionId: string }): Promise<{
    status: 'pending' | 'succeeded' | 'failed' | 'expired';
    error: string | null;
    finishedAt: Date | null;
  } | null>;
  expireStale(): Promise<number>;
}

export function createSiteReauth(options: SiteReauthOptions): SiteReauth {
  void options;
  throw new Error('NotImplemented: createSiteReauth');
}
