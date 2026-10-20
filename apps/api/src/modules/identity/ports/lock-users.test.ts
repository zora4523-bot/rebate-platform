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
import { lockUsersForUpdate } from './lock-users.ts';

const APP = 'couli';
const A = '019a0000-0000-7000-8000-000000000001';
const B = '019a0000-0000-7000-8000-000000000002';

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

it('[AC-B1-02zf] empty request runs no query and returns an empty set', async () => {
  const caller = stubDb();
  await expect(lockUsersForUpdate(caller.db, { appId: APP, userIds: [] })).resolves.toEqual(
    new Set(),
  );
  expect(caller.queries).toEqual([]);
});

it('[AC-B1-02zf] one select of id ordered by id FOR NO KEY UPDATE, deduplicated IDs', async () => {
  const caller = stubDb([{ id: A }]);
  const userIds = Object.freeze([B, A, B, A]);
  await expect(lockUsersForUpdate(caller.db, { appId: APP, userIds })).resolves.toEqual(
    new Set([A]),
  );
  expect(caller.queries).toHaveLength(1);
  expect(caller.queries[0]!.sql).toBe(
    'select "id" from "app"."users" where "app_id" = $1 and "id" = ANY($2) order by "id" for no key update',
  );
  expect(caller.queries[0]!.parameters).toEqual([APP, [B, A]]);
  expect(userIds).toEqual([B, A, B, A]);
});

it('[AC-B1-02zf] runs on the transaction the caller passes', async () => {
  const caller = stubDb([{ id: A }, { id: B }]);
  const locked = await caller.db
    .transaction()
    .execute((trx) => lockUsersForUpdate(trx, { appId: APP, userIds: [A, B] }));
  expect(locked).toEqual(new Set([A, B]));
  expect(caller.queries.map((q) => q.sql)).toEqual([
    'select "id" from "app"."users" where "app_id" = $1 and "id" = ANY($2) order by "id" for no key update',
  ]);
});
