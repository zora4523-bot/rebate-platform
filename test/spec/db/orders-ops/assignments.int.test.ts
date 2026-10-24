// 编排 10-18 J-8 修正版: order_assignments（id、app_id、order_id → order_keys、to_user_id、
// source claim / admin、reason、admin_id、created_at），只插入。
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  ASSIGNMENT_SOURCE,
  assignment,
  columns,
  connect,
  expectCheckLists,
  expectForeignKey,
  insert,
  requireTable,
  sqlState,
} from './kit.ts';

const TABLE = 'order_assignments';

let database: TestDatabase;
let app: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  connect(app);
});
afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

async function add(values: Record<string, unknown> = {}): Promise<string> {
  return sqlState(insert(app, TABLE, await assignment(values)));
}

it('[B1-09e] order_assignments 有 J-8 列出的全部列，app_id、order_id、to_user_id、source 非空', async () => {
  await requireTable(app, TABLE);
  const cols = await columns(TABLE);
  expect(cols.map((c) => c.name)).toEqual(
    expect.arrayContaining([
      'id',
      'app_id',
      'order_id',
      'to_user_id',
      'source',
      'reason',
      'admin_id',
      'created_at',
    ]),
  );
  const nullable = Object.fromEntries(cols.map((c) => [c.name, c.nullable]));
  expect(nullable).toMatchObject({
    app_id: false,
    order_id: false,
    to_user_id: false,
    source: false,
    created_at: false,
  });
});

it('[B1-09e] order_id 引用 order_keys（不级联），不存在的订单 23503', async () => {
  await requireTable(app, TABLE);
  await expectForeignKey(TABLE, 'order_id', 'order_keys');
  expect(await add({ order_id: randomUUID() })).toBe('23503');
  expect(await add()).toBe('no error');
});

it('[B1-09e] source 的 CHECK 只收 claim / admin：两值都能写，其他值 23514', async () => {
  await requireTable(app, TABLE);
  await expectCheckLists(TABLE, 'source', ASSIGNMENT_SOURCE);
  expect(await add({ source: 'admin' })).toBe('no error');
  // Whether a claim-sourced row keeps the deciding admin is not fixed by J-8: either shape may pass.
  expect([
    await add({ source: 'claim' }),
    await add({ source: 'claim', admin_id: null }),
  ]).toContain('no error');
  for (const source of ['sync', 'ADMIN', 'manual']) {
    expect(await add({ source }), source).toBe('23514');
  }
});
