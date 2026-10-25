// 五类逐行失败与判定顺序（08 BR-FUND-06 细则「维权导入任务」：逐行失败的原因只分五类；任务书补充 取值 1：
// 缺必需列 / 格式错 → invalid_row；平台不符 → platform_mismatch；只有主订单号 → sub_order_no_missing（不展开
// 到子订单）；子订单不在本系统 → order_not_found；收货口径而无收货时间 → received_at_missing）。失败的行不调
// rights.record、不写 order_rights。用例全部是顶层 it（规划/11 §4.3）。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { RightsImportRow } from '../../../../apps/api/src/modules/orders/application/rights-import-ports.ts';
import {
  PAID_OUT,
  SUCCEEDED,
  at,
  failed,
  newAppId,
  open,
  orderNo,
  punishRow,
  rightsRow,
  setup,
  type Harness,
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

it('[AC-B1-09k#3] 缺必需列或格式错 → invalid_row（维权单）：不调 rights.record、不写', async () => {
  const f = await setup(h.db);
  const processor = f.processor('rights');
  const task = f.task();
  const o = await f.order();
  const sub = o.sub_order_id;
  const rows: RightsImportRow[] = [
    // 子订单号与主订单号都没有
    rightsRow(null),
    rightsRow('   '),
    rightsRow(true),
    // 状态缺列、为空、认不出
    rightsRow(sub, { status: undefined }),
    rightsRow(sub, { status: null }),
    rightsRow(sub, { status: 'UNKNOWN-STATUS' }),
    // 发生时间缺列、为空、认不出、是数字
    rightsRow(sub, { occurred_at: undefined }),
    rightsRow(sub, { occurred_at: null }),
    rightsRow(sub, { occurred_at: 'not-a-time' }),
    rightsRow(sub, { occurred_at: '2026-02-30 10:00:00' }),
    rightsRow(sub, { occurred_at: 46313.4375 }),
    // 金额认不出、超过两位小数、为负
    rightsRow(sub, { amount: 'abc' }),
    rightsRow(sub, { amount: '1.234' }),
    rightsRow(sub, { amount: '-1' }),
    rightsRow(sub, { deduction_commission: '1,5' }),
    rightsRow(sub, { deduction_commission: -3 }),
  ];
  const outcomes: unknown[] = [];
  for (const row of rows) outcomes.push(await processor.process(task, row));
  expect(outcomes).toEqual(rows.map(() => failed('invalid_row')));
  expect(f.record).not.toHaveBeenCalled();
  expect(await f.rights()).toEqual([]);
});

it('[AC-B1-09k#3] 违规单缺发生时间或子订单号 → invalid_row；违规单不看状态列', async () => {
  const f = await setup(h.db);
  const processor = f.processor('punish');
  const task = f.task({ kind: 'punish' });
  const o = await f.order();
  expect(await processor.process(task, punishRow(null))).toEqual(failed('invalid_row'));
  expect(await processor.process(task, punishRow(o.sub_order_id, { occurred_at: null }))).toEqual(
    failed('invalid_row'),
  );
  expect(f.record).not.toHaveBeenCalled();
  expect(await processor.process(task, punishRow(o.sub_order_id))).toEqual(SUCCEEDED);
  expect(f.calls.map((c) => [c.input.type, c.input.status])).toEqual([['PUNISH', 'SUCCEEDED']]);
});

it('[AC-B1-09k#3] 行的平台与任务不符 → platform_mismatch；模板没有平台列时不比', async () => {
  const f = await setup(h.db);
  const o = await f.order();
  expect(await f.run('rights', rightsRow(o.sub_order_id, { platform: 'jd' }))).toEqual(
    failed('platform_mismatch'),
  );
  expect(await f.run('punish', punishRow(o.sub_order_id, { platform: 'pdd' }))).toEqual(
    failed('platform_mismatch'),
  );
  expect(f.record).not.toHaveBeenCalled();
  expect(await f.rights()).toEqual([]);
  expect(await f.run('rights', rightsRow(o.sub_order_id, { platform: undefined }))).toEqual(
    SUCCEEDED,
  );
});

it('[AC-B1-09k#3] 只有主订单号（子订单号为空）→ sub_order_no_missing，不展开到它的子订单', async () => {
  const f = await setup(h.db);
  const a = await f.order();
  const b = await f.order({ parent_order_id: a.parent_order_id });
  const row = rightsRow(null, { parent_order_id: a.parent_order_id });
  expect(await f.run('rights', row)).toEqual(failed('sub_order_no_missing'));
  expect(await f.run('punish', punishRow('', { parent_order_id: b.parent_order_id }))).toEqual(
    failed('sub_order_no_missing'),
  );
  expect(f.record).not.toHaveBeenCalled();
  expect(await f.rights()).toEqual([]);
});

it('[AC-B1-09k#3] 子订单号一栏填的是主订单号（本系统只有它的子订单）→ sub_order_no_missing，不展开', async () => {
  const f = await setup(h.db);
  const a = await f.order();
  await f.order({ parent_order_id: a.parent_order_id });
  expect(await f.run('rights', rightsRow(a.parent_order_id))).toEqual(
    failed('sub_order_no_missing'),
  );
  expect(f.record).not.toHaveBeenCalled();
  expect(await f.rights()).toEqual([]);
});

it('[AC-B1-09k#3] 子订单不在本系统 → order_not_found（含别的 App 的子订单）', async () => {
  const f = await setup(h.db);
  const other = await f.order({}, newAppId());
  expect(await f.run('rights', rightsRow(orderNo()))).toEqual(failed('order_not_found'));
  expect(await f.run('punish', punishRow(other.sub_order_id))).toEqual(failed('order_not_found'));
  expect(f.record).not.toHaveBeenCalled();
  expect(await f.rights()).toEqual([]);
  expect(await f.rights(other.app_id)).toEqual([]);
});

it('[AC-B1-09k#3] 收货口径而订单没有收货时间 → received_at_missing；付款口径不看收货时间', async () => {
  const f = await setup(h.db);
  const o = await f.order({ received_at: null, platform_status: 'PAID' });
  expect(await f.run('rights', rightsRow(o.sub_order_id), f.window('received'))).toEqual(
    failed('received_at_missing'),
  );
  expect(f.record).not.toHaveBeenCalled();
  expect(await f.run('rights', rightsRow(o.sub_order_id), f.window('paid'))).toEqual(SUCCEEDED);
});

it('[AC-B1-09k#3] 判定顺序：格式错先于平台不符，平台不符先于只有主订单号与子订单不在本系统', async () => {
  const f = await setup(h.db);
  const o = await f.order();
  const cases: [RightsImportRow, string][] = [
    [rightsRow(o.sub_order_id, { platform: 'jd', occurred_at: 'not-a-time' }), 'invalid_row'],
    [rightsRow(null, { platform: 'jd' }), 'invalid_row'],
    [rightsRow(null, { platform: 'jd', parent_order_id: o.parent_order_id }), 'platform_mismatch'],
    [rightsRow(orderNo(), { platform: 'jd' }), 'platform_mismatch'],
    [rightsRow(o.parent_order_id, { platform: 'jd' }), 'platform_mismatch'],
  ];
  const outcomes: unknown[] = [];
  for (const [row] of cases) outcomes.push(await f.run('rights', row));
  expect(outcomes).toEqual(cases.map(([, reason]) => failed(reason)));
  expect(f.record).not.toHaveBeenCalled();
});

it('[AC-B1-09k#3] 判定顺序：逐行失败先于时间窗——窗外的格式错 / 只有主订单号 / 不在本系统都记失败、不计跳过', async () => {
  const f = await setup(h.db);
  const out = await f.order({ paid_at: at(PAID_OUT), received_at: null });
  const window = f.window('paid');
  const cases: [RightsImportRow, string][] = [
    [rightsRow(out.sub_order_id, { status: 'UNKNOWN-STATUS' }), 'invalid_row'],
    [rightsRow(out.sub_order_id, { platform: 'jd' }), 'platform_mismatch'],
    [rightsRow(null, { parent_order_id: out.parent_order_id }), 'sub_order_no_missing'],
    [rightsRow(orderNo()), 'order_not_found'],
  ];
  const outcomes: unknown[] = [];
  for (const [row] of cases) outcomes.push(await f.run('rights', row, window));
  expect(outcomes).toEqual(cases.map(([, reason]) => failed(reason)));
  // 收货口径：没有收货时间先记失败，不按窗外跳过。
  expect(await f.run('rights', rightsRow(out.sub_order_id), f.window('received'))).toEqual(
    failed('received_at_missing'),
  );
  expect(f.record).not.toHaveBeenCalled();
  expect(await f.rights()).toEqual([]);
});
