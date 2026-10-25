// B1-09i: the console's manual order sync (POST / GET /admin/v1/order-syncs, GET
// /admin/v1/order-syncs/limits; 01 F-ORD-10; 02 §7.1; contract adminCreateOrderSync,
// adminListOrderSyncs, adminGetOrderSyncLimits, CT-24n). The permission check (order.view) is the
// controller's, through platform's AdminOperationGuard; appId and adminId are the guard's actor.
// - create: one order_sync_requests row per filter while it is queued or running (the partial
//   unique index order_sync_requests_live_digest_key decides; an equal request meanwhile returns
//   the original with reused=true and dispatches nothing). A window request is cut into windows of
//   the platform's cap (02 §7.1) and every window goes to the order-sync queue with the key
//   `platform:account:kind:scene:manual:<filter_digest>:window_start`; sync_cursors is neither read
//   nor advanced. An order-number request is Pinduoduo only (union's getPddOrderDetail); taobao / jd
//   are refused with 20001 data.fields=[order_nos]. A status_filter not registered for the platform
//   in specs/union/<platform>.md is 20001 [status_filter]. While the platform's sync stream is
//   paused by the site owner's authorization (BR-ID-24 ④, union's siteAuthAvailable) the request is
//   refused with 30156 data.platform; while the offline breaker is open nothing is dispatched.
// - list: the app's requests, created_at descending; limits: manualSyncLimits at the Clock.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, JobQueue } from '../../platform/index.ts';
import type { SyncAccessPort, SyncLogger } from './sync-ports.ts';

export interface ManualOrderSyncDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  /** union's sync access (createUnionSyncAccess): accounts, site authorization, offline breaker. */
  readonly access: SyncAccessPort;
  /** Flat fields only (platform, sync_id, windows); never order numbers. */
  readonly logger?: SyncLogger;
}

/** The admin of the token: the request's app and requested_by. */
export interface ManualOrderSyncRequester {
  readonly appId: string;
  readonly adminId: string;
}

export interface ManualOrderSyncListQuery {
  readonly page: number;
  readonly page_size: number;
}

export interface ManualOrderSyncs {
  /** Refusals (20001 with fields, 30156 with platform) reject; nothing is written or sent then. */
  create(
    requester: ManualOrderSyncRequester,
    body: Schema<'AdminOrderSyncCreateRequest'>,
  ): Promise<Schema<'AdminOrderSyncCreated'>>;
  list(appId: string, query: ManualOrderSyncListQuery): Promise<Schema<'AdminOrderSyncPage'>>;
  limits(): Schema<'AdminOrderSyncLimits'>;
}

export function createManualOrderSyncs(deps: ManualOrderSyncDeps): ManualOrderSyncs {
  void deps;
  throw new Error('NotImplemented: createManualOrderSyncs');
}
