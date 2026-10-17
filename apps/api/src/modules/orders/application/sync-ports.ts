import type { Clock, JobPayload, JobQueue, RootLogger } from '../../platform/index.ts';
import type { RegisteredPlatform, UnionAdapter } from '../../union/index.ts';

export interface SyncStream {
  readonly app_id: string;
  readonly platform: RegisteredPlatform;
  readonly union_account_id: string;
  readonly query_kind: string;
  readonly scene: string;
}

export interface OrderSyncWindow extends SyncStream, JobPayload {
  readonly query_kind: 'increment';
  readonly scene: '-';
  readonly window_start: string;
  readonly window_end: string;
}

export interface SyncAccount {
  readonly app_id: string;
  readonly platform: RegisteredPlatform;
  readonly union_account_id: string;
  readonly sync_start_at: string | null;
}

export interface SyncCursorStore {
  read(stream: SyncStream): Promise<string | null>;
  /** One transaction: insert if absent, otherwise CAS from window_start to window_end. */
  advance(window: OrderSyncWindow): Promise<boolean>;
}

export interface SyncAccessPort {
  listEnabledAccounts(): Promise<readonly SyncAccount[]>;
  siteAuthAvailable(account: SyncAccount | SyncStream): Promise<boolean>;
  /** Status of the offline governor, never the online governor. */
  offlineCircuitOpen(platform: RegisteredPlatform): Promise<boolean>;
}

export interface SyncSchedulerDeps {
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly cursors: SyncCursorStore;
  readonly access: SyncAccessPort;
  /** Flat fields only (platform, account, window bounds); never order numbers or buyers. */
  readonly logger?: SyncLogger;
}

export type SyncLogger = Pick<RootLogger, 'info' | 'warn' | 'error'>;

export interface SyncRegistry {
  get(platform: RegisteredPlatform): Pick<UnionAdapter, 'listOrders'>;
}
