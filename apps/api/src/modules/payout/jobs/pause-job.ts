// B2-06f (D10-398 ②): the worker persists a pause the payout process asked for. On a payer-side
// code (BR-WDR-17) or a code outside the three lists (BR-WDR-28) the payout process commits its own
// result first (payer side: W9 payer_side_after_transfer on its own transaction, never on the
// pause's), pauses the app in process at once (fail closed until the database says so), and
// enqueues
//   queue.send('payout-landing', 'pause', { app_id, reason }, ...)
// This handler (worker, couli_app) writes payout.queue_paused = true through content's system
// write (PayoutQueuePausePort: only the safe direction, system as the writer). A new payout
// process reads the pause from PG.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { JobHandler } from '../../platform/index.ts';
import type { PayoutQueuePausePort, TransferJobLogger } from './transfer-job.ts';

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

export function createPauseJob(options: PauseJobOptions): JobHandler {
  void options;
  throw new Error('NotImplemented: createPauseJob');
}
