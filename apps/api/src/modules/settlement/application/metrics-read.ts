// Read-only fund metrics of settlement (B1-01zzi; BR-FUND-04, BR-CALC-13), across every app_id.
// "now" is the injected Clock only, never the database's clock. The worker's /metrics reads them
// through this module's index.ts.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface SettlementFundMetrics {
  /** settle_jobs rows with job bill in status failed. */
  readonly billJobsFailed: number;
  /** settle_batches rows in status PARTIAL. */
  readonly partialBatches: number;
  /**
   * Keys (app_id, order_id, user_id, role) of commission_split_beneficiary_events whose latest
   * event (max event_seq) is held and whose first held event was created at or before
   * now − 30 days.
   */
  readonly beneficiariesHeldOver30Days: number;
}

/** BR-CALC-13 (FUND-17): a share still held 30 × 24 hours after its first held event is alerted. */

/** A count column read leniently: a missing row, column or unparsable value is 0. */
function countOf(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

interface CountRow {
  readonly n?: unknown;
}

export async function readSettlementFundMetrics(
  db: Kysely<DB>,
  clock: Clock,
): Promise<SettlementFundMetrics> {
  // Now only from the injected Clock; the 30 x 24 h window is subtracted in SQL.
  const now = clock.now().toISOString();
  const [billJobs, batches, held] = await Promise.all([
    sql<CountRow>`
      SELECT count(*)::integer AS n
      FROM app.settle_jobs
      WHERE job = 'bill' AND status = 'failed'
    `.execute(db),
    sql<CountRow>`
      SELECT count(*)::integer AS n
      FROM app.settle_batches
      WHERE status = 'PARTIAL'
    `.execute(db),
    // BR-CALC-13 (FUND-17) literally: per key, the latest event (max event_seq) is held, and the
    // key's first held event ever (min created_at over all its held events) is at or before the
    // cutoff. The latest is held exactly when the last non-held event_seq is null or below the
    // max event_seq (it is never above it).
    sql<CountRow>`
      SELECT count(*)::integer AS n
      FROM (
        SELECT 1
        FROM app.commission_split_beneficiary_events
        GROUP BY app_id, order_id, user_id, role
        HAVING max(event_seq) FILTER (WHERE status <> 'held') IS DISTINCT FROM max(event_seq)
          AND min(created_at) FILTER (WHERE status = 'held') <= ${now}::timestamptz - interval '720 hours'
      ) held_keys
    `.execute(db),
  ]);
  return {
    billJobsFailed: countOf(billJobs.rows[0]?.n),
    partialBatches: countOf(batches.rows[0]?.n),
    beneficiariesHeldOver30Days: countOf(held.rows[0]?.n),
  };
}
