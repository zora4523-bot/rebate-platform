// 渠道单单元格的取值口径（编排定，规则测试评审 r1 S2）：
//   - end_at 文本带 Z 或时区偏移 → 按其本身；不带偏移 → 按 +08:00 解析（与会计日 / 结算月口径一致），
//     不看服务器本地时区（容器是 UTC）；
//   - relation_id 文本先去首尾空白，再判空与写入（写入与重复判定都用去空白后的值）；
//   - relation_id 是数字单元格：整数 → 按十进制文本处理；非整数（含 NaN、Infinity）→ invalid_row。
// 用例全部是顶层 it（规划/11 §4.3）。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { RightsImportCell } from '../../../../apps/api/src/modules/orders/application/rights-import-ports.ts';
import {
  END_AT,
  END_TEXT,
  IMPORTED,
  INVALID_ROW,
  RELATION,
  at,
  open,
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

// ---------------------------------------------------------------- end_at 文本的时区

const END_TEXTS: readonly [string, string, string][] = [
  ['不带偏移、空格分隔（按 +08:00）', '2026-10-31 00:00:00', END_AT],
  ['不带偏移、T 分隔（按 +08:00）', '2026-10-31T00:00:00', END_AT],
  ['不带偏移、非整点（按 +08:00）', '2026-10-31 09:30:15', '2026-10-31T01:30:15.000Z'],
  ['带 Z（按其本身）', '2026-10-31T00:00:00Z', '2026-10-31T00:00:00.000Z'],
  ['带 +09:00（按其本身）', '2026-10-31T09:00:00+09:00', '2026-10-31T00:00:00.000Z'],
  ['带 +08:00（按其本身）', END_TEXT, END_AT],
];

it.each(END_TEXTS)(
  '[AC-B1-09h#1] end_at 文本%s：%s → 名单 end_at = %s',
  async (_label, text, instant) => {
    const f = await setup(h.db);
    expect(await f.run(RELATION, text)).toEqual({ kind: 'succeeded' });
    expect((await f.entries()).map((e) => e.end_at)).toEqual([at(instant)]);
    const rows = f.importChannels.mock.calls.flatMap(([, input]) => input.rows);
    expect(rows).toEqual([{ relation_id: RELATION, end_at: at(instant) }]);
  },
);

// 受理时刻 IMPORTED = 2026-10-10T15:00+08:00。不带偏移的「15:00:00」按 +08:00 就是 start_at（不晚于 → 格式错）；
// 若按 UTC 读成 15:00Z 则晚于 start_at 8 小时、被误收。
it('[AC-B1-09h#3] end_at 不带偏移、按 +08:00 恰等于 start_at（任务受理时刻）→ invalid_row，不写名单', async () => {
  const f = await setup(h.db);
  expect(await f.run(RELATION, '2026-10-10 15:00:00')).toEqual(INVALID_ROW);
  expect(await f.entries()).toEqual([]);
  expect(f.importChannels).not.toHaveBeenCalled();
});

it('[AC-B1-09h#3] end_at 不带偏移、按 +08:00 晚于 start_at 1 秒：合法，end_at = start_at + 1 秒', async () => {
  const f = await setup(h.db);
  expect(await f.run(RELATION, '2026-10-10T15:00:01')).toEqual({ kind: 'succeeded' });
  const endAt = new Date(at(IMPORTED).getTime() + 1_000);
  expect((await f.entries()).map((e) => [e.start_at, e.end_at])).toEqual([[at(IMPORTED), endAt]]);
});

// ---------------------------------------------------------------- relation_id 的首尾空白

it.each([
  ['首尾空格', ` ${RELATION} `],
  ['首尾制表符与换行', `\t${RELATION}\n`],
  ['只有前导空格', `   ${RELATION}`],
])(
  '[AC-B1-09h#1] relation_id %s：去空白后写入，名单 value 是不带空白的值',
  async (_label, cell) => {
    const f = await setup(h.db);
    expect(await f.run(cell, null)).toEqual({ kind: 'succeeded' });
    expect((await f.entries()).map((e) => e.value)).toEqual([RELATION]);
    const rows = f.importChannels.mock.calls.flatMap(([, input]) => input.rows);
    expect(rows).toEqual([{ relation_id: RELATION, end_at: null }]);
  },
);

it('[AC-B1-09h#2] relation_id 带首尾空白、已有同号生效条目 → duplicate，不插', async () => {
  const f = await setup(h.db);
  await f.seedEntry();
  const before = await f.entries();
  expect(await f.run(`  ${RELATION}  `, null)).toEqual({ kind: 'duplicate' });
  expect(await f.entries()).toEqual(before);
});

it('[AC-B1-09h#2] 先导入带空白的号、再导入不带空白的同号 → 第二次 duplicate，名单只一条', async () => {
  const f = await setup(h.db);
  const processor = f.processor();
  const task = f.task();
  const row = (cell: RightsImportCell, rowNo: number) => ({
    row_no: rowNo,
    values: { relation_id: cell, end_at: null },
  });
  expect(await processor.process(task, row(` ${RELATION}\t`, 2))).toEqual({ kind: 'succeeded' });
  expect(await processor.process(task, row(RELATION, 3))).toEqual({ kind: 'duplicate' });
  expect((await f.entries()).map((e) => e.value)).toEqual([RELATION]);
});

// ---------------------------------------------------------------- relation_id 是数字单元格

it.each([
  ['十位整数', Number(RELATION), RELATION],
  ['十四位整数', 12_345_678_901_234, '12345678901234'],
] as const)(
  '[AC-B1-09h#1] relation_id 是数字格（%s）：按十进制文本写入',
  async (_label, cell, text) => {
    const f = await setup(h.db);
    expect(await f.run(cell, null)).toEqual({ kind: 'succeeded' });
    expect((await f.entries()).map((e) => e.value)).toEqual([text]);
    const rows = f.importChannels.mock.calls.flatMap(([, input]) => input.rows);
    expect(rows).toEqual([{ relation_id: text, end_at: null }]);
  },
);

it('[AC-B1-09h#2] relation_id 是整数数字格、已有同号（文本）生效条目 → duplicate，不插', async () => {
  const f = await setup(h.db);
  await f.seedEntry();
  const before = await f.entries();
  expect(await f.run(Number(RELATION), null)).toEqual({ kind: 'duplicate' });
  expect(await f.entries()).toEqual(before);
});

it.each([
  ['带小数', 2_876_543_210.5],
  ['小于 1 的小数', 0.25],
  ['NaN', Number.NaN],
  ['正无穷', Number.POSITIVE_INFINITY],
] as const)(
  '[AC-B1-09h#3] relation_id 是非整数数字格（%s）→ invalid_row，不写名单',
  async (_label, cell) => {
    const f = await setup(h.db);
    expect(await f.run(cell, END_TEXT)).toEqual(INVALID_ROW);
    expect(await f.entries()).toEqual([]);
    expect(f.importChannels).not.toHaveBeenCalled();
  },
);
