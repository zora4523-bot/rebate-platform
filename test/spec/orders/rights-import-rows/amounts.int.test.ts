// 金额按十进制换算（规则测试评审 r1 的 S1 金额；apps/api AGENTS.md：金额只调 @couli/money，BR-CALC-26 十进制
// 字符串转分、不经 JS 浮点）：乘 100 后在浮点里不精确的金额（0.29 × 100 = 28.999…，1.15、4.35、0.57、19.99 同理）
// 必须精确到分，文本格与数字格都一样；超过 2^53 / 100 的文本金额同样逐位换算。扣回少一分即错。用例全部是顶层 it
// （规划/11 §4.3）。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { SUCCEEDED, open, punishRow, rightsRow, setup, type Harness } from './db-kit.ts';

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

/** [amount cell, deduction cell, amount_fen, deduction_commission_fen]. */
const CASES = [
  ['0.29', '0.07', 29n, 7n],
  ['1.15', '4.35', 115n, 435n],
  ['0.57', '19.99', 57n, 1999n],
  [0.29, 1.15, 29n, 115n],
  [0.07, 4.35, 7n, 435n],
  [19.99, 0.57, 1999n, 57n],
  ['90071992547409.93', '0.01', 9007199254740993n, 1n],
] as const;

it('[AC-B1-09k#1] 维权单：浮点不安全的金额（文本格与数字格）精确换算到分，写入的 order_rights 同值', async () => {
  const f = await setup(h.db);
  const processor = f.processor('rights');
  const task = f.task();
  const orders: string[] = [];
  for (const [amount, deduction] of CASES) {
    const o = await f.order();
    orders.push(o.order_id);
    const row = rightsRow(o.sub_order_id, { amount, deduction_commission: deduction });
    expect(await processor.process(task, row)).toEqual(SUCCEEDED);
  }
  const expected = CASES.map(([, , amountFen, deductionFen]) => [amountFen, deductionFen]);
  expect(f.calls.map((c) => [c.input.amount_fen, c.input.deduction_commission_fen])).toEqual(
    expected,
  );
  const byOrder = new Map(
    (await f.rights()).map((r) => [r.order_id, [r.amount_fen, r.deduction_commission_fen]]),
  );
  expect(orders.map((id) => byOrder.get(id))).toEqual(expected);
});

it('[AC-B1-09k#2] 违规单：同样精确换算（0.29 → 29 分、1.15 → 115 分、数字格 0.29 → 29 分）', async () => {
  const f = await setup(h.db);
  const processor = f.processor('punish');
  const task = f.task({ kind: 'punish' });
  const cases = [
    ['0.29', '1.15', 29n, 115n],
    [0.29, 0.07, 29n, 7n],
  ] as const;
  for (const [amount, deduction] of cases) {
    const o = await f.order();
    const row = punishRow(o.sub_order_id, { amount, deduction_commission: deduction });
    expect(await processor.process(task, row)).toEqual(SUCCEEDED);
  }
  expect(
    f.calls.map((c) => [c.input.type, c.input.amount_fen, c.input.deduction_commission_fen]),
  ).toEqual(cases.map(([, , amountFen, deductionFen]) => ['PUNISH', amountFen, deductionFen]));
});
