import type { ClientPlatform, Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/clock/index.ts';
import type { FieldCrypto } from '../../platform/crypto/index.ts';
import type { RootLogger } from '../../platform/logging/index.ts';
import type { RedisHandle } from '../../platform/redis/index.ts';
import type { TokenService } from './access-tokens.ts';
import type { MinimumVersionReader } from './session-scope.ts';
import type { AfterSessionsRevoked } from './revoke-sessions.ts';

/** Input is assembled after signature and device/app source checks. */
export interface RefreshCommand {
  refresh_token: string;
  verifiedDevice: { deviceId: string; appId: string };
  platform: ClientPlatform;
  channel?: string;
  version?: string;
}

export type RefreshPair = Schema<'TokenPair'>;
export type RefreshResult = { code: 0; data: RefreshPair } | { code: 10404 | 50001 };

export interface RefreshOptions {
  db: Kysely<DB>;
  clock: Clock;
  tokens: TokenService;
  crypto: FieldCrypto;
  redis: RedisHandle;
  versions: MinimumVersionReader;
  logger: RootLogger;
  afterRevoked?: AfterSessionsRevoked;
}

export interface RefreshService {
  refresh(command: RefreshCommand): Promise<RefreshResult>;
}

export function createRefreshService(options: RefreshOptions): RefreshService {
  void options;
  throw new Error('NotImplemented: createRefreshService');
}
