// B2-07d: the real ReconPassedDaysPort of the BR-WDR-30 开启前置检查 (编排裁定 D10-392, D10-408):
// from app.payout_recon_runs, the consecutive days of the app's Alipay reconciliation that ran
// through (status succeeded; diffs found do not break the run), counted back from the +08:00
// accounting day before the injected Clock's now. partial, failed or a missing day stops the count;
// today's row is neither counted nor a break. Read only, on the caller's handle. No window: the
// owner's recon_required_days may be any size, so every row up to 「昨日」 is read.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { ReconPassedDaysPort } from './auto-config.ts';
import { PAYOUT_RECON_CHANNEL, previousReconDay, reconDayBefore } from './recon-schedule.ts';

export interface ReconPassedDaysOptions {
  readonly clock: Clock;
}

export function createReconPassedDays(options: ReconPassedDaysOptions): ReconPassedDaysPort {
  return {
    async passedDays(appId: string, handle: Kysely<DB>): Promise<number> {
      const now = options.clock.now();
      const yesterday = previousReconDay(now);
      const rows = await handle
        .withSchema('app')
        .selectFrom('payout_recon_runs')
        .select([sql<string>`to_char(bill_date, 'YYYY-MM-DD')`.as('bill_day'), 'status'])
        .where('app_id', '=', appId)
        .where('channel', '=', PAYOUT_RECON_CHANNEL)
        .where('bill_date', '<=', sql<Date>`${yesterday}::date`)
        .orderBy('bill_date', 'desc')
        .execute();
      let days = 0;
      let expected = yesterday;
      for (const row of rows) {
        if (row.bill_day !== expected || row.status !== 'succeeded') break;
        days += 1;
        expected = reconDayBefore(expected, now);
      }
      return days;
    },
  };
}
