import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { fromKysely, type JobWithMetadata, type PgBoss } from 'pg-boss';
import type { JobPayload } from './types.ts';

interface Envelope {
  name: string;
  payload: JobPayload;
}

export interface ClaimedJob extends JobWithMetadata<Envelope> {
  startedOnExact: string;
}

// Schema 42 dependencies: pgboss.job(name, id, state, retry_count, started_on).
// Only non-partitioned queues are allowed. Keep started_on as PostgreSQL text:
// the pg Date decoder loses microseconds, so its startedOn cannot identify a lease exactly.
export async function fetchAttempt(
  db: Kysely<DB>,
  boss: PgBoss,
  queue: string,
): Promise<ClaimedJob[]> {
  return db.transaction().execute(async (trx) => {
    const jobs = await boss.fetch<Envelope>(queue, {
      batchSize: 1,
      includeMetadata: true,
      db: fromKysely(trx),
    });
    const claimed: ClaimedJob[] = [];
    for (const job of jobs) {
      // fetch's UPDATE holds this row lock until commit; supervision cannot replace
      // the attempt between the claim and reading its full-precision timestamp.
      const { rows } = await sql<{ startedOnExact: string }>`
        SELECT started_on::text AS "startedOnExact" FROM pgboss.job
        WHERE name = ${queue} AND id = ${job.id}::uuid
      `.execute(trx);
      if (!rows[0]) throw new Error('queue_claim_missing');
      claimed.push({ ...job, startedOnExact: rows[0].startedOnExact });
    }
    return claimed;
  });
}

/** Lock, check ownership and settle on ONE connection; never change another attempt. */
export async function settleAttempt(
  db: Kysely<DB>,
  boss: PgBoss,
  queue: string,
  job: ClaimedJob,
  succeeded: boolean,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM pgboss.job
      WHERE name = ${queue} AND id = ${job.id}::uuid AND state = 'active'
        AND retry_count = ${job.retryCount}
        AND started_on = ${job.startedOnExact}::timestamptz
      FOR UPDATE
    `.execute(trx);
    if (rows.length === 0) return false;
    const options = { db: fromKysely(trx) };
    if (succeeded) await boss.complete(queue, job.id, undefined, options);
    // pg-boss still owns retry scheduling and dead-letter insertion. Never store errors.
    else await boss.fail(queue, job.id, { error: 'handler_failed' }, options);
    return true;
  });
}
