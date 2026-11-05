// B1-04zza: the 'rights.window' / 'punish.window' jobs on the order-sync queue (application/
// rights-sync.ts has the scheduler and the writer). Skeleton only (test stage).
// - Payload checks as jobs/order-sync.ts (OrderSyncPayloadError); the window account must be the
//   queryable one and site auth available, else the job ends without fetching or moving a cursor.
// - rights.window: every page of listRefunds (timeBasis update, purpose order_sync), each refund
//   through the writer as type RIGHTS, platform_rights_no = refund_id, deduction = refund_fen,
//   occurred_at = refund_created_at (absent: the Clock). rights_status PROCESSING / SUCCEEDED /
//   FAILED as is, CLOSED_NO_CHARGE → FAILED (counted), null → nothing written (counted). The
//   stream's cursor moves once, after every page.
// - punish.window: every page of listPunishments, each as type PUNISH, status SUCCEEDED,
//   platform_rights_no = punishment_id, occurred_at = the Clock; no cursor.
// - not_found (an order of someone else's slot) is counted only; logs never carry order numbers.
import type { Clock, ReceivedJob } from '../../platform/index.ts';
import type {
  RightsCursorStore,
  RightsSyncRegistry,
  RightsSyncWriter,
} from '../application/rights-sync.ts';
import type { SyncAccessPort, SyncLogger } from '../application/sync-ports.ts';

export interface RightsSyncHandlerDeps {
  /** occurred_at of punishments and of refunds without a creation time. */
  readonly clock: Clock;
  readonly access: SyncAccessPort;
  readonly cursors: Pick<RightsCursorStore, 'advance'>;
  readonly registry: RightsSyncRegistry;
  readonly writer: RightsSyncWriter;
  readonly logger?: SyncLogger;
}

export function handleRightsWindow(job: ReceivedJob, deps: RightsSyncHandlerDeps): Promise<void> {
  void job;
  void deps;
  throw new Error('NotImplemented: handleRightsWindow');
}

export function handlePunishWindow(job: ReceivedJob, deps: RightsSyncHandlerDeps): Promise<void> {
  void job;
  void deps;
  throw new Error('NotImplemented: handlePunishWindow');
}
