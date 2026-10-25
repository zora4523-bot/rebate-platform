// 维权单 / 违规单逐行写入（08 BR-FUND-06 细则「维权导入任务」；任务书补充 取值 2、4）：定位到的子订单经
// settlement 的 rights.record 写一条 order_rights——维权单 type=RIGHTS、状态取行，违规单 type=PUNISH、
// status=SUCCEEDED；source=IMPORT，before 是锁内重读的订单行，now 取注入时钟；金额按元两位小数转分，发生
// 时间无偏移按 +08:00。交给处理器的事务（检查点同一事务）里写、不自行提交；没有交给事务时一行自开一个事务；
// 调端口时持有该子订单的 order_key advisory 锁与订单行锁。用例全部是顶层 it（规划/11 §4.3）。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  OCCURRED_AT,
  OCCURRED_TEXT,
  PROCESSED,
  RIGHTS_NO,
  SUCCEEDED,
  at,
  open,
  punishRow,
  rightsRow,
  rightsView,
  setup,
  txidOn,
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

const ROLLBACK = 'synthetic rollback of the checkpoint transaction';

it('[AC-B1-09k#1] 维权单一行：经 rights.record 写 RIGHTS；入参取锁内重读的订单、IMPORT、行的状态 / 金额 / 维权单号 / 发生时间与注入时钟', async () => {
  const f = await setup(h.db);
  const o = await f.order();
  const row = rightsRow(o.sub_order_id, { status: 'PROCESSING' });
  expect(await f.run('rights', row)).toEqual(SUCCEEDED);
  expect(f.record).toHaveBeenCalledTimes(1);
  expect(f.calls[0]!.input).toEqual({
    before: o,
    order_id: o.order_id,
    source: 'IMPORT',
    type: 'RIGHTS',
    status: 'PROCESSING',
    amount_fen: 1230n,
    deduction_commission_fen: 123n,
    occurred_at: at(OCCURRED_AT),
    platform_rights_no: RIGHTS_NO,
    now: at(PROCESSED),
  });
  expect((await f.rights()).map(rightsView)).toEqual([
    {
      order_id: o.order_id,
      source: 'IMPORT',
      type: 'RIGHTS',
      status: 'PROCESSING',
      amount_fen: 1230n,
      deduction_commission_fen: 123n,
      occurred_at: at(OCCURRED_AT),
      platform_rights_no: RIGHTS_NO,
    },
  ]);
});

it('[AC-B1-09k#1] 维权单的状态按状态列：PROCESSING / SUCCEEDED / FAILED 各自照传', async () => {
  const f = await setup(h.db);
  const processor = f.processor('rights');
  const task = f.task();
  for (const status of ['PROCESSING', 'SUCCEEDED', 'FAILED'] as const) {
    const o = await f.order();
    expect(await processor.process(task, rightsRow(o.sub_order_id, { status }))).toEqual(SUCCEEDED);
  }
  expect(f.calls.map((c) => [c.input.type, c.input.status])).toEqual([
    ['RIGHTS', 'PROCESSING'],
    ['RIGHTS', 'SUCCEEDED'],
    ['RIGHTS', 'FAILED'],
  ]);
  expect((await f.rights()).map((r) => r.status).sort()).toEqual([
    'FAILED',
    'PROCESSING',
    'SUCCEEDED',
  ]);
});

it('[AC-B1-09k#2] 违规单一行：经 rights.record 写 PUNISH、status=SUCCEEDED，source=IMPORT，违规单号进 platform_rights_no', async () => {
  const f = await setup(h.db);
  const o = await f.order();
  expect(await f.run('punish', punishRow(o.sub_order_id))).toEqual(SUCCEEDED);
  expect(f.calls.map((c) => c.input)).toEqual([
    {
      before: o,
      order_id: o.order_id,
      source: 'IMPORT',
      type: 'PUNISH',
      status: 'SUCCEEDED',
      amount_fen: 1230n,
      deduction_commission_fen: 123n,
      occurred_at: at(OCCURRED_AT),
      platform_rights_no: RIGHTS_NO,
      now: at(PROCESSED),
    },
  ]);
  expect((await f.rights()).map((r) => [r.order_id, r.type, r.status, r.source])).toEqual([
    [o.order_id, 'PUNISH', 'SUCCEEDED', 'IMPORT'],
  ]);
});

it('[AC-B1-09k#1] 金额按元（至多两位小数）转分：文本与数字格都行，空格为 null', async () => {
  const f = await setup(h.db);
  const processor = f.processor('rights');
  const task = f.task();
  const cases = [
    ['12.30', '1.23', 1230n, 123n],
    ['5', '0.5', 500n, 50n],
    [12.5, 3, 1250n, 300n],
    [null, null, null, null],
    ['0', '', 0n, null],
  ] as const;
  for (const [amount, deduction] of cases) {
    const o = await f.order();
    const row = rightsRow(o.sub_order_id, { amount, deduction_commission: deduction });
    expect(await processor.process(task, row)).toEqual(SUCCEEDED);
  }
  expect(f.calls.map((c) => [c.input.amount_fen, c.input.deduction_commission_fen])).toEqual(
    cases.map(([, , amountFen, deductionFen]) => [amountFen, deductionFen]),
  );
});

