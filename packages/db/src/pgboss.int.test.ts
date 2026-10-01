// pg-boss on the migration-installed schema, as couli_app with `migrate: false`
// (ADR-0001 §4.2 #14, §7).
import { randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import { fromKysely, PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, destroyDb, type DB } from './index.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';

class Rollback extends Error {}

describe('pg-boss as couli_app on the migrated schema', () => {
  const queue = 'skeleton-check';
  let database: TestDatabase;
  let db: Kysely<DB>;
  let boss: PgBoss;
  const bossErrors: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
    boss = new PgBoss({
      connectionString: database.urlFor('couli_app'),
      schema: 'pgboss',
      migrate: false,
      max: 2,
    });
    boss.on('error', (error) => {
      bossErrors.push(String(error));
    });
    await boss.start();
    await boss.createQueue(queue);
  });

  afterAll(async () => {
    await boss.stop({ graceful: false });
    await destroyDb(db);
    await database.drop();
  });

  it('the installed schema version is the one the pg-boss library expects', async () => {
    const result = await sql<{ version: number }>`SELECT version FROM pgboss.version`.execute(db);
    expect(result.rows).toEqual([{ version: 42 }]);
    expect(await boss.isInstalled()).toBe(true);
    expect(await boss.schemaVersion()).toBe(42);
  });

  it('the installed schema has no date-dependent partitions', async () => {
    // pg-boss creates queue_stats day partitions at install time; the migration drops them.
    const result = await sql<{ relname: string }>`
      SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'pgboss.queue_stats'::regclass
    `.execute(db);
    expect(result.rows).toEqual([]);
  });

  it('sends, fetches and completes a job', async () => {
    const id = await boss.send(queue, { hello: 'world' });
    expect(id).toEqual(expect.any(String));
    const jobs = await boss.fetch<{ hello: string }>(queue);
    expect(jobs.map((job) => ({ id: job.id, data: job.data }))).toEqual([
      { id, data: { hello: 'world' } },
    ]);
    await boss.complete(queue, id ?? '');
    const done = await boss.getJobById(queue, id ?? '');
    expect(done?.state).toBe('completed');
  });

  it('a job sent inside a rolled-back Kysely transaction does not exist afterwards', async () => {
    const eventId = randomUUID();
    let sentId: string | null = null;
    const outcome = await db
      .transaction()
      .execute(async (trx) => {
        await trx
          .insertInto('processed_events')
          .values({ consumer: 'tx', event_id: eventId })
          .execute();
        sentId = await boss.send(queue, { eventId }, { db: fromKysely(trx) });
        throw new Rollback();
      })
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Rollback);
    expect(sentId).toEqual(expect.any(String));
    expect(await boss.getJobById(queue, sentId ?? '')).toBeNull();
    const business = await db
      .selectFrom('processed_events')
      .select('consumer')
      .where('event_id', '=', eventId)
      .execute();
    expect(business).toEqual([]);
  });

  it('a job sent inside a committed Kysely transaction exists together with the business row', async () => {
    const eventId = randomUUID();
    const sentId = await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('processed_events')
        .values({ consumer: 'tx', event_id: eventId })
        .execute();
      return boss.send(queue, { eventId }, { db: fromKysely(trx) });
    });
    const job = await boss.getJobById<{ eventId: string }>(queue, sentId ?? '');
    expect(job?.data).toEqual({ eventId });
    const business = await db
      .selectFrom('processed_events')
      .select('consumer')
      .where('event_id', '=', eventId)
      .execute();
    expect(business).toEqual([{ consumer: 'tx' }]);
  });

  it('pg-boss reported no background errors with table-only privileges', () => {
    expect(bossErrors).toEqual([]);
  });

  it('couli_app cannot change the pgboss schema', async () => {
    const attempt = await sql`CREATE TABLE pgboss.sneaky (id int)`
      .execute(db)
      .then(() => 'no error')
      .catch((error: unknown) => (error as { code?: string }).code ?? 'no code');
    expect(attempt).toBe('42501');
  });
});
