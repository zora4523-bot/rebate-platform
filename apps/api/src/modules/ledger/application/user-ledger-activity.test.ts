// Unit tests of hasUserBalanceEntries (B1-20e, BR-ID-06 并号条件「余额无任何流水」): no database; a
// fake Kysely driver answers the one SELECT and records it.
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
import { hasUserBalanceEntries } from './user-ledger-activity.ts';

class FakeConnection implements DatabaseConnection {
  constructor(
    private readonly rows: readonly unknown[],
    private readonly queries: CompiledQuery[],
  ) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    this.queries.push(query);
    return { rows: this.rows } as QueryResult<R>;
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streamQuery is not used');
  }
}

class FakeDriver implements Driver {
  constructor(private readonly connection: FakeConnection) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }
  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

function fakeDb(rows: readonly unknown[]): { db: Kysely<DB>; queries: CompiledQuery[] } {
  const queries: CompiledQuery[] = [];
  const connection = new FakeConnection(rows, queries);
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new FakeDriver(connection),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}

const APP = 'couli';
const USER = '019a0000-0000-7000-8000-0000000000a1';

it('[B1-20e] 有一条分录 → true；只发一条 SELECT，按 app、owner_type=user、owner_id、USER_BALANCE 过滤，取一行', async () => {
  const { db, queries } = fakeDb([{ id: '1' }]);
  await expect(hasUserBalanceEntries(db, { appId: APP, userId: USER })).resolves.toBe(true);
  expect(queries).toHaveLength(1);
  const [query] = queries;
  expect(query?.sql).toMatch(/^select /);
  expect(query?.sql).toContain('"app"."ledger_entries"');
  expect(query?.sql).toContain('"app"."ledger_accounts"');
  expect(query?.sql).toContain('"a"."app_id" = "e"."app_id"');
  expect(query?.sql).toContain('"a"."id" = "e"."account_id"');
  expect(query?.sql).toContain('"a"."owner_type" = $2');
  expect(query?.sql).toContain('"a"."subject" = $4');
  expect(query?.sql).toMatch(/limit \$5$/);
  expect(query?.parameters).toEqual([APP, 'user', USER, 'USER_BALANCE', 1]);
});

it('[B1-20e] 没有分录（含没有账户行）→ false；不加锁、不写', async () => {
  const { db, queries } = fakeDb([]);
  await expect(hasUserBalanceEntries(db, { appId: APP, userId: USER })).resolves.toBe(false);
  expect(queries).toHaveLength(1);
  expect(queries[0]?.sql).not.toMatch(/for update|for share|for key share|insert|update |delete/i);
});
