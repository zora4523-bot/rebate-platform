// B2-05n: the payout-overdue chain of the worker (规划/08 BR-WDR-26: 超时检查任务每 5 分钟运行一次;
// D10-475 ②).
//
// Queue `payout-overdue` (platform/queue catalog and worker plan, exclusive), job `check`,
// payload { slot }, singletonKey = the slot's key (application/review-overdue.ts).
// - createReviewOverdueJob: runs check.run(clock.now()) — the instant of the injected Clock, never
//   the slot in the payload (a late or redelivered old slot is checked now and chains on from now) —
//   then sends the next slot outside a transaction (trx null, singletonKey and delaySeconds of
//   nextReviewOverdueSlot) — also when the check failed (finally; money r1 S2: the chain must not
//   wait for the failed slot's retries to exhaust and the 30-minute heal). A failed run rejects with
//   the check's error (the queue retries the job; a rerun is idempotent, the column is set once by
//   the CAS).
// - seedReviewOverdue: the chain's start and heal (payout.module's timer): sends the slot the clock
//   is in, without a delay and outside a transaction, and runs no check; the exclusive queue merges
//   a second seed of the same slot (a queued or active job of the key makes the send a no-op), so a
//   heal never doubles the chain. Precedents: ledger's daily check (B2-02q), risk-scan (B1-03j).
import type { Clock, JobHandler, JobQueue, ReceivedJob } from '../../platform/index.ts';
import {
  nextReviewOverdueSlot,
  reviewOverdueSlot,
  type ReviewOverdueCheck,
  type ReviewOverdueLogger,
  type ReviewOverdueSlot,
} from '../application/review-overdue.ts';

/** The queue of the overdue check (platform/queue catalog and worker plan). */
export type ReviewOverdueQueue = 'payout-overdue';
export const PAYOUT_OVERDUE_QUEUE: ReviewOverdueQueue = 'payout-overdue';

/** The job of one slot on that queue. */
export type ReviewOverdueJobName = 'check';
export const PAYOUT_OVERDUE_JOB: ReviewOverdueJobName = 'check';

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

/** Sends the `check` job of `slot` outside a transaction; null when the key is already queued. */
function sendSlot(queue: JobQueue, slot: ReviewOverdueSlot): Promise<string | null> {
  const payload: ReviewOverdueJobPayload = { slot: slot.singletonKey };
  return queue.send(
    PAYOUT_OVERDUE_QUEUE,
    PAYOUT_OVERDUE_JOB,
    { ...payload },
    {
      trx: null,
      singletonKey: slot.singletonKey,
      ...(slot.delaySeconds === undefined ? {} : { delaySeconds: slot.delaySeconds }),
    },
  );
}

/** The handler of queue payout-overdue (job `check`). */
export function createReviewOverdueJob(options: ReviewOverdueJobOptions): JobHandler {
  const { check, queue, clock, logger } = options;
  return async function reviewOverdueJob(job: ReceivedJob): Promise<void> {
    if (job.name !== PAYOUT_OVERDUE_JOB) {
      logger.warn({ job_id: job.id, queue: job.queue, name: job.name }, 'payout_overdue_bad_job');
      return;
    }
    try {
      const result = await check.run(clock.now());
      logger.info(
        { job_id: job.id, scanned: result.scanned, judged: result.judged },
        'payout_overdue_checked',
      );
    } finally {
      // Whether the check succeeded or failed (money r1 S2): the chain must not depend on this
      // slot's retries; the next slot is sent either way (the CAS makes an overlapping rerun of
      // a failed slot safe), and the check's error still rejects the job afterwards.
      await sendSlot(queue, nextReviewOverdueSlot(clock.now()));
    }
  };
}

/** Sends the current slot's `check` job (start and heal of the chain). */
export async function seedReviewOverdue(options: ReviewOverdueSeedOptions): Promise<void> {
  const { queue, clock, logger } = options;
  const slot = reviewOverdueSlot(clock.now());
  const id = await sendSlot(queue, slot);
  if (id !== null) logger.info({ singleton_key: slot.singletonKey }, 'payout_overdue_seeded');
}
