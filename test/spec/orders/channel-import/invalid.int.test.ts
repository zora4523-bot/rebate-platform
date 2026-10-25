// 渠道单逐行失败（任务书补充「结果映射」）：relation_id 缺失或格式错、end_at 不可解析或不晚于 start_at
// （= 任务受理时刻）→ invalid_row；任务账号所属平台与任务 platform 不符 → platform_mismatch。失败的行
// 什么都不写（不经名单端口）。用例全部是顶层 it（规划/11 §4.3）。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { RightsImportCell } from '../../../../apps/api/src/modules/orders/application/rights-import-ports.ts';
import {
  END_TEXT,
  IMPORTED,
  INVALID_ROW,
  PLATFORM_MISMATCH,
  RELATION,
  at,
  open,
  plusMs,
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

const BAD_RELATIONS: readonly [string, RightsImportCell][] = [
  ['空单元格（缺失）', null],
  ['空文本', ''],
  ['只有空白', '   '],
  ['布尔值', true],
  ['日期格', at(IMPORTED)],
];

it.each(BAD_RELATIONS)(
  '[AC-B1-09h#3] relation_id %s → invalid_row，不写名单',
  async (_label, relationId) => {
    const f = await setup(h.db);
    expect(await f.run(relationId, END_TEXT)).toEqual(INVALID_ROW);
    expect(await f.entries()).toEqual([]);
    expect(f.importChannels).not.toHaveBeenCalled();
  },
);

const BAD_ENDS: readonly [string, RightsImportCell][] = [
  ['不是时刻的文本', 'not-a-time'],
  ['布尔值', true],
  ['等于 start_at（任务受理时刻）', IMPORTED],
  ['等于 start_at 的日期格', at(IMPORTED)],
  ['早于 start_at 1 秒', plusMs(IMPORTED, -1_000).toISOString()],
  ['早于 start_at 一天的带偏移文本', '2026-10-09T15:00:00+08:00'],
];

it.each(BAD_ENDS)('[AC-B1-09h#3] end_at %s → invalid_row，不写名单', async (_label, endAt) => {
  const f = await setup(h.db);
  expect(await f.run(RELATION, endAt)).toEqual(INVALID_ROW);
  expect(await f.entries()).toEqual([]);
  expect(f.importChannels).not.toHaveBeenCalled();
});

it('[AC-B1-09h#3] end_at 晚于 start_at 1 秒：合法（边界不含等号）', async () => {
  const f = await setup(h.db);
  const endAt = plusMs(IMPORTED, 1_000);
  expect(await f.run(RELATION, endAt.toISOString())).toEqual({ kind: 'succeeded' });
  expect((await f.entries()).map((e) => e.end_at)).toEqual([endAt]);
});

it.each([
  ['jd', 'taobao'],
  ['pdd', 'taobao'],
  ['taobao', 'jd'],
] as const)(
  '[AC-B1-09h#4] 任务账号属 %s、任务 platform 为 %s → platform_mismatch，不写名单',
  async (accountPlatform, taskPlatform) => {
    const f = await setup(h.db);
    const accountId = await f.account(accountPlatform);
    const patch = { union_account_id: accountId, platform: taskPlatform };
    expect(await f.run(RELATION, END_TEXT, patch)).toEqual(PLATFORM_MISMATCH);
    expect(await f.entries()).toEqual([]);
    expect(f.importChannels).not.toHaveBeenCalled();
  },
);

it('[AC-B1-09h#4] 平台不符只看任务的账号：同 App 另有淘宝账号时，jd 账号 + jd 任务照常写入', async () => {
  const f = await setup(h.db);
  const jdAccount = await f.account('jd');
  expect(await f.run(RELATION, null, { union_account_id: jdAccount, platform: 'jd' })).toEqual({
    kind: 'succeeded',
  });
  const entries = await f.entries();
  expect(entries.map((e) => [e.platform, e.union_account_id])).toEqual([['jd', jdAccount]]);
});
