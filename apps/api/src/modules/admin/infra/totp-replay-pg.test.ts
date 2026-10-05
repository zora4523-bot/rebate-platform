import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { createPgTotpReplayStore } from './totp-replay-pg.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

// Real Kysely SQL compilation with an in-memory driver; no socket or database.
async function fixture(affected: bigint[]) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    return { rows: [] as R[], numAffectedRows: affected.shift() ?? 0n };
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  }).withSchema('app');
  handles.push(db);
  return { store: createPgTotpReplayStore({ db }), queries };
}

const claim = { appId: 'couli', adminId: '019a0000-0000-7000-8000-000000000001', timeStep: 7n };

it('[AC-F1-06b-REPLAY#2] consumes with one conditional UPDATE of totp_last_step; one row means first use', async () => {
  const f = await fixture([1n, 0n]);
  expect(await f.store.consume(claim)).toBe(true);
  expect(await f.store.consume(claim)).toBe(false);
  expect(f.queries).toHaveLength(2);
  expect(f.queries[0]?.sql).toBe(
    'update "app"."admin_users" set "totp_last_step" = $1 where "app_id" = $2 and "id" = $3 and ("totp_last_step" is null or "totp_last_step" < $4)',
  );
  expect(f.queries[0]?.parameters).toEqual([7n, 'couli', claim.adminId, 7n]);
});
