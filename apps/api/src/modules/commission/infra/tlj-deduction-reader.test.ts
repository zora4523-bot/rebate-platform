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
  type Transaction,
} from 'kysely';
import { expect, it } from 'vitest';
import { TljDeductionMissing, readTljDeductFen } from './tlj-deduction-reader.ts';

const INPUT = { appId: 'couli', orderId: '019a0000-0000-7000-8000-0000000000a1' };

/** A Kysely whose driver records each compiled statement and answers the given rows. */
function recordingDb(rows: readonly Record<string, unknown>[]): {
  db: Kysely<DB>;
  queries: CompiledQuery[];
} {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query);
      return Promise.resolve({ rows: rows as R[] });
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
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

it('[AC-B2-04y-UNIT#1] 读调用方事务里该子订单的 commission_splits.tlj_deduct_fen，按 app_id 与 order_id 过滤、不加锁', async () => {
  const { db, queries } = recordingDb([{ tlj_deduct_fen: 120n }]);
  const fen = await db.transaction().execute((trx) => readTljDeductFen(trx, INPUT));
  expect(fen).toBe(120n);
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toBe(
    'select "tlj_deduct_fen" from "app"."commission_splits" where "app_id" = $1 and "order_id" = $2',
  );
  expect(queries[0]!.parameters).toEqual([INPUT.appId, INPUT.orderId]);
});

it('[AC-B2-04y-UNIT#2] 没有分佣快照行时抛 TljDeductionMissing，不默认返回 0', async () => {
  const { db } = recordingDb([]);
  const read = (trx: Transaction<DB>) => readTljDeductFen(trx, INPUT);
  await expect(db.transaction().execute(read)).rejects.toBeInstanceOf(TljDeductionMissing);
  await expect(db.transaction().execute(read)).rejects.toMatchObject({
    appId: INPUT.appId,
    orderId: INPUT.orderId,
  });
});
