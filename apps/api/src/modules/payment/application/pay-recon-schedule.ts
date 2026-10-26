// B2-15m: the daily chain of the T+1 collection reconciliation (08 BR-PAY-07 每日 T+1 对账; B2-15j
// bill.recon, application/pay-recon.ts).
//
// seedBillRecon — the chain's start, run by the worker entry after application bootstrap and then
//   again on every heal (payment.module.ts; no enqueue by hand): for every App with pay records
//   (infra/pay-recon-store.ts firstPayRecords: a pay order of any status or an anomaly receipt),
//   one bill.recon on queue pay carrying the App's first bill day — the +08:00 accounting day
//   (@couli/domain) of its earliest order creation or anomaly registration, never later than the
//   channel's trade (money review r1 S1) — keyed per App and bill day (jobs/names.ts billReconKey,
//   through pay-recon.ts scheduleBillRecon), delayed until that day's daily run time or due at once
//   when that time has passed. The run of that day then enqueues the following day, and so on
//   (pay-recon.ts runBillReconJob: bill day + 1, never the clock), so an App whose chain starts
//   late — its first order after the worker started, a seed that failed, a restart after days
//   down — is reconciled from its first bill day on, day by day, without a skipped day.
//   Reconciling a day again changes nothing that already holds (B2-15j: recon diffs, anomalies and
//   vouchers dedupe on their keys), and a send for a bill day whose run is queued or active merges
//   into it (queue pay is exclusive per singletonKey): a seed after a restart adds no second run.
//   `started` (the worker's, per process) remembers the bill day each App's chain was started from
//   by a send that went through; such an App is not sent again by the same process, so the heal
//   only picks up the Apps not started yet (new collection, failed sends) instead of replaying the
//   chain every interval. A failed send is not remembered (retried on the next heal); a failure of
//   one App does not stop the others; the first failure is rethrown after all Apps were tried.
//   TODO(规划/11 §2.3): start a chain at the day after the App's last reconciled bill day instead
//   of its first bill day (B2-15m review r2 S2: an App with PAY_FEE of 10-19 and 10-20 and no chain
//   restarts at 10-21) — blocked on a durable record of reconciled bill days that payment may read:
//   PAY_FEE vouchers live in ledger_vouchers (ledger's table, no read export in ledger/index.ts), a
//   day with no fee and no diff leaves no trace at all, and pgboss is read only through JobQueue.
//   Until then every new process restarts each App's chain at its first bill day (idempotent, but
//   one download of every past bill per channel once the real adapters land, B2-15k).
// Also compiled by the `test` project: erasable syntax only.
import { accountingDate } from '@couli/domain';
import { firstPayRecords } from '../infra/pay-recon-store.ts';
import { scheduleBillRecon, type PayReconDeps } from './pay-recon.ts';

/** What seeding needs: payment's own tables (the Apps), the clock, the pay queue, the logger. */
export type PayReconSeedDeps = Pick<PayReconDeps, 'db' | 'clock' | 'queue' | 'logger'>;

export interface PayReconSeedOptions {
  /**
   * The worker's memory (one per process): App → the bill day its chain was started from by a
   * send that went through. Left out, every App is sent (a restart's seed).
   */
  readonly started?: Map<string, string>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Seeds the daily bill.recon of every App (see the header). */
export async function seedBillRecon(
  deps: PayReconSeedDeps,
  options: PayReconSeedOptions = {},
): Promise<void> {
  const now = deps.clock.now();
  const apps = await firstPayRecords(deps.db);
  let failure: { readonly error: unknown } | null = null;
  for (const app of apps) {
    const billDate = accountingDate(app.first_at);
    if (options.started?.get(app.app_id) === billDate) continue;
    try {
      await scheduleBillRecon(deps, app.app_id, billDate, now);
      options.started?.set(app.app_id, billDate);
      deps.logger.info({ app_id: app.app_id, bill_date: billDate }, 'pay_bill_recon_seeded');
    } catch (error: unknown) {
      failure ??= { error };
      deps.logger.warn(
        { app_id: app.app_id, bill_date: billDate, error_name: errorName(error) },
        'pay_bill_recon_seed_failed',
      );
    }
  }
  if (failure !== null) throw failure.error;
}
