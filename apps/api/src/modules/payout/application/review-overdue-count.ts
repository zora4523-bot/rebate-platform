// Read-only review overdue count of payout (B2-05o; BR-WDR-26 超时判定, BR-WDR-24 告警; D10-475 ②(b)),
// across every app_id. The worker's /metrics reads it through this module's index.ts.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface PayoutReviewOverdue {
  /**
   * withdrawals rows with review_overdue_at set (judged overdue by the B2-05n check) whose status
   * is still PENDING_REVIEW or APPROVED.
   */
  readonly reviewOverdue: number;
}

export async function readPayoutReviewOverdue(db: Kysely<DB>): Promise<PayoutReviewOverdue> {
  void db;
  throw new Error('NotImplemented: readPayoutReviewOverdue');
}
