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
//   by a send that went through; such an App is not sent that day again by the same process, so
//   the heal only picks up the Apps not started yet (new collection, failed sends) instead of
//   replaying the chain every interval (B2-15n: or an App whose resume day below moved on, which
//   is then the day pending in its chain and merges into it). A failed send is not remembered
//   (retried on the next heal); a failure of one App does not stop the others; the first failure
//   is rethrown after all Apps were tried.
//   B2-15n (B2-15m money review r2 S2: every new process restarted each App's chain at its first
//   bill day, one download of every past bill per channel): an App with reconciled bill days
//   recorded (infra/pay-recon-days-store.ts, payment's own table, written by each run for the
//   channels it reconciled to the end) is seeded at the day after the earliest, over its
//   channels, of each channel's last reconciled bill day — per App, read from PostgreSQL only, so
//   a new process resumes where the previous one stopped and downloads no reconciled day again; an
//   App with none recorded starts at its first bill day as above. A channel's day left behind
//   (abandoned catch-up, a malformed bill) was alerted then; the chain does not go back to it.
// Also compiled by the `test` project: erasable syntax only.
import { accountingDate } from '@couli/domain';
import { dayAfter } from '../domain/pay-recon.ts';
import { lastReconciledDays } from '../infra/pay-recon-days-store.ts';
import { firstPayRecords } from '../infra/pay-recon-store.ts';
import { scheduleBillRecon, type PayReconDeps } from './pay-recon.ts';

/** What seeding needs: payment's own tables (the Apps), the clock, the pay queue, the logger. */
export type PayReconSeedDeps = Pick<PayReconDeps, 'db' | 'clock' | 'queue' | 'logger'>;

export interface PayReconSeedOptions {
  /**
   * The worker's memory (one per process): App → the bill day its chain was last started from by
   * a send that went through (B2-15n: the day the seed computed then, which moves on as days are
   * reconciled; a heal sends an App again only when it moved, the day then pending in its chain).
   * Left out, every App is sent (a restart's seed).
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
  const reconciled = await lastReconciledDays(deps.db);
  let failure: { readonly error: unknown } | null = null;
  for (const app of apps) {
    const last = reconciled.get(app.app_id);
    const billDate = last === undefined ? accountingDate(app.first_at) : dayAfter(last, now);
    if (options.started?.get(app.app_id) === billDate) continue;
    try {
      await scheduleBillRecon(deps, app.app_id, billDate, now);
      options.started?.set(app.app_id, billDate);
      deps.logger.info(
        { app_id: app.app_id, bill_date: billDate, resumed: last !== undefined },
        'pay_bill_recon_seeded',
      );
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
