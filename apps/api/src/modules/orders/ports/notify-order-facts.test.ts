// Unit tests without a database: Kysely runs on a scripted driver that records each compiled
// statement and answers from a queue of canned row sets. The SQL itself runs against PostgreSQL in
// the rule tests (test/spec/notification/trade-read-ports).
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
import { readNotifyClaimFacts, readNotifyOrderFacts } from './notify-order-facts.ts';

function setup(answers: Record<string, unknown>[][]) {
  const statements: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled);
      const rows = answers.shift() ?? [];
      return Promise.resolve({ rows } as unknown as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
}

const ORDER = '00000000-0000-4000-8000-000000000001';
const CLAIM = '00000000-0000-4000-8000-000000000002';

it('[AC-B1-12j-UNIT#3] 订单事实：一条按 app_id 与 order_id 过滤的 SELECT，缺行返回 null', async () => {
  const { db, statements } = setup([[]]);
  expect(await readNotifyOrderFacts(db, { app_id: 'app-a', order_id: ORDER })).toBeNull();
  expect(statements).toHaveLength(1);
  const sql = statements[0]?.sql ?? '';
  expect(sql.startsWith('select ')).toBe(true);
  expect(sql).toContain('from "app"."orders"');
  expect(sql).toContain('"app_id" = $1 and "order_id" = $2');
  expect(sql).not.toMatch(/for (update|share)/i);
  expect(statements[0]?.parameters).toEqual(['app-a', ORDER]);
});

it('[AC-B1-12j-UNIT#4] 订单事实原样投影九列，多余列不外泄，null 与 bigint 不改', async () => {
  const facts = {
    order_id: ORDER,
    platform: 'jd',
    sub_order_id: 'child-1',
    user_id: null,
    buy_type: null,
    title: null,
    platform_status: 'PAID',
    est_commission_fen: 9007199254740993n,
    commission_version: 0,
  };
  const { db } = setup([[{ ...facts, base_fen: 1n, row_version: 3 }]]);
  expect(await readNotifyOrderFacts(db, { app_id: 'app-a', order_id: ORDER })).toEqual(facts);
});

it('[AC-B1-12j-UNIT#5] 找回单不存在返回 null：一条按 app_id 与 claim id 过滤、无锁的 SELECT', async () => {
  const { db, statements } = setup([[]]);
  expect(await readNotifyClaimFacts(db, { app_id: 'app-a', claim_id: CLAIM })).toBeNull();
  expect(statements).toHaveLength(1);
  const sql = statements[0]?.sql ?? '';
  expect(sql).toContain('from "app"."claims" as "c"');
  expect(sql).toContain('"c"."app_id" = $1 and "c"."id" = $2');
  expect(sql).not.toMatch(/for (update|share)/i);
  expect(statements[0]?.parameters).toEqual(['app-a', CLAIM]);
});

it('[AC-B1-12j-UNIT#6] 找回单：申请人取 claims.user_id，条目同一条 LEFT JOIN 读出并原样投影', async () => {
  const claim = { claim_id: CLAIM, applicant_user_id: 'applicant', status: 'rejected' };
  const { db, statements } = setup([
    [
      { ...claim, item_id: 'i1', order_id: ORDER, decision: 'rejected', reject_reason: 'FRAUD' },
      { ...claim, item_id: 'i2', order_id: ORDER, decision: null, reject_reason: null },
    ],
  ]);
  expect(await readNotifyClaimFacts(db, { app_id: 'app-a', claim_id: CLAIM })).toEqual({
    claim_id: CLAIM,
    applicant_user_id: 'applicant',
    status: 'rejected',
    items: [
      { item_id: 'i1', order_id: ORDER, decision: 'rejected', reject_reason: 'FRAUD' },
      { item_id: 'i2', order_id: ORDER, decision: null, reject_reason: null },
    ],
  });
  // One statement: the claim and its items share a snapshot (B1-12j review S2, B1-12r).
  expect(statements).toHaveLength(1);
  const sql = statements[0]?.sql ?? '';
  expect(sql).toContain(
    'left join "app"."claim_items" as "i" on "i"."app_id" = "c"."app_id" and "i"."claim_id" = "c"."id"',
  );
  expect(sql).toContain('order by "i"."created_at", "i"."id"');
  expect(statements[0]?.parameters).toEqual(['app-a', CLAIM]);
});

it('[AC-B1-12j-UNIT#7] 找回单尚无条目：LEFT JOIN 的空条目行不成为条目，返回 items: []', async () => {
  const { db } = setup([
    [
      {
        claim_id: CLAIM,
        applicant_user_id: 'applicant',
        status: 'submitted',
        item_id: null,
        order_id: null,
        decision: null,
        reject_reason: null,
      },
    ],
  ]);
  expect(await readNotifyClaimFacts(db, { app_id: 'app-a', claim_id: CLAIM })).toEqual({
    claim_id: CLAIM,
    applicant_user_id: 'applicant',
    status: 'submitted',
    items: [],
  });
});
