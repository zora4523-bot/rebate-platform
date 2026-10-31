// B2-05n: the payout-overdue chain of the worker (规划/08 BR-WDR-26: 超时检查任务每 5 分钟运行一次;
// D10-475 ②). Skeleton of the rule-test round: every function throws.
//
// Queue `payout-overdue` (platform/queue catalog and worker plan, exclusive), job `check`,
// payload { slot }, singletonKey = the slot's key (application/review-overdue.ts).
// - createReviewOverdueJob: runs check.run(clock.now()), then sends the next slot outside a
//   transaction (trx null, singletonKey and delaySeconds of nextReviewOverdueSlot). A failed run
//   rejects (the queue retries).
// - seedReviewOverdue: the chain's start and heal (payout.module's timer): sends the slot the
//   clock is in, without a delay; the exclusive key merges a second seed of the same slot.
import type { Clock, JobHandler, JobQueue } from '../../platform/index.ts';
import type { ReviewOverdueCheck, ReviewOverdueLogger } from '../application/review-overdue.ts';

/** The queue of the overdue check (platform/queue catalog and worker plan). */
export type ReviewOverdueQueue = 'payout-overdue';

/** The job of one slot on that queue. */
export type ReviewOverdueJobName = 'check';

/** Payload of a `check` job. */
export interface ReviewOverdueJobPayload {
  /** The slot's singletonKey. */
  readonly slot: string;
}

export interface ReviewOverdueJobOptions {
  readonly check: ReviewOverdueCheck;
  readonly queue: JobQueue;
  readonly clock: Clock;
  readonly logger: ReviewOverdueLogger;
}

export interface ReviewOverdueSeedOptions {
  readonly queue: JobQueue;
  readonly clock: Clock;
  readonly logger: ReviewOverdueLogger;
}

/** The handler of queue payout-overdue (job `check`). */
export function createReviewOverdueJob(options: ReviewOverdueJobOptions): JobHandler {
  void options;
  throw new Error('NotImplemented: createReviewOverdueJob');
}

/** Sends the current slot's `check` job (start and heal of the chain). */
export function seedReviewOverdue(options: ReviewOverdueSeedOptions): Promise<void> {
  void options;
  throw new Error('NotImplemented: seedReviewOverdue');
}
