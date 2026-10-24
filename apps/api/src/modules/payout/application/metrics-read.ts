// Read-only fund metric of payout (B1-01zzi; BR-WDR-14, BR-WDR-18), across every app_id. The
// worker's /metrics reads it through this module's index.ts.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface PayoutFundMetrics {
  /** withdrawals rows in status PAYING with needs_manual set (result unknown, waiting for a person). */
  readonly payingNeedsManual: number;
}

export async function readPayoutFundMetrics(db: Kysely<DB>): Promise<PayoutFundMetrics> {
  void db;
  throw new Error('NotImplemented: readPayoutFundMetrics');
}
