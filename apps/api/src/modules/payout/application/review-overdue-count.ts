// Read-only review overdue count of payout (B2-05o; BR-WDR-26 超时判定, BR-WDR-24 告警; D10-475 ②(b)),
// across every app_id. The worker's /metrics reads it through this module's index.ts. Only
// review_overdue_at decides (set once by B2-05n's check); the deadline alone never counts, and a
// row whose review ended (PAYING, a terminal state or REJECTED) leaves the count while the column
// stays set. No cache here and no database clock: each call reads the current rows. A failed read
// rejects with its own error, it is never turned into 0 (the scrape fails visibly).
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export interface PayoutReviewOverdue {
  /**
   * withdrawals rows with review_overdue_at set (judged overdue by the B2-05n check) whose status
   * is still PENDING_REVIEW or APPROVED.
   */
  readonly reviewOverdue: number;
}

/** The statuses an overdue withdrawal still counts in: review not ended (BR-WDR-26 「审核结束」). */
const COUNTED_STATUSES = ['PENDING_REVIEW', 'APPROVED'] as const;

/** A count column read leniently: a missing row, column or unparsable value is 0. */
function countOf(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function readPayoutReviewOverdue(db: Kysely<DB>): Promise<PayoutReviewOverdue> {
  const result = await sql<{ readonly review_overdue?: unknown }>`
    SELECT count(*)::integer AS review_overdue
    FROM app.withdrawals
    WHERE review_overdue_at IS NOT NULL
      AND status IN (${sql.join(COUNTED_STATUSES.map((status) => sql.lit(status)))})
  `.execute(db);
  return { reviewOverdue: countOf(result.rows[0]?.review_overdue) };
}
