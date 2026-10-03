// Smoke test of the integration-test wiring of the rule-test package (ADR-0001 §4.2 #9): rule
// and acceptance tests that need PostgreSQL run through test/vitest.integration.config.ts, get
// their own clone of the migrated template from `@couli/db/testing`, and connect as a business
// role whose grants are real. It also keeps this package's `test:int` run non-empty
// (vitest.shared.ts sets passWithNoTests to false) until the first such rule test arrives.
// Top-level it() only (规划/11 §4.3).
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

it('connects to its own migrated test database as couli_app, never as a superuser', async () => {
  expect(process.env['TEST_PG_ADMIN_URL']).toBeUndefined();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  try {
    const who = await sql<{ current_user: string; is_superuser: string; database: string }>`
      SELECT current_user, current_setting('is_superuser') AS is_superuser,
             current_database() AS database
    `.execute(db);
    expect(who.rows).toEqual([
      { current_user: 'couli_app', is_superuser: 'off', database: database.name },
    ]);
    const keys = await db
      .selectFrom('idempotency_keys')
      .select((eb) => eb.fn.countAll<bigint>().as('n'))
      .executeTakeFirstOrThrow();
    expect(keys.n).toBe(0n);
    await expect(sql`CREATE TABLE app.smoke_ddl (id int)`.execute(db)).rejects.toMatchObject({
      code: '42501',
    });
  } finally {
    await destroyDb(db);
  }
});
