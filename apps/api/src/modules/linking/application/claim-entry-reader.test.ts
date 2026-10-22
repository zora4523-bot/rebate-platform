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
import { createClaimEntryReader } from './claim-entry-reader.ts';

const USER = '019c0000-0000-7000-8000-000000000001';
const FROM = new Date('2028-02-27T08:00:00.000Z');
const TO = new Date('2028-03-01T08:00:00.000Z');

/** A Kysely whose driver records each compiled statement and answers with the next row set. */
function stubDb(answers: readonly Record<string, unknown>[][] = []): {
  db: Kysely<DB>;
  queries: CompiledQuery[];
} {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      const rows = answers[queries.length] ?? [];
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

it('[AC-B1-10h#70] 创建读口不触碰数据库；非 UUID 用户没有记录也不发查询', async () => {
  const { db, queries } = stubDb();
  const reader = createClaimEntryReader(db);
  expect(queries).toHaveLength(0);
  const facts = await reader.read({ app_id: 'a', user_id: 'not-a-uuid', from: FROM, to: TO });
  expect(facts).toEqual({ logs: [], bindings: [] });
  expect(queries).toHaveLength(0);
});

it('[AC-B1-10h#71] 按 app、发起人、闭区间读 link_logs，再读本人绑定；行原样返回', async () => {
  const row = { id: 7n, app_id: 'a', pid_scene: 'share', no_rebate: true, created_at: TO };
  const bound = { app_id: 'a', user_id: USER, platform: 'pdd', status: 'invalid', bound_at: null };
  const { db, queries } = stubDb([[row], [bound]]);
  const facts = await createClaimEntryReader(db).read({
    app_id: 'a',
    user_id: USER,
    from: FROM,
    to: TO,
  });
  expect(facts).toEqual({ logs: [row], bindings: [bound] });
  expect(queries).toHaveLength(2);
  const [logs, bindings] = queries as [CompiledQuery, CompiledQuery];
  expect(logs.sql).toContain('"app"."link_logs"');
  expect(logs.sql).toContain('coalesce("opener_user_id", "user_id")');
  expect(logs.parameters).toEqual(['a', USER, 'convert', 'open', 0, FROM, TO]);
  expect(bindings.sql).toContain('"app"."union_bindings"');
  expect(bindings.parameters).toEqual(['a', USER]);
});

it('[AC-B1-10h#102] 读错误原样上抛', async () => {
  const failure = new Error('synthetic read failure');
  const failing = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => ({
        async init() {},
        async acquireConnection() {
          throw failure;
        },
        async beginTransaction() {},
        async commitTransaction() {},
        async rollbackTransaction() {},
        async releaseConnection() {},
        async destroy() {},
      }),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  await expect(
    createClaimEntryReader(failing).read({ app_id: 'a', user_id: USER, from: FROM, to: TO }),
  ).rejects.toBe(failure);
});
