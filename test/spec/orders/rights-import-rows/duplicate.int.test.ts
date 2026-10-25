// 已导入的行（08 BR-FUND-06 细则：按 (platform, sub_order_id, 平台维权单号) 去重；「维权导入任务」：已导入的
// 行跳过、不报错、不重复扣回，单独计 duplicate_rows，不算跳过也不算失败；任务书补充 取值 3：端口返回
// duplicate → duplicate）。去重由 settlement 的 rights.record 判（假端口按 order_rights 去重键）。用例全部是
// 顶层 it（规划/11 §4.3）。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DUPLICATE,
  OTHER_RIGHTS_NO,
  RIGHTS_NO,
  SUCCEEDED,
  open,
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

it('[AC-B1-09k#5] 同一行已导入过（另一个任务、各自的事务已提交）：第二次计 duplicate，order_rights 仍只一条', async () => {
  const f = await setup(h.db);
  const o = await f.order();
  const processor = f.processor('rights');
  const first = await h.db
    .transaction()
    .execute((trx) => processor.process(f.task(), rightsRow(o.sub_order_id), trx));
  expect(first).toEqual(SUCCEEDED);
  const again = await h.db
    .transaction()
    .execute((trx) => processor.process(f.task(), rightsRow(o.sub_order_id), trx));
  expect(again).toEqual(DUPLICATE);
  expect(f.record).toHaveBeenCalledTimes(2);
  expect(await f.rights()).toHaveLength(1);
});

it('[AC-B1-09k#5] rights.record 答 duplicate：这一行计 duplicate，不报错、不当失败', async () => {
  const f = await setup(h.db);
  const o = await f.order();
  f.settlement.control.answer = { kind: 'duplicate' };
  expect(await f.run('rights', rightsRow(o.sub_order_id))).toEqual(DUPLICATE);
  expect(await f.run('punish', punishRow(o.sub_order_id))).toEqual(DUPLICATE);
  expect(f.record).toHaveBeenCalledTimes(2);
  expect(await f.rights()).toEqual([]);
});

it('[AC-B1-09k#5] 同一子订单、不同维权单号：两条都导入（去重键含平台维权单号）', async () => {
  const f = await setup(h.db);
  const o = await f.order();
  const processor = f.processor('rights');
  const task = f.task();
  expect(await processor.process(task, rightsRow(o.sub_order_id))).toEqual(SUCCEEDED);
  const other = rightsRow(o.sub_order_id, { rights_no: OTHER_RIGHTS_NO }, 3);
  expect(await processor.process(task, other)).toEqual(SUCCEEDED);
  expect((await f.rights()).map((r) => r.platform_rights_no).sort()).toEqual(
    [RIGHTS_NO, OTHER_RIGHTS_NO].sort(),
  );
});

it('[AC-B1-09k#5] 同一文件里同一行出现两次：第一次导入、第二次 duplicate', async () => {
  const f = await setup(h.db);
  const o = await f.order();
  const processor = f.processor('punish');
  const task = f.task({ kind: 'punish' });
  expect(await processor.process(task, punishRow(o.sub_order_id, {}, 2))).toEqual(SUCCEEDED);
  expect(await processor.process(task, punishRow(o.sub_order_id, {}, 3))).toEqual(DUPLICATE);
  expect((await f.rights()).map((r) => [r.order_id, r.type])).toEqual([[o.order_id, 'PUNISH']]);
});
