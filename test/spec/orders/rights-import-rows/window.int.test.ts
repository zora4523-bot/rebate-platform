// time_basis 时间窗筛行（08 BR-FUND-06 细则「维权导入任务」导入的取行规则，编排裁定 D10-152）：带了时间窗时
// 只导入本系统该子订单的付款时间（paid）或收货时间（received）落在 [from, to) 内的行；窗外的行计跳过
// （skipped，不算失败、不调 rights.record、不写）；不带时间窗时不筛选。用例全部是顶层 it（规划/11 §4.3）。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  FROM,
  PAID_IN,
  PAID_OUT,
  RECEIVED_IN,
  RECEIVED_OUT,
  SKIPPED,
  SUCCEEDED,
  TO,
  at,
  open,
  plusMs,
  punishRow,
  rightsRow,
  setup,
  type Harness,
  type Order,
} from './db-kit.ts';

let database: TestDatabase | undefined;
let h: Harness;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-09k#4] 付款口径的边界 [from, to)：from 当刻在窗内，to 当刻在窗外；窗外计 skipped、不写', async () => {
  const f = await setup(h.db);
  const paid = [plusMs(FROM, -1), at(FROM), plusMs(TO, -1), at(TO)];
  const orders: Order[] = [];
  for (const paidAt of paid) orders.push(await f.order({ paid_at: paidAt }));
  const processor = f.processor('rights');
  const task = f.task(f.window('paid'));
  const outcomes: unknown[] = [];
  for (const o of orders) outcomes.push(await processor.process(task, rightsRow(o.sub_order_id)));
  expect(outcomes).toEqual([SKIPPED, SUCCEEDED, SUCCEEDED, SKIPPED]);
  expect(f.calls.map((c) => c.input.order_id)).toEqual([orders[1]!.order_id, orders[2]!.order_id]);
  expect((await f.rights()).map((r) => r.order_id).sort()).toEqual(
    [orders[1]!.order_id, orders[2]!.order_id].sort(),
  );
});

it('[AC-B1-09k#4] 收货口径的边界 [from, to)：按订单的收货时间筛', async () => {
  const f = await setup(h.db);
  const received = [plusMs(FROM, -1), at(FROM), plusMs(TO, -1), at(TO)];
  const orders: Order[] = [];
  for (const receivedAt of received) orders.push(await f.order({ received_at: receivedAt }));
  const processor = f.processor('rights');
  const task = f.task(f.window('received'));
  const outcomes: unknown[] = [];
  for (const o of orders) outcomes.push(await processor.process(task, rightsRow(o.sub_order_id)));
  expect(outcomes).toEqual([SKIPPED, SUCCEEDED, SUCCEEDED, SKIPPED]);
  expect(f.calls.map((c) => c.input.order_id)).toEqual([orders[1]!.order_id, orders[2]!.order_id]);
});

it('[AC-B1-09k#4] 口径只看所选的那个时间：付款在窗内而收货在窗外，付款口径导入、收货口径跳过；反之亦然', async () => {
  const f = await setup(h.db);
  const paidOnly = await f.order({ paid_at: at(PAID_IN), received_at: at(RECEIVED_OUT) });
  const receivedOnly = await f.order({ paid_at: at(PAID_OUT), received_at: at(RECEIVED_IN) });
  const paid = f.task(f.window('paid'));
  const received = f.task(f.window('received'));
  const processor = f.processor('rights');
  expect(await processor.process(paid, rightsRow(paidOnly.sub_order_id))).toEqual(SUCCEEDED);
  expect(await processor.process(received, rightsRow(paidOnly.sub_order_id))).toEqual(SKIPPED);
  expect(await processor.process(paid, rightsRow(receivedOnly.sub_order_id))).toEqual(SKIPPED);
  expect(await processor.process(received, rightsRow(receivedOnly.sub_order_id))).toEqual(
    SUCCEEDED,
  );
  expect(f.calls.map((c) => c.input.order_id)).toEqual([paidOnly.order_id, receivedOnly.order_id]);
});

it('[AC-B1-09k#4] 违规单同样按时间窗筛：窗外 skipped、不写', async () => {
  const f = await setup(h.db);
  const inside = await f.order({ paid_at: at(PAID_IN) });
  const outside = await f.order({ paid_at: at(PAID_OUT) });
  const window = f.window('paid');
  expect(await f.run('punish', punishRow(outside.sub_order_id), window)).toEqual(SKIPPED);
  expect(await f.run('punish', punishRow(inside.sub_order_id), window)).toEqual(SUCCEEDED);
  expect((await f.rights()).map((r) => [r.order_id, r.type])).toEqual([
    [inside.order_id, 'PUNISH'],
  ]);
});

it('[AC-B1-09k#4] 不带时间窗不筛选：付款、收货都在任意时刻（含没有收货时间）照常导入；只有 time_basis 也不筛', async () => {
  const f = await setup(h.db);
  const early = await f.order({ paid_at: at('2025-01-01T00:00:00.000Z'), received_at: null });
  const late = await f.order({ paid_at: at(PAID_OUT), received_at: at(RECEIVED_OUT) });
  const processor = f.processor('rights');
  const none = f.task();
  const basisOnly = f.task({ time_basis: 'received', from: null, to: null });
  expect(await processor.process(none, rightsRow(early.sub_order_id))).toEqual(SUCCEEDED);
  expect(await processor.process(none, rightsRow(late.sub_order_id))).toEqual(SUCCEEDED);
  const another = await f.order({ paid_at: at(PAID_OUT), received_at: null });
  expect(await processor.process(basisOnly, rightsRow(another.sub_order_id))).toEqual(SUCCEEDED);
  expect(f.record).toHaveBeenCalledTimes(3);
  expect(await f.rights()).toHaveLength(3);
});
