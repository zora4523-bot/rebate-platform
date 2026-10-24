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
import { deletePushTokensForUser } from './deletion-cleanup.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

// Real Kysely SQL compilation with an in-memory driver; no socket or database.
async function fixture(affected: bigint) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    return { rows: [] as R[], numAffectedRows: affected };
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

const USER = '019a0000-0000-7000-8000-000000000001';
const AT = new Date('2026-10-24T04:00:00.000Z');

it('[AC-F1-02zzk#1][BR-ID-28] deletion cleanup is one DELETE of push_tokens scoped by app_id and user_id', async () => {
  const f = await fixture(3n);
  const result = await f.db
    .transaction()
    .execute((trx) => deletePushTokensForUser(trx, { appId: 'couli', userId: USER, at: AT }));
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]?.sql).toBe(
    'delete from "app"."push_tokens" where "app_id" = $1 and "user_id" = $2',
  );
  expect(f.queries[0]?.parameters).toEqual(['couli', USER]);
  expect(result).toEqual({ deleted: 3 });
});

it('[AC-F1-02zzk#2][BR-ID-28] a repeated call deletes nothing and does not throw', async () => {
  const f = await fixture(0n);
  const result = await f.db
    .transaction()
    .execute((trx) => deletePushTokensForUser(trx, { appId: 'couli', userId: USER, at: AT }));
  expect(result).toEqual({ deleted: 0 });
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]?.sql).not.toMatch(/inbox_messages|notify_logs|notification_settings/);
});
