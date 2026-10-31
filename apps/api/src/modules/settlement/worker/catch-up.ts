// B2-04zg (D10-476): the catch-up of the monthly bill on the worker entry (08 BR-FUND-04 ③,
// BR-FUND-18).
// - settleBillCatchUpPeriod: the latest bill day D* on or before a +08:00 day (settle.bill_day,
//   22–28) and its bill month M = the month before D*'s month.
// - createSettleCatchUpStore: whether the bill of (app, platform, D*) is generated, still queued or
//   neither, read from settle_jobs, settle_bills and pgboss.job (no process memory).
// - seedSettleBillCatchUp: on every tick of the module's timer (the first one after start is the
//   worker's self-heal), for every app × platform whose bill month M is not generated and has no
//   live job, sends D*'s `bill` job again (payload and singletonKey of the daily seed). The bill job
//   keeps bill_id = M and judges the asset snapshot on the day it runs. Earlier periods are never
//   looked at. Time only from the injected Clock.
import type { DB } from '@couli/db';
import { accountingDate, settlementBillPeriod } from '@couli/domain';
import { sql, type Kysely } from 'kysely';
import type { Clock, JobQueue } from '../../platform/index.ts';
import type { SettlementConfigReader } from './ports.ts';
import {
  scheduleSettleBill,
  settleBillJobKey,
  settleBillRunAt,
  type SettleScheduleLogger,
} from './schedule.ts';

/** The period the catch-up looks back at. */
export interface SettleBillCatchUpPeriod {
  /** D*: the latest bill day on or before the given day (YYYY-MM-DD, +08:00). */
  readonly accountingDate: string;
  /** M: the bill month of D* (YYYY-MM, the month before D*'s month). */
  readonly billId: string;
}

const QUEUE = 'settle';
const JOB = 'bill';
const BILL_DAY_KEY = 'settle.bill_day';
const DEFAULT_BILL_DAY = 24;
const MIN_BILL_DAY = 22;
const MAX_BILL_DAY = 28;

function assertBillDay(billDay: number): void {
  if (!Number.isInteger(billDay) || billDay < MIN_BILL_DAY || billDay > MAX_BILL_DAY) {
    throw new RangeError('settle.bill_day must be an integer within 22-28');
  }
}

/**
 * D* and M for the +08:00 day `today` and settle.bill_day `billDay` (an integer 22–28). A malformed
 * or nonexistent day, or a bill day outside 22–28, throws.
 */
export function settleBillCatchUpPeriod(today: string, billDay: number): SettleBillCatchUpPeriod {
  assertBillDay(billDay);
  // Refuses a malformed or nonexistent day (strict YYYY-MM-DD).
  const start = settleBillRunAt(today);
  const dayOfMonth = Number(today.slice(8, 10));
  // On or after the bill day: this month's; before it: the previous month's (bill day ≤ 28 exists
  // in every month).
  const month = dayOfMonth >= billDay ? today.slice(0, 7) : settlementBillPeriod(start);
  const day = `${month}-${String(billDay).padStart(2, '0')}`;
  return { accountingDate: day, billId: settlementBillPeriod(settleBillRunAt(day)) };
}

/**
 * The catch-up state of the bill of (app, platform, D*):
 * - 'generated': settle_jobs holds a done row for (app, 'bill', platform, D* 00:00 +08:00), or
 *   settle_bills holds the bill month M of D* generated with the platform in platform_order_counts;
 * - 'pending': not generated, and a `bill` job under bill:<app_id>:<platform>:<D*> is queued (also
 *   delayed), active or waiting for a retry on queue settle;
 * - 'absent': neither. A completed job does not count as generated (deferred and not_due complete
 *   the delivery too), nor does a failed settle_jobs row, a cancelled job or a settle.dead copy.
 */
export type SettleBillCatchUpState = 'generated' | 'pending' | 'absent';

export interface SettleCatchUpStore {
  /** The state as stored now (no cache across calls, no process memory). */
  billCatchUpStateOf(
    appId: string,
    platform: string,
    accountingDate: string,
  ): Promise<SettleBillCatchUpState>;
}

interface CatchUpRow {
  readonly generated: boolean;
  readonly pending: boolean;
}

