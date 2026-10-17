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
  /**
   * The union_account_id whose credentials this deployment's adapter for `platform` actually
   * queries (registry.get(platform) holds one credential set per platform); null when the
   * platform has no queryable account. When provided, the scheduler dispatches windows only for
   * that account and the handler refuses windows of any other account, so account B's cursor is
   * never advanced by a fetch of account A's orders (D10-36).
   * Optional only for test fakes: the production wiring (B1-08n) MUST provide it.
   */
  queryableAccount?(platform: RegisteredPlatform): Promise<string | null>;
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
