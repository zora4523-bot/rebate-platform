// Read-only fund metrics of settlement (B1-01zzi; BR-FUND-04, BR-CALC-13), across every app_id.
// "now" is the injected Clock only, never the database's clock. The worker's /metrics reads them
// through this module's index.ts.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface SettlementFundMetrics {
  /** settle_jobs rows with job bill in status failed. */
  readonly billJobsFailed: number;
  /** settle_batches rows in status PARTIAL. */
  readonly partialBatches: number;
  /**
   * Keys (app_id, order_id, user_id, role) of commission_split_beneficiary_events whose latest
   * event (max event_seq) is held and whose first held event was created at or before now − 30 days.
   */
  readonly beneficiariesHeldOver30Days: number;
}

export async function readSettlementFundMetrics(
  db: Kysely<DB>,
  clock: Clock,
): Promise<SettlementFundMetrics> {
  void db;
  void clock;
  throw new Error('NotImplemented: readSettlementFundMetrics');
}
