// B2-06f (D10-398 ②): the worker persists a pause the payout process asked for. On a payer-side
// code (BR-WDR-17) or a code outside the three lists (BR-WDR-28) the payout process commits its own
// result first (payer side: W9 payer_side_after_transfer on its own transaction, never on the
// pause's), pauses the app in process at once (fail closed until the database says so), and
// enqueues
//   queue.send('payout-landing', 'pause', { app_id, reason }, ...)
// This handler (worker, couli_app) writes payout.queue_paused = true through content's system
// write (PayoutQueuePausePort: only the safe direction, system as the writer). A new payout
// process reads the pause from PG. A rejection is rethrown so the queue retries the job.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { JobHandler, ReceivedJob } from '../../platform/index.ts';
import {
  PAYOUT_PAUSE_JOB,
  type PayoutQueuePausePort,
  type TransferJobLogger,
} from './transfer-job.ts';

export { PAYOUT_PAUSE_JOB };

/** The pause job's payload; reason is 'payer_side' or 'unknown_code'. */
export interface PayoutPausePayload {
  readonly app_id: string;
  readonly reason: string;
}

export interface PauseJobOptions {
  /** couli_app. */
  readonly db: Kysely<DB>;
  readonly pauseQueue: PayoutQueuePausePort;
  readonly logger: TransferJobLogger;
}

/** The pause's origin as content's version history records it (`<source>:<reason>`). */
const PAUSE_SOURCE = 'payout_transfer';
const REASONS: ReadonlySet<string> = new Set(['payer_side', 'unknown_code']);

function parsePayload(job: ReceivedJob): PayoutPausePayload | null {
  const payload = job.payload as Record<string, unknown>;
  const appId = payload['app_id'];
  const reason = payload['reason'];
  if (typeof appId !== 'string' || appId === '') return null;
  if (typeof reason !== 'string' || !REASONS.has(reason)) return null;
  return { app_id: appId, reason };
}

export function createPauseJob(options: PauseJobOptions): JobHandler {
  const { db, pauseQueue, logger } = options;
  return async function pauseJob(job: ReceivedJob): Promise<void> {
    const payload = job.name === PAYOUT_PAUSE_JOB ? parsePayload(job) : null;
    if (payload === null) {
      logger.warn({ job_id: job.id, queue: job.queue, name: job.name }, 'payout_pause_bad_job');
      return;
    }
    const result = await db.transaction().execute((trx) =>
      pauseQueue.pause(trx, {
        appId: payload.app_id,
        source: PAUSE_SOURCE,
        reason: payload.reason,
      }),
    );
    logger.info(
      { app_id: payload.app_id, reason: payload.reason, changed: result.changed },
      'payout_queue_pause_persisted',
    );
  };
}
