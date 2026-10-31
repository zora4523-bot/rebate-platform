// B2-05n: the review overdue check of withdrawals (规划/08 BR-WDR-26 超时判定, BR-WDR-24 审核超时告警;
// 编排裁定 D10-467 ④, D10-475 ②). Skeleton of the rule-test round: every function throws.
//
// - Slots: one per 5 minutes, singletonKey `review-overdue:YYYY-MM-DDTHH:mm` (UTC, minutes rounded
//   down to a multiple of 5), pure functions of the instant handed in (as risk/domain/risk-scan-slots).
//   reviewOverdueSlot(now) is the slot `now` falls in (no delay); nextReviewOverdueSlot(now) the slot
//   after it, with the seconds until it is due (at least 1).
// - createReviewOverdueCheck(...).run(now): every app's withdrawals with review_deadline <= now,
//   review_overdue_at IS NULL and status in {PENDING_REVIEW, APPROVED}, ordered by review_deadline,
//   id; each one on its own transaction: identity's users lock → reread → CAS
//   review_overdue_at = now (0 rows: skipped) → event withdrawal.review_overdue
//   {withdrawal_id, user_id, review_deadline, overdue_at} on that transaction; after the commit one
//   warn line 'withdrawal_review_overdue' { app_id, withdrawal_id, review_deadline, overdue_at }.
//   A failed withdrawal is a warn 'withdrawal_review_overdue_failed' and does not stop the others;
//   the first failure is rethrown at the end. Resolves { scanned, judged }.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, EventBus } from '../../platform/index.ts';
import type { WithdrawApplyOptions } from './withdraw-apply.ts';

/** A time slot of the payout-overdue chain. */
export interface ReviewOverdueSlot {
  readonly singletonKey: string;
  /** Seconds until the slot is due; at least 1. Absent for the slot `now` falls in. */
  readonly delaySeconds?: number;
}

/** pino's two-argument shape. */
export interface ReviewOverdueLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface ReviewOverdueCheckOptions {
  /** couli_app (the worker): reads the candidates, writes review_overdue_at. */
  readonly db: Kysely<DB>;
  /** identity's users row lock (app.module hands it in). */
  readonly lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  readonly eventBus: EventBus;
  readonly clock: Clock;
  readonly logger: ReviewOverdueLogger;
}

export interface ReviewOverdueResult {
  /** Candidates selected (deadline reached, not judged, PENDING_REVIEW / APPROVED). */
  readonly scanned: number;
  /** Withdrawals this run judged overdue (review_overdue_at written, event published). */
  readonly judged: number;
}

export interface ReviewOverdueCheck {
  run(now: Date): Promise<ReviewOverdueResult>;
}

/** The slot `now` falls in (what a seed sends; no delay). */
export function reviewOverdueSlot(now: Date): ReviewOverdueSlot {
  void now;
  throw new Error('NotImplemented: reviewOverdueSlot');
}

/** The first slot after the one `now` falls in, with the seconds until it is due. */
export function nextReviewOverdueSlot(now: Date): ReviewOverdueSlot {
  void now;
  throw new Error('NotImplemented: nextReviewOverdueSlot');
}

export function createReviewOverdueCheck(options: ReviewOverdueCheckOptions): ReviewOverdueCheck {
  void options;
  throw new Error('NotImplemented: createReviewOverdueCheck');
}
