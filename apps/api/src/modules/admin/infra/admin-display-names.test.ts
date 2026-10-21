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
import { createAdminDisplayNameReader } from './admin-display-names.ts';

const APP = 'couli';
const A = '019a0000-0000-7000-8000-0000000000a1';
const B = '019a0000-0000-7000-8000-0000000000a2';

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

it('[AC-B1-10j#23] 展示名优先，空展示名回落登录名；按 app_id 一次查询，空请求不查询', async () => {
  const { db, queries } = stubDb([
    { id: A, login_name: 'lin', display_name: '客服小林' },
    { id: B, login_name: 'wang', display_name: null },
  ]);
  const names = await createAdminDisplayNameReader(db).displayNames(APP, [A, B, A]);
  expect([...names]).toEqual([
    [A, '客服小林'],
    [B, 'wang'],
  ]);
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toContain('"app"."admin_users"');
  expect(queries[0]!.parameters).toEqual([APP, [A, B]]);
  const empty = stubDb();
  expect((await createAdminDisplayNameReader(empty.db).displayNames(APP, [])).size).toBe(0);
  expect(empty.queries).toEqual([]);
});
