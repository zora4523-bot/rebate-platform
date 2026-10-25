// 渠道单重复生效条目（任务书补充，K-5，同 B1-09a 端口口径）：同 App、同 union_account_id、同 relation_id
// 已有 status=active 且 end_at 为空或晚于导入时刻（任务受理时刻）的条目 → duplicate（计 duplicate_rows），
// 不插、既有条目不改；已过期（end_at 不晚于导入时刻）、已停用、别的账号或别的 App 的条目不算重复。
// 用例全部是顶层 it（规划/11 §4.3）。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  EARLIER,
  END_TEXT,
  IMPORTED,
  OTHER_RELATION,
  RELATION,
  at,
  newAppId,
  open,
  plusMs,
  rowOf,
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

it('[AC-B1-09h#2] 已有持续生效（end_at 为空）的同号条目 → duplicate，不插，既有条目不变', async () => {
  const f = await setup(h.db);
  const existing = await f.seedEntry();
  const before = await f.entries();
  expect(await f.run(RELATION, END_TEXT)).toEqual({ kind: 'duplicate' });
  expect(await f.entries()).toEqual(before);
  expect(before.map((e) => e.id)).toEqual([existing]);
});

it('[AC-B1-09h#2] 已有 end_at 晚于导入时刻 1 秒的同号条目 → duplicate，不插', async () => {
  const f = await setup(h.db);
  await f.seedEntry({ end_at: plusMs(IMPORTED, 1_000) });
  const before = await f.entries();
  expect(await f.run(RELATION, null)).toEqual({ kind: 'duplicate' });
  expect(await f.entries()).toEqual(before);
});

it.each([
  ['end_at 等于导入时刻', IMPORTED],
  ['end_at 早于导入时刻', '2026-10-05T00:00:00.000Z'],
])('[AC-B1-09h#2] 已过期条目（%s）不算重复：照常插入新条目，旧条目不改', async (_label, endIso) => {
  const f = await setup(h.db);
  const old = await f.seedEntry({ end_at: at(endIso) });
  const [before] = await f.entries();
  expect(await f.run(RELATION, null)).toEqual({ kind: 'succeeded' });
  const entries = await f.entries();
  expect(entries).toHaveLength(2);
  expect(entries.find((e) => e.id === old)).toEqual(before);
  expect(entries.find((e) => e.id !== old)).toMatchObject({
    value: RELATION,
    union_account_id: f.accountId,
    start_at: at(IMPORTED),
    end_at: null,
    status: 'active',
  });
});

it('[AC-B1-09h#2] 已停用（inactive）的同号条目不算重复：照常插入', async () => {
  const f = await setup(h.db);
  await f.seedEntry({ status: 'inactive' });
  expect(await f.run(RELATION, null)).toEqual({ kind: 'succeeded' });
  const entries = await f.entries();
  expect(entries.map((e) => e.status).sort()).toEqual(['active', 'inactive']);
});

it('[AC-B1-09h#2] 同 App 别的联盟账号的同号条目不算重复：照常插入', async () => {
  const f = await setup(h.db);
  const other = await f.account('taobao');
  await f.seedEntry({ union_account_id: other });
  expect(await f.run(RELATION, null)).toEqual({ kind: 'succeeded' });
  const entries = await f.entries();
  expect(entries.map((e) => e.union_account_id).sort()).toEqual([f.accountId, other].sort());
});

it('[AC-B1-09h#2] 别的 App 的同号同账号条目不算重复：照常插入', async () => {
  const f = await setup(h.db);
  const otherApp = newAppId();
  await f.seedEntry({ app_id: otherApp });
  expect(await f.run(RELATION, null)).toEqual({ kind: 'succeeded' });
  expect(await f.entries()).toHaveLength(1);
  expect(await f.entries(otherApp)).toHaveLength(1);
});

it('[AC-B1-09h#2] 同账号别的 relation_id 的生效条目不算重复：照常插入', async () => {
  const f = await setup(h.db);
  await f.seedEntry({ value: OTHER_RELATION });
  expect(await f.run(RELATION, null)).toEqual({ kind: 'succeeded' });
  expect((await f.entries()).map((e) => e.value).sort()).toEqual([RELATION, OTHER_RELATION].sort());
});

it('[AC-B1-09h#2] 同一文件里同号出现两次：第一行插入，第二行 duplicate，名单只一条', async () => {
  const f = await setup(h.db);
  const processor = f.processor();
  const task = f.task();
  expect(await processor.process(task, rowOf(RELATION, null, 2))).toEqual({ kind: 'succeeded' });
  expect(await processor.process(task, rowOf(RELATION, END_TEXT, 3))).toEqual({
    kind: 'duplicate',
  });
  const entries = await f.entries();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ value: RELATION, end_at: null });
});

it('[AC-B1-09h#2] 早先导入的条目对后来的导入算重复（后一次任务的受理时刻落在其生效区间内）', async () => {
  const f = await setup(h.db);
  // 早先一次导入（受理于 EARLIER、end_at 晚于本次受理时刻）写下的条目，经处理器本身写入。
  const earlier = { created_at: at(EARLIER) };
  expect(await f.run(RELATION, END_TEXT, earlier)).toEqual({ kind: 'succeeded' });
  expect(await f.run(RELATION, null)).toEqual({ kind: 'duplicate' });
  const entries = await f.entries();
  expect(entries).toHaveLength(1);
  expect(entries[0]!.start_at).toEqual(at(EARLIER));
});
