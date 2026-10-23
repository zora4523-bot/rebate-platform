// B2-06c: payout_batches and payout_batch_items writes (规划/08 BR-WDR-11 / 12; both tables are
// insert-only, payout_batch_items is guarded by a trigger). Every write runs on the caller's
// transaction.
//   kind       manual (created_by = the executing admin) or auto (created_by null; one withdrawal).
//   items      paying (no reason); skipped / blocked with a reason (not_approved, member_blocked,
//              has_transfer_attempt, channel_disabled); moved_out on the old batch with
//              moved_to_batch_id = the new batch (no reason).
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export type PayoutBatchKind = 'manual' | 'auto';
export type PayoutBatchItemResult = 'paying' | 'skipped' | 'blocked' | 'moved_out';

export interface NewPayoutBatch {
  readonly id: string;
  readonly appId: string;
  readonly kind: PayoutBatchKind;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export interface NewPayoutBatchItem {
  readonly appId: string;
  readonly batchId: string;
  readonly withdrawalId: string;
  readonly result: PayoutBatchItemResult;
  readonly reason: string | null;
  readonly movedToBatchId: string | null;
  readonly at: Date;
}

export interface PayoutBatchesStore {
  insertBatch(trx: Transaction<DB>, batch: NewPayoutBatch): Promise<void>;
  insertItems(trx: Transaction<DB>, items: readonly NewPayoutBatchItem[]): Promise<void>;
}

export function createPayoutBatchesStore(): PayoutBatchesStore {
  throw new Error('NotImplemented: createPayoutBatchesStore');
}
