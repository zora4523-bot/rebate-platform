import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import { createUserDeletionStatusReader } from './user-deletion-status.ts';

const APP = 'couli';
const A = '019a0000-0000-7000-8000-000000000001';
const B = '019a0000-0000-7000-8000-000000000002';
const C = '019a0000-0000-7000-8000-000000000003';
const D = '019a0000-0000-7000-8000-000000000004';

/** A Kysely whose driver records each compiled statement and answers with the given rows. */
function stubDb(rows: readonly Record<string, unknown>[] = []): {
  db: Kysely<DB>;
  queries: CompiledQuery[];
} {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query);
      return { rows: rows as R[] };
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}

it('[AC-B1-02ze] one select of id, status from app.users on the caller executor, deduplicated IDs', async () => {
  const factory = stubDb();
  const caller = stubDb();
  const reader = createUserDeletionStatusReader({ db: factory.db });
  await expect(reader.read(caller.db, { app_id: APP, user_ids: [A, B, A] })).resolves.toEqual(
    new Map(),
  );
  expect(factory.queries).toEqual([]);
  expect(caller.queries).toHaveLength(1);
  expect(caller.queries[0]!.sql).toBe(
    'select "id", "status" from "app"."users" where "app_id" = $1 and "id" = ANY($2)',
  );
  expect(caller.queries[0]!.parameters).toEqual([APP, [A, B]]);
});

it('[AC-B1-02ze] maps deleting → processing, deleted → done, any other status → none', async () => {
  const caller = stubDb([
    { id: A, status: 'normal' },
    { id: B, status: 'deleting' },
    { id: C, status: 'deleted' },
    { id: D, status: 'synthetic_other' },
  ]);
  const reader = createUserDeletionStatusReader({ db: stubDb().db });
  const result = await reader.read(caller.db, { app_id: APP, user_ids: [A, B, C, D] });
  expect(result).toEqual(
    new Map([
      [A, 'none'],
      [B, 'processing'],
      [C, 'done'],
      [D, 'none'],
    ]),
  );
});

it('[AC-B1-02ze] an empty ID list returns an empty map without any SQL', async () => {
  const factory = stubDb();
  const caller = stubDb();
  const reader = createUserDeletionStatusReader({ db: factory.db });
  const result = await reader.read(caller.db, { app_id: APP, user_ids: [] });
  expect(result).toBeInstanceOf(Map);
  expect(result.size).toBe(0);
  expect(factory.queries).toEqual([]);
  expect(caller.queries).toEqual([]);
});
