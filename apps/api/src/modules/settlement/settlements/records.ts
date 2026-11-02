// B2-04zj (D10-583, FU-PROD-WIRING 第 13 项; BR-FUND-09): the settlement record port. order_settlements
// has this one writer; orders.settle_commission_fen stays with orders, which reads the latest
// STATEMENT amount here before it plans its columns. Both run on the caller's transaction, under the
// order lock orders already holds.
// Skeleton of the rule-test round: the implementation comes with the implement round.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface SettlementOrderRef {
  readonly appId: string;
  readonly orderId: string;
}

export interface ApiSettlementInput extends SettlementOrderRef {
  /** The union's settlement commission as reported; 0 and negatives are known values. */
  readonly commissionFen: bigint;
  readonly settledAt: Date;
}

export interface ApiSettlementResult {
  /** The order's greatest seq after this call. */
  readonly seq: number;
  /** false: the content equals the latest record, nothing was written. */
  readonly inserted: boolean;
}

export interface SettlementRecords {
  /**
   * BR-FUND-09: under the order lock, the greatest seq of the order; seq + 1 with source API only
   * when the content differs. content_hash is stable over amount and settlement time; created_at
   * comes from the injected Clock.
   */
  recordApi(trx: Transaction<DB>, input: ApiSettlementInput): Promise<ApiSettlementResult>;
  /** The amount of the order's STATEMENT record with the greatest seq; null when it has none. */
  latestStatementFen(trx: Transaction<DB>, ref: SettlementOrderRef): Promise<bigint | null>;
}

export interface SettlementRecordsDependencies {
  readonly clock: Clock;
}

export function createSettlementRecords(deps: SettlementRecordsDependencies): SettlementRecords {
  void deps;
  throw new Error('NotImplemented: createSettlementRecords');
}
