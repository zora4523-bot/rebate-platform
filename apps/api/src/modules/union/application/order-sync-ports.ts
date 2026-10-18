import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { RootLogger } from '../../platform/index.ts';
import type { RegisteredPlatform, UnionAdapter, UnionEndpoint } from '../domain/types.ts';
import type { GovernedAdapterOptions } from './governed-adapter.ts';

export interface UnionSyncAccount {
  readonly app_id: string;
  readonly platform: RegisteredPlatform;
  readonly union_account_id: string;
  readonly sync_start_at: string | null;
}

export interface UnionSyncAccess {
  listEnabledAccounts(): Promise<readonly UnionSyncAccount[]>;
  siteAuthAvailable(
    account: Pick<UnionSyncAccount, 'app_id' | 'platform' | 'union_account_id'>,
  ): Promise<boolean>;
  offlineCircuitOpen(platform: RegisteredPlatform): Promise<boolean>;
  queryableAccount(platform: RegisteredPlatform): Promise<string | null>;
}

export interface UnionSyncAccessOptions {
  readonly db: Kysely<DB>;
  readonly endpoints: readonly UnionEndpoint[];
  readonly breaker: (platform: RegisteredPlatform) => 'closed' | 'open';
  readonly logger: Pick<RootLogger, 'error'>;
}

export function createUnionSyncAccess(options: UnionSyncAccessOptions): UnionSyncAccess {
  void options;
  throw new Error('NotImplemented: createUnionSyncAccess');
}

export interface UnionOrderReaders {
  readonly pids: {
    find(input: {
      appId: string;
      platform: RegisteredPlatform;
      unionAccountId: string;
      pid: string;
    }): Promise<readonly { pid_scene: string; status: string; site_id: string | null }[]>;
  };
  readonly accounts: {
    syncStartAt(input: { appId: string; unionAccountId: string }): Promise<Date | null>;
  };
}

export function createUnionOrderReaders(db: Kysely<DB>): UnionOrderReaders {
  void db;
  throw new Error('NotImplemented: createUnionOrderReaders');
}

export function createGovernedSyncAdapter(
  adapter: UnionAdapter,
  options: GovernedAdapterOptions,
): {
  readonly adapter: UnionAdapter;
  offlineBreakerState(): 'closed' | 'open';
} {
  void adapter;
  void options;
  throw new Error('NotImplemented: createGovernedSyncAdapter');
}
