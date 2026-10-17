import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { createRecordInitialLevel, type InitialLevelLog } from './initial-level-log.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

async function fixture(rows: unknown[], error?: Error) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    if (error !== undefined) throw error;
    return { rows: rows as R[] };
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
  return { db, queries };
}

const input = { app_id: 'couli', user_id: 'user', level: 'L3', source: 'register' } as const;
const createdAt = new FixedClock('2026-10-20T02:00:00.123Z').now();

it('[AC-B1-11b#22] adapter reads the account in the same transaction and forwards its creation instant', async () => {
  const f = await fixture([{ created_at: createdAt }]);
  const append = vi.fn<InitialLevelLog['append']>(async () => undefined);
  await f.db.transaction().execute(async (trx) => {
    await createRecordInitialLevel({ append })(trx, input);
    expect(append).toHaveBeenCalledExactlyOnceWith(trx, {
      app_id: 'couli',
      user_id: 'user',
      to_level: 'L3',
      effective_at: createdAt,
    });
  });
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]?.sql).toBe(
    'select "created_at" from "app"."users" where "app_id" = $1 and "id" = $2',
  );
  expect(f.queries[0]?.parameters).toEqual(['couli', 'user']);
});

it('[AC-B1-11b#24] missing user rejects before append', async () => {
  const f = await fixture([]);
  const append = vi.fn<InitialLevelLog['append']>(async () => undefined);
  await expect(
    f.db.transaction().execute((trx) => createRecordInitialLevel({ append })(trx, input)),
  ).rejects.toThrow('registration user not found');
  expect(append).not.toHaveBeenCalled();
});

it('[AC-B1-11b#23] append failure is propagated to registration for whole-creation rollback', async () => {
  const f = await fixture([{ created_at: createdAt }]);
  const failure = new Error('append failed');
  const append = vi.fn<InitialLevelLog['append']>(async () => {
    throw failure;
  });
  await expect(
    f.db.transaction().execute((trx) => createRecordInitialLevel({ append })(trx, input)),
  ).rejects.toBe(failure);
  expect(append).toHaveBeenCalledTimes(1);
});

it('[AC-B1-11b#24] a database read failure is propagated without append', async () => {
  const failure = new Error('read failed');
  const f = await fixture([], failure);
  const append = vi.fn<InitialLevelLog['append']>(async () => undefined);
  await expect(
    f.db.transaction().execute((trx) => createRecordInitialLevel({ append })(trx, input)),
  ).rejects.toBe(failure);
  expect(append).not.toHaveBeenCalled();
});
