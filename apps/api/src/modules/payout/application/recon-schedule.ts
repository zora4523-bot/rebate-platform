// B2-07c: the start of the daily chain of the R2 reconciliation (规划/08 BR-WDR-23 每日 T+1). Run by
// the worker after bootstrap and on every heal: for every app with an Alipay withdrawal, one `recon`
// job on queue `payout-recon` for the previous +08:00 accounting day of the clock (@couli/domain),
// keyed per (app, channel, bill day) so a seed again adds no second run, due at the day's run time
// (at once when it has passed) and never before that bill day is over.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, JobQueue } from '../../platform/index.ts';
import type { PayoutReconLogger } from '../jobs/recon-job.ts';

export interface PayoutReconSeedOptions {
  /** couli_app: the apps with withdrawals. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly logger: PayoutReconLogger;
}

export function seedPayoutRecon(options: PayoutReconSeedOptions): Promise<void> {
  void options;
  throw new Error('NotImplemented: seedPayoutRecon');
}
