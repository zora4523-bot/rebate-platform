import type { DB } from '@couli/db';
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import { needsTaobaoReauth } from './taobao-reauth-read.ts';

/** In-memory driver: records every compiled statement and answers with the given rows. */
function recording(rows: readonly Record<string, unknown>[]) {
  const statements: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(query);
      return { rows: /^select/i.test(query.sql) ? (rows as R[]) : [] };
    },
    async *streamQuery() {
      throw new Error('not streamed');
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
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
}

it.each([
  [[{ id: 'binding-1' }], true],
  [[], false],
] as const)(
  '[AC-B1-12g] reads one app.union_bindings row of the taobao invalid binding (rows %j → %s)',
  async (rows, expected) => {
    const { db, statements } = recording(rows);
    try {
      const result = await db
        .transaction()
        .execute((trx) => needsTaobaoReauth(trx, { appId: 'couli', userId: 'user-1' }));
      expect(result).toBe(expected);
      expect(statements).toHaveLength(1);
      const [statement] = statements;
      expect(statement?.sql).toBe(
        'select "id" from "app"."union_bindings" where "app_id" = $1 and "user_id" = $2 and "platform" = $3 and "status" = $4 limit $5',
      );
      expect(statement?.parameters).toEqual(['couli', 'user-1', 'taobao', 'invalid', 1]);
    } finally {
      await db.destroy();
    }
  },
);
