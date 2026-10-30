// Shared helpers of the B1-15za rule tests (08 BR-ID-30 ⑤; contract in
// apps/api/src/modules/platform/queue/idempotency-purge.ts). Expected values are written out by hand
// from the contract, never taken from the implementation: a skeleton exports no constants.
// Nothing here imports the test-database base (`@couli/db/testing`): only *.int.test.ts may.
import { sql, type Kysely } from 'kysely';
import type { DB } from '@couli/db';
import { DAY_MS, USER_A, isoPlus } from '../idempotency/kit.ts';
import { reduceLine } from '../queue/kit.ts';

export const QUEUE = 'idempotency-purge';
/** 04:00 +08:00 in UTC (BR-ID-30). */
export const SCHEDULE_ROW = { name: QUEUE, key: '', cron: '0 20 * * *', timezone: 'UTC' };
export const PURGED = 'idempotency_purged';

/** Years after any wall clock of a test run: only an injected clock has passed these expiries. */
export const NOW = '2031-04-05T06:07:08.000Z';

const REQUEST_HASH = 'd'.repeat(64);
/** Stored in every completed row; must never reach a log line. */
export const RESPONSE_MARKER = 'purge-response-body';
const RESPONSE = JSON.stringify({ status: 200, body: `{"msg":"${RESPONSE_MARKER}"}` });

export type KeyStatus = 'processing' | 'completed' | 'abandoned';

export interface KeyRow {
  readonly key: string;
  readonly status: KeyStatus;
  readonly expire: string;
  readonly method?: string;
  readonly path?: string;
  readonly created?: string;
}

export async function insertKey(db: Kysely<DB>, row: KeyRow): Promise<void> {
  const abandoned = row.status === 'abandoned';
  await sql`
    INSERT INTO app.idempotency_keys
      (app_id, subject, user_id, method, path, key, request_hash, status, response, expire_at, created_at)
    VALUES ('couli', ${`u:${USER_A}`}, ${USER_A}::uuid, ${row.method ?? 'POST'},
      ${row.path ?? '/v1/links/x/open'}, ${row.key}, ${abandoned ? null : REQUEST_HASH}, ${row.status},
      ${row.status === 'completed' ? RESPONSE : null}::jsonb,
      ${row.expire}::timestamptz, ${row.created ?? NOW}::timestamptz)
  `.execute(db);
}

/**
 * Rows around `now`: every status one millisecond past its expiry (gone) and a day before it
 * (kept), a row whose old created_at must not count against a later expiry, and the 'infinity'
 * rows of the two operations BR-ID-30 ⑤ excepts, in both of their stored statuses.
 */
export async function seedKeys(
  db: Kysely<DB>,
  now: string,
): Promise<{ gone: string[]; kept: string[] }> {
  const past = isoPlus(now, -1);
  const future = isoPlus(now, DAY_MS);
  const rows: (KeyRow & { keep: boolean })[] = [
    { key: 'purge_past_processing', status: 'processing', expire: past, keep: false },
    { key: 'purge_past_completed', status: 'completed', expire: past, keep: false },
    { key: 'purge_past_abandoned', status: 'abandoned', expire: past, keep: false },
    { key: 'purge_future_processing', status: 'processing', expire: future, keep: true },
    { key: 'purge_future_completed', status: 'completed', expire: future, keep: true },
    { key: 'purge_future_abandoned', status: 'abandoned', expire: future, keep: true },
    {
      key: 'purge_old_created',
      status: 'completed',
      expire: future,
      created: isoPlus(now, -90 * DAY_MS),
      keep: true,
    },
    {
      key: 'purge_withdrawal_completed',
      status: 'completed',
      expire: 'infinity',
      path: '/v1/withdrawals',
      keep: true,
    },
    {
      key: 'purge_withdrawal_abandoned',
      status: 'abandoned',
      expire: 'infinity',
      path: '/v1/withdrawals',
      keep: true,
    },
    {
      key: 'purge_payout_account_completed',
      status: 'completed',
      expire: 'infinity',
      method: 'PUT',
      path: '/v1/me/payout-account',
      keep: true,
    },
    {
      key: 'purge_payout_account_abandoned',
      status: 'abandoned',
      expire: 'infinity',
      method: 'PUT',
      path: '/v1/me/payout-account',
      keep: true,
    },
  ];
  for (const row of rows) await insertKey(db, row);
  return {
    gone: rows.filter((row) => !row.keep).map((row) => row.key),
    kept: rows.filter((row) => row.keep).map((row) => row.key),
  };
}

/** Every key left in the table, sorted like a default Array#sort. */
export async function leftKeys(db: Kysely<DB>): Promise<string[]> {
  const result = await sql<{ key: string }>`
    SELECT key FROM app.idempotency_keys ORDER BY key COLLATE "C"
  `.execute(db);
  return result.rows.map((row) => row.key);
}

export async function purgeSchedules(db: Kysely<DB>): Promise<unknown[]> {
  return (
    await sql`SELECT name, key, cron, timezone FROM pgboss.schedule WHERE name = ${QUEUE}`.execute(
      db,
    )
  ).rows;
}

export async function purgeQueues(db: Kysely<DB>): Promise<unknown[]> {
  return (
    await sql`
      SELECT policy, retry_limit, retry_backoff, dead_letter, partition
      FROM pgboss.queue WHERE name = ${QUEUE}
    `.execute(db)
  ).rows;
}

/**
 * Delivers the registered schedule's exact data without waiting for 04:00. pg-boss's cron copies a
 * queue's settings into each job it sends, and the plain column defaults are not those settings
 * (retry_limit 2), so the same columns are copied here: a test-invented job could not show that
 * the queue itself forbids a retry.
 */
export async function deliverTick(db: Kysely<DB>): Promise<string[]> {
  const delivered = await sql<{ id: string }>`
    INSERT INTO pgboss.job (name, data, policy, retry_limit, retry_delay, retry_backoff,
      retry_delay_max, expire_seconds, deletion_seconds, dead_letter)
    SELECT s.name, s.data, q.policy, q.retry_limit, q.retry_delay, q.retry_backoff,
      q.retry_delay_max, q.expire_seconds, q.deletion_seconds, q.dead_letter
    FROM pgboss.schedule s JOIN pgboss.queue q ON q.name = s.name
    WHERE s.name = ${QUEUE}
    RETURNING id
  `.execute(db);
  return delivered.rows.map((row) => row.id);
}

/** The expected reduced line (queue/kit.ts reduceLine) of a tick that deleted `deleted` rows. */
export function purgedLine(deleted: number): Record<string, unknown> {
  return { level: 30, entry: 'worker', env: 'test', deleted, msg: PURGED };
}

/** The reduced `msg` lines of memoryLogger's raw lines. */
export function linesOf(lines: readonly string[], msg: string): unknown[] {
  return lines
    .map((raw) => reduceLine(raw))
    .filter((line) => typeof line === 'object' && line['msg'] === msg);
}
