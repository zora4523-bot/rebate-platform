// B1-04zza: Taobao-first refund (维权) and punishment (违规) sync on the order-sync queue (规划/02 §7.1;
// 08 BR-FUND-01 / 02 / 06 / 08; orchestrator D10-645, D10-676). Rule tests:
// test/spec/orders/taobao-rights-sync/**. Skeleton only (test stage): every function throws
// NotImplemented until the implementation task fills it in.
// - Which platforms: those whose (governed) adapter has listRefunds (rights) / listPunishments
//   (punish); registry.get throwing (no endpoint) counts as none. orders never compares platform
//   names. A platform without a source dispatches nothing and arms no timer.
// - Gates as the increment scheduler: queryableAccount (D10-36), the offline breaker, site auth.
// - rights increment stream (platform, account, 'rights', '-'): every 30 minutes one window from the
//   cursor (no cursor: the account's sync_start_at; none → nothing), at most 3 hours, ending no
//   later than now; job 'rights.window', singletonKey platform:account:kind:scene:window_start.
// - rights rescan stream (platform, account, 'rights', 'rescan'): a 60-day pass a day in 3-hour
//   windows (one window per 180-second tick), its own cursor; the increment cursor is never moved.
// - punish (platform, account, 'punish', '-'): every 30 minutes one 'punish.window' over
//   [now − 30 days, now); no cursor is read or moved (order_rights_dedupe_key dedupes).
// - The writer: one transaction per record: find the sub-order of (app, platform) → lockOrderKey →
//   re-read FOR UPDATE → settlement's rights.record (source API, now = the injected Clock). An
//   order we do not hold (another publisher's slot) is not_found: nothing written, nothing thrown.
import type { OrderRightsStatus } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, JobPayload, JobQueue } from '../../platform/index.ts';
import type { RegisteredPlatform, UnionAdapter } from '../../union/index.ts';
import type { RightsCommandPort } from './rights-ports.ts';
import type { SyncAccessPort, SyncLogger, SyncStream } from './sync-ports.ts';
import type { OrderSyncScheduler } from './sync-scheduler.ts';

/** Job names on the order-sync queue. */
export type RightsSyncJobName = 'rights.window' | 'punish.window';

/** A refund stream: '-' the 30-minute increment, 'rescan' the daily 60-day pass. */
export interface RightsStream extends SyncStream {
  readonly query_kind: 'rights';
  readonly scene: '-' | 'rescan';
}

export interface RightsSyncWindow extends RightsStream, JobPayload {
  readonly window_start: string;
  readonly window_end: string;
}

/** A punishment window: [now − 30 days, now) at dispatch; never a cursor. */
export interface PunishSyncWindow extends SyncStream, JobPayload {
  readonly query_kind: 'punish';
  readonly scene: '-';
  readonly window_start: string;
  readonly window_end: string;
}

/** sync_cursors over the rights streams (infra/sync-cursors.ts semantics). */
export interface RightsCursorStore {
  read(stream: SyncStream): Promise<string | null>;
  /** One transaction: insert if absent, otherwise CAS from window_start to window_end. */
  advance(window: RightsSyncWindow): Promise<boolean>;
  /** CAS of the stream's row from `expected` (null: insert when absent) to `to`. */
  rewind(stream: RightsStream, expected: string | null, to: string): Promise<boolean>;
}

/** The governed adapters; a missing method means the platform has no such source. */
export interface RightsSyncRegistry {
  get(platform: RegisteredPlatform): Pick<UnionAdapter, 'listRefunds' | 'listPunishments'>;
}

export interface RightsSyncSchedulerDeps {
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly cursors: RightsCursorStore;
  readonly access: SyncAccessPort;
  readonly registry: RightsSyncRegistry;
  /** Flat fields only; never order numbers. */
  readonly logger?: SyncLogger;
}

/** The sub-order a record names: the union's order_id is the sub-order number. */
export interface RightsSyncTarget {
  readonly app_id: string;
  readonly platform: RegisteredPlatform;
  readonly sub_order_id: string;
}

/** What rights.record receives besides before / order_id / source / now. */
export interface RightsSyncItem {
  readonly type: 'RIGHTS' | 'PUNISH';
  readonly status: OrderRightsStatus;
  readonly amount_fen: bigint | null;
  readonly deduction_commission_fen: bigint | null;
  readonly occurred_at: Date;
  readonly platform_rights_no: string;
}

export type RightsSyncWriteResult = {
  readonly kind: 'applied' | 'duplicate' | 'not_applicable' | 'not_found';
};

export interface RightsSyncWriter {
  write(target: RightsSyncTarget, item: RightsSyncItem): Promise<RightsSyncWriteResult>;
}

export interface RightsSyncWriterDeps {
  readonly db: Kysely<DB>;
  /** RightsRecordInput.now. */
  readonly clock: Clock;
  /** settlement's rights.record, the only writer of order_rights. */
  readonly rights: RightsCommandPort;
}

/** One 30-minute round: a rights increment window and a punish window per eligible account. */
export function scheduleRightsSync(deps: RightsSyncSchedulerDeps): Promise<void> {
  void deps;
  throw new Error('NotImplemented: scheduleRightsSync');
}

/** One tick of the daily 60-day rights pass: one window per eligible account. */
export function scheduleRightsRescan(deps: RightsSyncSchedulerDeps): Promise<void> {
  void deps;
  throw new Error('NotImplemented: scheduleRightsRescan');
}

/** Starts timers only (platforms with a source); construction and start dispatch nothing. */
export function createRightsSyncScheduler(deps: RightsSyncSchedulerDeps): OrderSyncScheduler {
  void deps;
  throw new Error('NotImplemented: createRightsSyncScheduler');
}

/** find → lock → re-read → rights.record (source API), one transaction per record. */
export function createRightsSyncWriter(deps: RightsSyncWriterDeps): RightsSyncWriter {
  void deps;
  throw new Error('NotImplemented: createRightsSyncWriter');
}
