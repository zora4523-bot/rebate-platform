// 子订单按任务的平台定位（规则测试评审 r1 的 S1 跨平台；08 BR-FUND-06 细则：按 (platform, sub_order_id, 平台
// 维权单号) 去重，order_keys 以 (platform, sub_order_id) 为键，同号订单可以分属不同平台）：淘宝的维权单 / 违规单
// 只找本 App 的淘宝子订单；本 App 只有京东同号订单时记 order_not_found，不调 rights.record、不写，免得把扣回
// 记到别的平台的订单上。模板没有平台列或平台列写淘宝都一样。用例全部是顶层 it（规划/11 §4.3）。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { RightsImportRow } from '../../../../apps/api/src/modules/orders/application/rights-import-ports.ts';
import { SUCCEEDED, failed, open, punishRow, rightsRow, setup, type Harness } from './db-kit.ts';

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

it('[AC-B1-09k#3] 本 App 只有京东同号订单、淘宝导入（行写淘宝或模板无平台列）→ order_not_found，不调 rights.record、不写', async () => {
  const f = await setup(h.db);
  const jd = await f.order({ platform: 'jd' });
  const sub = jd.sub_order_id;
  const cases: ['rights' | 'punish', RightsImportRow][] = [
    ['rights', rightsRow(sub)],
    ['rights', rightsRow(sub, { platform: undefined })],
    ['punish', punishRow(sub)],
    ['punish', punishRow(sub, { platform: undefined })],
  ];
  const outcomes: unknown[] = [];
  for (const [kind, row] of cases) outcomes.push(await f.run(kind, row));
  expect(outcomes).toEqual(cases.map(() => failed('order_not_found')));
  // 带时间窗（京东订单的付款时间在窗内）也一样：先定位、找不到即失败，不按窗内导入。
  expect(await f.run('rights', rightsRow(sub), f.window('paid'))).toEqual(
    failed('order_not_found'),
  );
  expect(f.record).not.toHaveBeenCalled();
  expect(await f.rights()).toEqual([]);
});

it('[AC-B1-09k#3] 同一 App 里京东、淘宝各有一张同号子订单：淘宝任务写淘宝那张，京东任务写京东那张', async () => {
  const f = await setup(h.db);
  const jd = await f.order({ platform: 'jd' });
  const taobao = await f.order({ sub_order_id: jd.sub_order_id });
  const sub = jd.sub_order_id;
  expect(await f.run('rights', rightsRow(sub, { platform: undefined }))).toEqual(SUCCEEDED);
  expect(await f.run('punish', punishRow(sub, { platform: 'jd' }), { platform: 'jd' })).toEqual(
    SUCCEEDED,
  );
  expect(f.calls.map((c) => [c.input.order_id, c.input.before.platform, c.input.type])).toEqual([
    [taobao.order_id, 'taobao', 'RIGHTS'],
    [jd.order_id, 'jd', 'PUNISH'],
  ]);
  expect(f.calls.map((c) => c.input.before)).toEqual([taobao, jd]);
  const written = (await f.rights()).map((r) => `${r.order_id}:${r.type}`).sort();
  expect(written).toEqual([`${taobao.order_id}:RIGHTS`, `${jd.order_id}:PUNISH`].sort());
});
