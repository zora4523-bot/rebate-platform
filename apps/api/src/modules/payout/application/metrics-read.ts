// Read-only fund metric of payout (B1-01zzi; BR-WDR-14, BR-WDR-18), across every app_id. The
// worker's /metrics reads it through this module's index.ts.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export interface PayoutFundMetrics {
  /** withdrawals rows in status PAYING with needs_manual set (result unknown, waiting for a person). */
  readonly payingNeedsManual: number;
}

/** A count column read leniently: a missing row, column or unparsable value is 0. */
function countOf(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function readPayoutFundMetrics(db: Kysely<DB>): Promise<PayoutFundMetrics> {
  const result = await sql<{ readonly paying_needs_manual?: unknown }>`
    SELECT count(*)::integer AS paying_needs_manual
    FROM app.withdrawals
    WHERE status = 'PAYING' AND needs_manual
  `.execute(db);
  return { payingNeedsManual: countOf(result.rows[0]?.paying_needs_manual) };
}
