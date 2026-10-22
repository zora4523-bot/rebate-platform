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
import { FixedClock } from '../../platform/index.ts';
import { createPushSessionValidity } from './push-session-validity.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

// Real Kysely SQL compilation with an in-memory driver; no socket or database.
async function fixture(rows: unknown[] = []) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    return { rows: rows as R[], numAffectedRows: 0n };
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  handles.push(db);
  return { db, queries, clock: new FixedClock('2026-10-22T04:00:00.000Z') };
}

const USER = '019a0000-0000-7000-8000-000000000001';

it('[AC-B1-12o#25] an empty sid list returns an empty set without querying', async () => {
  const f = await fixture([{ sid: 'S1' }]);
  const read = createPushSessionValidity(f.clock);
  expect([...(await read(f.db, { app_id: 'couli', user_id: USER, sids: [] }))]).toEqual([]);
  expect(f.queries).toHaveLength(0);
});

it('[AC-B1-12o#20] one app-scoped SELECT: recipient, deduplicated sids, unrevoked, unrotated refresh after now', async () => {
  const f = await fixture([{ sid: 'S1' }]);
  const read = createPushSessionValidity(f.clock);
  const result = await read(f.db, { app_id: 'couli', user_id: USER, sids: ['S1', 'S1', 'S2'] });
  expect([...result]).toEqual(['S1']);
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]?.sql).toBe(
    'select "s"."sid" from "app"."sessions" as "s" where "s"."app_id" = $1 and "s"."user_id" = $2 and "s"."sid" in ($3, $4) and "s"."revoked_at" is null and exists (select "r"."id" from "app"."refresh_tokens" as "r" where "r"."app_id" = "s"."app_id" and "r"."sid" = "s"."sid" and "r"."rotated_at" is null and "r"."expire_at" > $5)',
  );
  expect(f.queries[0]?.parameters).toEqual(['couli', USER, 'S1', 'S2', f.clock.now()]);
});

it('[AC-B1-12o#22] each read takes the Clock again', async () => {
  const f = await fixture();
  const read = createPushSessionValidity(f.clock);
  await read(f.db, { app_id: 'couli', user_id: USER, sids: ['S1'] });
  f.clock.advanceMs(1);
  await read(f.db, { app_id: 'couli', user_id: USER, sids: ['S1'] });
  expect(f.queries.map((q) => q.parameters.at(-1))).toEqual([
    new Date('2026-10-22T04:00:00.000Z'),
    new Date('2026-10-22T04:00:00.001Z'),
  ]);
});
