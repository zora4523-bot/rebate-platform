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
import { createRealnameStatusBatchReader } from './realname-status-batch.ts';

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

it('[AC-B1-02zf] empty request and construction run no query', async () => {
  const factory = stubDb();
  const caller = stubDb();
  const reader = createRealnameStatusBatchReader({ db: factory.db });
  await expect(reader.read(caller.db, { appId: APP, userIds: [] })).resolves.toEqual(new Map());
  expect(factory.queries).toEqual([]);
  expect(caller.queries).toEqual([]);
});

it('[AC-B1-02zf] one users left join realname select on the caller executor, deduplicated IDs', async () => {
  const factory = stubDb();
  const caller = stubDb();
  const reader = createRealnameStatusBatchReader({ db: factory.db });
  await reader.read(caller.db, { appId: APP, userIds: [B, A, B] });
  expect(factory.queries).toEqual([]);
  expect(caller.queries).toHaveLength(1);
  expect(caller.queries[0]!.sql).toBe(
    'select "app"."users"."id", "app"."realname"."status" from "app"."users"' +
      ' left join "app"."realname" on "app"."realname"."user_id" = "app"."users"."id"' +
      ' and "app"."realname"."app_id" = "app"."users"."app_id"' +
      ' where "app"."users"."app_id" = $1 and "app"."users"."id" = ANY($2)',
  );
  expect(caller.queries[0]!.parameters).toEqual([APP, [B, A]]);
});

it('[AC-B1-02zf] maps statuses as stored and a missing realname row to none', async () => {
  const caller = stubDb([
    { id: A, status: 'none' },
    { id: B, status: 'verified' },
    { id: C, status: 'failed' },
    { id: D, status: null },
  ]);
  const reader = createRealnameStatusBatchReader({ db: stubDb().db });
  await expect(reader.read(caller.db, { appId: APP, userIds: [A, B, C, D] })).resolves.toEqual(
    new Map([
      [A, 'none'],
      [B, 'verified'],
      [C, 'failed'],
      [D, 'none'],
    ]),
  );
});

it('[AC-B1-02zf] a status outside the CHECK is a broken database and throws', async () => {
  const caller = stubDb([{ id: A, status: 'synthetic_corrupt' }]);
  const reader = createRealnameStatusBatchReader({ db: stubDb().db });
  await expect(reader.read(caller.db, { appId: APP, userIds: [A] })).rejects.toThrow(
    'identity: unknown realname status',
  );
});
