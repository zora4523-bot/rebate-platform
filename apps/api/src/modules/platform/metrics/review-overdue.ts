// The worker's review overdue gauge (B2-05o; BR-WDR-26 超时判定, BR-WDR-24 告警; D10-475 ②(b)):
// couli_withdrawals_review_overdue, unlabelled. The value comes from payout's read-only port, wired
// by entry.ts (platform imports no business module). Only the worker exports it; couli-fund.yaml
// alerts on it > 0 (fund: 'true', so the alert is pushed at night too, 规划/02 §13).
import type { Clock } from '../clock/index.ts';
import { cacheCollector } from './cache.ts';

/** One scrape's value. */
export interface ReviewOverdueSnapshot {
  /**
   * Withdrawals across every app_id with review_overdue_at set whose status is still
   * PENDING_REVIEW or APPROVED.
   */
  readonly reviewOverdue: number;
}

/** The gauge: one unlabelled sample, exported with 0 too (the rule compares with > 0). */
export const REVIEW_OVERDUE_GAUGE = {
  name: 'couli_withdrawals_review_overdue',
  help: 'Withdrawals judged review-overdue (review_overdue_at set) still in PENDING_REVIEW or APPROVED (BR-WDR-26).',
} as const;

/** Default freshness of a cached snapshot: 5 minutes (规划/02 §13 common granularity). */
const DEFAULT_TTL_MS = 300_000;

/**
 * The worker's review overdue collection cached like the fund one (cacheFundCollector, B1-01zzo):
 * within ttlMs (default 300 000) the last successful snapshot, never a rejected one, so a failed
 * read fails the scrape and the next scrape reads again.
 */
export function cacheReviewOverdueCollector(
  collect: () => Promise<ReviewOverdueSnapshot>,
  clock: Clock,
  ttlMs = DEFAULT_TTL_MS,
): () => Promise<ReviewOverdueSnapshot> {
  return cacheCollector(collect, clock, ttlMs);
}
