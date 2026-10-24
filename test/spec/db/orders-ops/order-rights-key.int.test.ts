// 编排裁定 D10-169 K-2 / J-12: order_rights 唯一 (app_id, order_id, type, platform_rights_no)
// NULLS NOT DISTINCT（BR-FUND-06 去重键；表归 settlement，迁移由 B1-09e 出）。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  connect,
  insert,
  newOrderId,
  orderRight,
  requireTable,
  sqlState,
  unique,
  uniqueIndexesOn,
} from './kit.ts';

const TABLE = 'order_rights';
const KEY = ['app_id', 'order_id', 'type', 'platform_rights_no'];

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

/** Asserts the K-2 key exists; every test calls it first so a missing key is an assertion. */
async function requireRightsKey(): Promise<void> {
  await requireTable(app, TABLE);
  const keys = await uniqueIndexesOn(app, TABLE, KEY);
  expect(
    keys.map((k) => ({ partial: k.predicate !== null, nullsNotDistinct: k.nullsNotDistinct })),
    'order_rights unique (app_id, order_id, type, platform_rights_no) NULLS NOT DISTINCT',
  ).toContainEqual({ partial: false, nullsNotDistinct: true });
}

async function add(orderId: unknown, values: Record<string, unknown> = {}): Promise<string> {
  return sqlState(insert(app, TABLE, await orderRight(orderId, values)));
}

it('[B1-09e] order_rights 有非部分的唯一键 (app_id, order_id, type, platform_rights_no)，NULLS NOT DISTINCT', async () => {
  await requireRightsKey();
});

it.each(['RIGHTS', 'PUNISH'])(
  '[B1-09e] 同一订单同一 type=%s、平台维权单号都为空：第二行 23505（空号也去重）',
  async (type) => {
    await requireRightsKey();
    const order = await newOrderId();
    expect(await add(order, { type })).toBe('no error');
    expect(await add(order, { type, amount_fen: 200n })).toBe('23505');
  },
);

it('[B1-09e] 同一订单同一 type、同一平台维权单号：第二行 23505', async () => {
  await requireRightsKey();
  const order = await newOrderId();
  const no = unique('rights');
  expect(await add(order, { platform_rights_no: no })).toBe('no error');
  expect(await add(order, { platform_rights_no: no, status: 'SUCCEEDED' })).toBe('23505');
});

it('[B1-09e] 键的任一部分不同都可写：换单号、换 type、换订单、空号与非空号并存', async () => {
  await requireRightsKey();
  const order = await newOrderId();
  const no = unique('rights');
  expect(await add(order, { platform_rights_no: no })).toBe('no error');
  expect(await add(order, { platform_rights_no: unique('rights') })).toBe('no error');
  expect(await add(order, { platform_rights_no: no, type: 'PUNISH' })).toBe('no error');
  expect(await add(order, { platform_rights_no: null })).toBe('no error');
  expect(await add(await newOrderId(), { platform_rights_no: no })).toBe('no error');
});
