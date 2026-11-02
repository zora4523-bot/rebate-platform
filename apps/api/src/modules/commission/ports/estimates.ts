// B2-03q (D10-540, D10-565): commission's estimate port for settlement's rebate
// (RebateDependencies['estimates'], signatures unchanged). bases is read-only; refresh appends the
// amount and totals rows of orders' current commission_version on the caller's transaction.
// Commission does not read the orders table: the columns come through deps.readOrder, the owner's
// read on the same transaction.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface EstimateOrderRef {
  readonly appId: string;
  readonly orderId: string;
  readonly attrAt: Date;
}

export interface EstimateChangeInput extends EstimateOrderRef {
  readonly estBefore: bigint | null;
  readonly estAfter: bigint | null;
  readonly settleCommissionFen: bigint | null;
}

/** null means unknown, never zero. */
export interface EstimateBases {
  readonly before: bigint | null;
  readonly after: bigint | null;
}

/** The columns refresh needs, as the orders row carries them. */
export interface EstimateOrder {
  readonly commission_version: number;
  readonly rebate_status: string;
  readonly est_commission_fen: bigint | null;
  readonly settle_commission_fen: bigint | null;
}

export interface CommissionEstimatesDependencies {
  readonly clock: Clock;
  /** The order row re-read on the caller's transaction, which holds the order lock. */
  readOrder(trx: Transaction<DB>, ref: EstimateOrderRef): Promise<EstimateOrder | undefined>;
}

export interface CommissionEstimates {
  bases(trx: Transaction<DB>, input: EstimateChangeInput): Promise<EstimateBases>;
  refresh(trx: Transaction<DB>, input: EstimateOrderRef): Promise<void>;
}

export function createCommissionEstimates(
  deps: CommissionEstimatesDependencies,
): CommissionEstimates {
  void deps;
  throw new Error('NotImplemented: createCommissionEstimates');
}