it('[AC-B1-09k#1] 发生时间：无偏移文本与仅日期按 +08:00，带 Z 或偏移照给，表格日期格照原时刻', async () => {
  const f = await setup(h.db);
  const processor = f.processor('rights');
  const task = f.task();
  const cases = [
    [OCCURRED_TEXT, OCCURRED_AT],
    ['2026-10-18T10:30:00', OCCURRED_AT],
    ['2026-10-18', '2026-10-17T16:00:00.000Z'],
    ['2026-10-18T10:30:00+08:00', OCCURRED_AT],
    ['2026-10-18T02:30:00Z', OCCURRED_AT],
    [at('2026-10-19T01:02:03.000Z'), '2026-10-19T01:02:03.000Z'],
  ] as const;
  for (const [cell] of cases) {
    const o = await f.order();
    const row = rightsRow(o.sub_order_id, { occurred_at: cell });
    expect(await processor.process(task, row)).toEqual(SUCCEEDED);
  }
  expect(f.calls.map((c) => c.input.occurred_at)).toEqual(cases.map(([, iso]) => at(iso)));
});

it('[AC-B1-09k#1] 子订单号去掉首尾空白后定位；维权单号为空时 platform_rights_no 为 null', async () => {
  const f = await setup(h.db);
  const o = await f.order();
  const row = rightsRow(`  ${o.sub_order_id}\t`, { rights_no: null });
  expect(await f.run('rights', row)).toEqual(SUCCEEDED);
  expect(f.calls.map((c) => [c.input.order_id, c.input.platform_rights_no])).toEqual([
    [o.order_id, null],
  ]);
});

it('[AC-B1-09k#1] 只写行里的那个子订单：同一主订单的其他子订单不动', async () => {
  const f = await setup(h.db);
  const own = await f.order();
  const sibling = await f.order({ parent_order_id: own.parent_order_id });
  expect(await f.run('rights', rightsRow(own.sub_order_id))).toEqual(SUCCEEDED);
  const rows = await f.rights();
  expect(rows.map((r) => r.order_id)).toEqual([own.order_id]);
  expect(rows.map((r) => r.order_id)).not.toContain(sibling.order_id);
});

it('[AC-B1-09k#8] 调 rights.record 时持有该子订单的 order_key advisory 锁、订单行已 FOR UPDATE（别的连接拿不到）', async () => {
  const f = await setup(h.db);
  const o = await f.order();
  f.settlement.control.probe = true;
  expect(await f.run('rights', rightsRow(o.sub_order_id))).toEqual(SUCCEEDED);
  expect(f.calls.map((c) => c.held)).toEqual([{ advisoryFree: false, rowFree: false }]);
});

it('[AC-B1-09k#6] 没有交给事务时一行自开一个事务：rights.record 在事务里调用，写入随之提交', async () => {
  const f = await setup(h.db);
  const o = await f.order();
  expect(await f.run('rights', rightsRow(o.sub_order_id))).toEqual(SUCCEEDED);
  expect(f.calls.map((c) => c.isTransaction)).toEqual([true]);
  expect((await f.rights()).map((r) => r.order_id)).toEqual([o.order_id]);
});

it('[AC-B1-09k#6] 交给处理器的事务：rights.record 收到的就是它（同一事务号）', async () => {
  const f = await setup(h.db);
  const o = await f.order();
  const processor = f.processor('rights');
  const task = f.task();
  const handed = await h.db.transaction().execute(async (trx) => {
    expect(await processor.process(task, rightsRow(o.sub_order_id), trx)).toEqual(SUCCEEDED);
    return txidOn(trx);
  });
  expect(f.calls.map((c) => c.txid)).toEqual([handed]);
  expect(await f.rights()).toHaveLength(1);
});

it('[AC-B1-09k#6] 交给处理器的事务回滚：这一行什么都不留（在该事务里写、不自行提交）', async () => {
  const f = await setup(h.db);
  const o = await f.order();
  const processor = f.processor('punish');
  const task = f.task({ kind: 'punish' });
  const sentinel = new Error(ROLLBACK);
  let seen: number | undefined;
  await expect(
    h.db.transaction().execute(async (trx) => {
      expect(await processor.process(task, punishRow(o.sub_order_id), trx)).toEqual(SUCCEEDED);
      const inside = await trx
        .selectFrom('order_rights')
        .select('id')
        .where('app_id', '=', f.appId)
        .execute();
      seen = inside.length;
      throw sentinel;
    }),
  ).rejects.toBe(sentinel);
  expect(seen).toBe(1);
  expect(await f.rights()).toEqual([]);
});

it('[AC-B1-09k#6] rights.record 抛错：不吞成逐行结果，原样抛出、什么都不写', async () => {
  const f = await setup(h.db);
  const o = await f.order();
  const boom = new Error('synthetic settlement failure');
  f.settlement.control.fail = boom;
  await expect(f.run('rights', rightsRow(o.sub_order_id))).rejects.toBe(boom);
  expect(f.record).toHaveBeenCalledTimes(1);
  expect(await f.rights()).toEqual([]);
});