/** SettleCatchUpStore over PostgreSQL (couli_app). */
export function createSettleCatchUpStore(db: Kysely<DB>): SettleCatchUpStore {
  return {
    async billCatchUpStateOf(appId, platform, day) {
      if (appId === '' || platform === '') {
        throw new Error('settle catch-up store: app_id and platform must be nonempty');
      }
      // Refuses a malformed or nonexistent D* before a statement runs.
      const runAt = settleBillRunAt(day);
      const billId = settlementBillPeriod(runAt);
      const key = settleBillJobKey(appId, platform, day);
      const { rows } = await sql<CatchUpRow>`
        SELECT
          (EXISTS (
            SELECT 1 FROM app.settle_jobs
            WHERE app_id = ${appId} AND job = ${JOB} AND platform = ${platform}
              AND run_at = ${runAt} AND status = 'done'
          ) OR EXISTS (
            SELECT 1 FROM app.settle_bills
            WHERE app_id = ${appId} AND bill_id = ${billId} AND generated_at IS NOT NULL
              AND jsonb_typeof(platform_order_counts) = 'object'
              AND jsonb_exists(platform_order_counts, ${platform})
          )) AS generated,
          EXISTS (
            SELECT 1 FROM pgboss.job
            WHERE name = ${QUEUE} AND singleton_key = ${key}
              AND state IN ('created', 'retry', 'active')
          ) AS pending
      `.execute(db);
      const row = rows[0];
      if (row?.generated === true) return 'generated';
      if (row?.pending === true) return 'pending';
      return 'absent';
    },
  };
}

export interface SettleBillCatchUpOptions {
  /** couli_app: the apps are the distinct app_id of app.orders. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly logger: SettleScheduleLogger;
  readonly runs: SettleCatchUpStore;
  /** The platforms of every app (union REGISTERED_PLATFORMS). */
  readonly platforms: readonly string[];
  /** content's reader: settle.bill_day of each app (unset: 24). */
  readonly config: SettlementConfigReader;
}

/** settle.bill_day of the app as the bill job reads it: unset → 24; else an integer 22–28. */
async function billDayOf(config: SettlementConfigReader, appId: string): Promise<number> {
  const value = await config.get(appId, BILL_DAY_KEY);
  if (value === undefined || value === null) return DEFAULT_BILL_DAY;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[0-9]+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  assertBillDay(parsed);
  return parsed;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * The catch-up: for every app, D* of the +08:00 day of clock.now() under the app's settle.bill_day;
 * every platform whose state is 'absent' gets D*'s `bill` job (outside a transaction). A failure of
 * one app (its configuration or a send) does not stop the others; the first failure is rethrown
 * after all of them.
 */
export async function seedSettleBillCatchUp(options: SettleBillCatchUpOptions): Promise<void> {
  const { db, clock, queue, logger, runs, platforms, config } = options;
  const today = accountingDate(clock.now());
  const apps = await db
    .withSchema('app')
    .selectFrom('orders')
    .select('app_id')
    .distinct()
    .orderBy('app_id')
    .execute();
  const failures: unknown[] = [];
  for (const { app_id: appId } of apps) {
    let period: SettleBillCatchUpPeriod;
    try {
      period = settleBillCatchUpPeriod(today, await billDayOf(config, appId));
    } catch (error: unknown) {
      failures.push(error);
      logger.warn(
        { job: JOB, app_id: appId, today, error_name: errorName(error) },
        'settle_bill_catch_up_config_failed',
      );
      continue;
    }
    for (const platform of platforms) {
      try {
        const state = await runs.billCatchUpStateOf(appId, platform, period.accountingDate);
        if (state !== 'absent') continue;
        await scheduleSettleBill(queue, null, {
          appId,
          platform,
          accountingDate: period.accountingDate,
        });
        logger.info(
          {
            job: JOB,
            app_id: appId,
            platform,
            accounting_date: period.accountingDate,
            bill_id: period.billId,
          },
          'settle_bill_catch_up_sent',
        );
      } catch (error: unknown) {
        failures.push(error);
        logger.warn(
          {
            job: JOB,
            app_id: appId,
            platform,
            accounting_date: period.accountingDate,
            error_name: errorName(error),
          },
          'settle_bill_catch_up_failed',
        );
      }
    }
  }
  if (failures.length > 0) throw failures[0];
}
