// B2-15m: the daily chain of the T+1 collection reconciliation (08 BR-PAY-07 每日 T+1 对账; B2-15j
// bill.recon, application/pay-recon.ts).
//
// seedBillRecon — the chain's start, run by the worker entry after application bootstrap (no
//   enqueue by hand): for every App with collection records, one bill.recon on queue pay for the
//   bill day before the +08:00 accounting day of clock.now() (@couli/domain), carrying that bill
//   day, keyed per App and bill day (jobs/names.ts billReconKey: a seed after a restart merges into
//   the queued run of the same day), delayed until that day's daily run time or due at once when
//   that time has passed. A failure of one App does not stop the others.
// The next daily run (runBillReconJob) is computed from the bill day just reconciled (bill day +
//   1), never from clock.now(), so a run delayed by a stopped worker or replayed from the dead
//   letters on a later day still enqueues the following day, until the chain has caught up.
// Also compiled by the `test` project: erasable syntax only.
import type { PayReconDeps } from './pay-recon.ts';

/** What seeding needs: payment's own tables (the Apps), the clock, the pay queue, the logger. */
export type PayReconSeedDeps = Pick<PayReconDeps, 'db' | 'clock' | 'queue' | 'logger'>;

/** Seeds the daily bill.recon of every App (see the header). */
export function seedBillRecon(deps: PayReconSeedDeps): Promise<void> {
  void deps;
  throw new Error('NotImplemented: seedBillRecon');
}
