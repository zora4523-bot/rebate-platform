// B2-03q (D10-540, D10-565, D10-568): commission's estimate port for settlement's rebate
// (RebateDependencies['estimates'], signatures unchanged). bases is read-only; refresh appends the
// amount and totals rows of orders' current commission_version on the caller's transaction.
// Commission does not read the orders table: the columns come through deps.readOrder, the owner's
// read on the same transaction.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type {
  CommissionSnapshotDependencies,
  CreateCommissionSnapshotInput,
  CreateCommissionSnapshotResult,
} from '../application/snapshot.ts';
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

/** The columns bases and refresh need, as the orders row carries them. */
export interface EstimateOrder {
  readonly platform: string;
  readonly commission_version: number;
  readonly rebate_status: string;
  readonly est_commission_fen: bigint | null;
  readonly settle_commission_fen: bigint | null;
  /** Null on a platform that deducts the fee means unknown: no N, never a fee of zero. */
  readonly service_fee_fen: bigint | null;
}

export interface CommissionEstimatesDependencies {
  readonly clock: Clock;
  /** The order row re-read on the caller's transaction, which holds the order lock. */
  readOrder(trx: Transaction<DB>, ref: EstimateOrderRef): Promise<EstimateOrder | undefined>;
  /** The platform's commission includes the service fee (BR-CALC-03): N = commission − fee. */
  serviceFeeDeducted(platform: string): boolean;
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

export type CommissionSnapshotPortDependencies = CommissionEstimatesDependencies &
  Pick<CommissionSnapshotDependencies, 'logger' | 'beneficiaries'>;

/**
 * D10-568: what orders' runCommissionSnapshot takes. create is createCommissionSnapshot; refresh is
 * the estimates port's refresh, for a created snapshot of an order already past version 1.
 */
export interface CommissionOrderSnapshotPort {
  create(
    trx: Transaction<DB>,
    input: CreateCommissionSnapshotInput,
  ): Promise<CreateCommissionSnapshotResult>;
  refresh(trx: Transaction<DB>, input: EstimateOrderRef): Promise<void>;
}

export function createCommissionSnapshotPort(
  deps: CommissionSnapshotPortDependencies,
): CommissionOrderSnapshotPort {
  void deps;
  throw new Error('NotImplemented: createCommissionSnapshotPort');
}
