// B2-02r: DailyCheckRunStore over PostgreSQL (couli_app). stateOf reads the `daily` jobs of queue
// ledger-check under singletonKey daily:<app_id>:<D> (pgboss.job, plain read-only SQL; ADR-0001 §3
// 排查用普通 SQL): a completed job is the check's record of a completed run (the handler completes
// only after the run, its execution step and the enqueue of D+1 succeeded); ledger-check.dead
// copies are not pending (other queue name). claimOverdueAlert stores the claim durably in
// app.processed_events (consumer ledger.daily_check_overdue_alert, event_id a name-based uuid of
// (app, D); INSERT … ON CONFLICT DO NOTHING: one winner under concurrency). The store holds no
// state in memory: a new instance (a restarted worker) answers the same.
import { createHash } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type {
  DailyCheckRunState,
  DailyCheckRunStore,
} from '../application/daily-check-schedule-heal.ts';
import {
  dailyCheckJobKey,
  dailyCheckRunAtMs,
  type DailyCheckQueue,
} from '../application/daily-check-schedule.ts';
import { LedgerError } from '../application/errors.ts';

const QUEUE: DailyCheckQueue = 'ledger-check';
/** processed_events consumer of the one overdue alert per (app, D). */
const OVERDUE_ALERT_CONSUMER = 'ledger.daily_check_overdue_alert';
/** Fixed namespace of the alert's event ids (RFC 4122 name-based, version 5). */
const OVERDUE_ALERT_NAMESPACE = '3f0c8d52-6a1e-5b7f-9c24-d81e0a4b6c3e';

function validKey(appId: string, accountingDate: string): void {
  if (typeof appId !== 'string' || appId === '') {
    throw new LedgerError('INVALID_INPUT', 'app_id must be a non-empty string');
  }
  // Throws INVALID_INPUT for anything but a strict, existing YYYY-MM-DD.
  dailyCheckRunAtMs(accountingDate);
}

/** RFC 4122 version 5 uuid of `name` in `namespace`. */
function uuidV5(namespace: string, name: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
      validKey(appId, accountingDate);
      const { rows } = await sql<StateRow>`
        SELECT
          COALESCE(bool_or(state = 'completed'), false) AS done,
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
      validKey(appId, accountingDate);
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
