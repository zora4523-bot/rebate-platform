// B2-02r: DailyCheckRunStore over PostgreSQL (couli_app). stateOf reads the `daily` jobs of queue
// ledger-check under singletonKey daily:<app_id>:<D> (pgboss.job, plain read-only SQL; ADR-0001 §3
// 排查用普通 SQL): a completed job is the check's record of a completed run (the handler completes
// only after the run, its execution step and the enqueue of D+1 succeeded); ledger-check.dead
// copies are not pending (other queue name). B2-02s: the completion record of (app, D) in
// app.processed_events (consumer ledger.daily_check_done) makes it done whatever the queue holds.
// claimOverdueAlert stores the claim durably in
// app.processed_events (consumer ledger.daily_check_overdue_alert, event_id a name-based uuid of
// (app, D); INSERT … ON CONFLICT DO NOTHING: one winner under concurrency). The store holds no
// state in memory: a new instance (a restarted worker) answers the same.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type {
  DailyCheckRunState,
  DailyCheckRunStore,
} from '../application/daily-check-schedule-heal.ts';
import {
  DAILY_CHECK_DONE_CONSUMER,
  dailyCheckDoneEventId,
  uuidV5,
  validDailyCheckKey,
} from '../application/daily-check-schedule-done.ts';
import { dailyCheckJobKey, type DailyCheckQueue } from '../application/daily-check-schedule.ts';

const QUEUE: DailyCheckQueue = 'ledger-check';
/** processed_events consumer of the one overdue alert per (app, D). */
const OVERDUE_ALERT_CONSUMER = 'ledger.daily_check_overdue_alert';
/** Fixed namespace of the alert's event ids (RFC 4122 name-based, version 5). */
const OVERDUE_ALERT_NAMESPACE = '3f0c8d52-6a1e-5b7f-9c24-d81e0a4b6c3e';

/** The alert's event id of (app, D): the same in every process. */
function overdueAlertEventId(appId: string, accountingDate: string): string {
  return uuidV5(OVERDUE_ALERT_NAMESPACE, JSON.stringify([appId, accountingDate]));
}

interface StateRow {
  readonly done: boolean;
  readonly pending: boolean;
}

export function createDailyCheckRunStore(db: Kysely<DB>): DailyCheckRunStore {
  return {
    async stateOf(appId, accountingDate): Promise<DailyCheckRunState> {
      validDailyCheckKey(appId, accountingDate);
      // B2-02s: the completion record the handler wrote counts first — an attempt judged failed
      // after expireInSeconds may have finished its work (its jobs only failed / dead-lettered).
      const { rows } = await sql<StateRow>`
        SELECT
          (EXISTS (
            SELECT 1 FROM app.processed_events
            WHERE consumer = ${DAILY_CHECK_DONE_CONSUMER}
              AND event_id = ${dailyCheckDoneEventId(appId, accountingDate)}::uuid
          ) OR COALESCE(bool_or(state = 'completed'), false)) AS done,
          COALESCE(bool_or(state IN ('created', 'retry', 'active')), false) AS pending
        FROM pgboss.job
        WHERE name = ${QUEUE} AND singleton_key = ${dailyCheckJobKey(appId, accountingDate)}
      `.execute(db);
      const row = rows[0];
      if (row?.done === true) return 'done';
      if (row?.pending === true) return 'pending';
      return 'absent';
    },
    async claimOverdueAlert(appId, accountingDate): Promise<boolean> {
      validDailyCheckKey(appId, accountingDate);
      const inserted = await db
        .withSchema('app')
        .insertInto('processed_events')
        .values({
          consumer: OVERDUE_ALERT_CONSUMER,
          event_id: overdueAlertEventId(appId, accountingDate),
        })
        .onConflict((oc) => oc.columns(['consumer', 'event_id']).doNothing())
        .returning('event_id')
        .executeTakeFirst();
      return inserted !== undefined;
    },
  };
}
