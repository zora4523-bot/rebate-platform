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
import { bindPushTokensForSession, unbindPushTokensForSession } from './session-bindings.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

// Real Kysely SQL compilation with an in-memory driver; no socket or database.
async function fixture() {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    return { rows: [] as R[], numAffectedRows: 0n };
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
  return { db, queries, clock: new FixedClock('2026-10-08T04:00:00.000Z') };
}

const USER = '019a0000-0000-7000-8000-000000000001';
const DEVICE = '019a0000-0000-7000-8000-000000000002';

it('[AC-S1-76#6][BR-ID-07] login binding is one UPDATE of the device rows that are live and not frozen at the Clock', async () => {
  const f = await fixture();
  await f.db
    .transaction()
    .execute((trx) =>
      bindPushTokensForSession(
        trx,
        { app_id: 'couli', user_id: USER, device_id: DEVICE, sid: 'S2' },
        f.clock,
      ),
    );
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]?.sql).toBe(
    'update "app"."push_tokens" set "user_id" = $1, "bound_sid" = $2, "row_version" = "row_version" + $3, "updated_at" = $4 where "app_id" = $5 and "device_id" = $6 and "revoked_at" is null and ("frozen_until" is null or "frozen_until" <= $7)',
  );
  expect(f.queries[0]?.parameters).toEqual([
    USER,
    'S2',
    1,
    f.clock.now(),
    'couli',
    DEVICE,
    f.clock.now(),
  ]);
});

it('[AC-S1-76#2][BR-ID-07] unbinding is one conditional UPDATE on (app_id, user_id, bound_sid), never by device', async () => {
  const f = await fixture();
  await f.db
    .transaction()
    .execute((trx) =>
      unbindPushTokensForSession(trx, { app_id: 'couli', user_id: USER, sid: 'S1' }, f.clock),
    );
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]?.sql).toBe(
    'update "app"."push_tokens" set "user_id" = $1, "bound_sid" = $2, "row_version" = "row_version" + $3, "updated_at" = $4 where "app_id" = $5 and "user_id" = $6 and "bound_sid" = $7',
  );
  expect(f.queries[0]?.parameters).toEqual([null, null, 1, f.clock.now(), 'couli', USER, 'S1']);
  expect(f.queries[0]?.sql).not.toContain('device_id');
});
