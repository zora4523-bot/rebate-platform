// The worker's review overdue gauge (B2-05o; BR-WDR-26 超时判定, BR-WDR-24 告警; D10-475 ②(b)):
// couli_withdrawals_review_overdue, unlabelled. The value comes from payout's read-only port, wired
// by entry.ts (platform imports no business module).

/** One scrape's value. */
export interface ReviewOverdueSnapshot {
  /**
   * Withdrawals across every app_id with review_overdue_at set whose status is still
   * PENDING_REVIEW or APPROVED.
   */
  readonly reviewOverdue: number;
}
