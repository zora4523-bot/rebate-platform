// 渠道单逐行写入名单（08 BR-ATTR-26 ②、细则「渠道单导入」）：kind=channel 的一行（relation_id、可选
// end_at）经 risk 的渠道单写入端口写一条 dimension=channel 的名单：union_account_id 取任务、start_at =
// 任务受理时刻（K-5，不是处理时刻）、end_at 空 = 持续生效；交给处理器的事务（检查点同一事务）里写、
// 不自行提交。用例全部是顶层 it（归属 / 资金测试路径，规划/11 §4.3）。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  END_AT,
  END_TEXT,
  IMPORTED,
  OTHER_RELATION,
  PROCESSED,
  RELATION,
  at,
  entryView,
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

const ROLLBACK = 'synthetic rollback of the checkpoint transaction';

it('[AC-B1-09h#1] 正常行：写一条渠道名单，app、union_account_id 取任务，start_at = 任务受理时刻，end_at 取行', async () => {
  const f = await setup(h.db);
  expect(await f.run(RELATION, END_TEXT)).toEqual({ kind: 'succeeded' });
  const entries = await f.entries();
  expect(entries.map(entryView)).toEqual([
    {
      app_id: f.appId,
      dimension: 'channel',
      value: RELATION,
      value_hmac: null,
      platform: 'taobao',
      union_account_id: f.accountId,
      start_at: at(IMPORTED),
      end_at: at(END_AT),
      expire_at: null,
      status: 'active',
      violation_type: 'other',
      created_by: f.adminId,
    },
  ]);
});

it('[AC-B1-09h#1] end_at 为空：长期条目（end_at 为 null，持续生效）', async () => {
  const f = await setup(h.db);
  expect(await f.run(RELATION, null)).toEqual({ kind: 'succeeded' });
  const entries = await f.entries();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    dimension: 'channel',
    value: RELATION,
    union_account_id: f.accountId,
    start_at: at(IMPORTED),
    end_at: null,
    status: 'active',
  });
});

it('[AC-B1-09h#1] end_at 是表格的日期格：按该绝对时刻写入', async () => {
  const f = await setup(h.db);
  expect(await f.run(RELATION, at(END_AT))).toEqual({ kind: 'succeeded' });
  expect((await f.entries()).map((e) => e.end_at)).toEqual([at(END_AT)]);
});

it('[AC-B1-09h#1] start_at 取任务受理时刻、不取处理时刻：处理晚于 end_at 也照写（只比 start_at）', async () => {
  const f = await setup(h.db);
  // end_at 晚于受理 1 秒、早于处理时刻：按「不晚于 start_at 才算格式错」，这一行合法。
  const endAt = plusMs(IMPORTED, 1_000);
  expect(endAt.getTime()).toBeLessThan(at(PROCESSED).getTime());
  expect(await f.run(RELATION, endAt.toISOString())).toEqual({ kind: 'succeeded' });
  expect((await f.entries()).map((e) => [e.start_at, e.end_at])).toEqual([[at(IMPORTED), endAt]]);
});

it('[AC-B1-09h#1] 经 risk 的渠道单写入端口写名单：任务的 app、平台、账号、管理员与受理时刻，一行一条', async () => {
  const f = await setup(h.db);
  expect(await f.run(RELATION, END_TEXT)).toEqual({ kind: 'succeeded' });
  expect(f.importChannels).toHaveBeenCalled();
  const inputs = f.importChannels.mock.calls.map(([, input]) => input);
  for (const input of inputs) {
    expect(input).toMatchObject({
      app_id: f.appId,
      platform: 'taobao',
      union_account_id: f.accountId,
      created_by: f.adminId,
      imported_at: at(IMPORTED),
    });
  }
  expect(inputs.flatMap((input) => input.rows)).toEqual([
    { relation_id: RELATION, end_at: at(END_AT) },
  ]);
  const results = await Promise.all(
    f.importChannels.mock.results.map((r) => r.value as Promise<unknown>),
  );
  const written = await f.entries();
  expect(results.flat()).toEqual([{ status: 'inserted', blocklist_id: written[0]!.id }]);
});

it('[AC-B1-09h#1] 同一处理器接连处理多行：各写一条，互不影响', async () => {
  const f = await setup(h.db);
  const processor = f.processor();
  const task = f.task();
  expect(await processor.process(task, rowOf(RELATION, null, 2))).toEqual({ kind: 'succeeded' });
  expect(await processor.process(task, rowOf(OTHER_RELATION, END_TEXT, 3))).toEqual({
    kind: 'succeeded',
  });
  const entries = await f.entries();
  expect(entries.map((e) => [e.value, e.end_at])).toEqual(
    expect.arrayContaining([
      [RELATION, null],
      [OTHER_RELATION, at(END_AT)],
    ]),
  );
  expect(entries).toHaveLength(2);
});

// ---------------------------------------------------------------- 检查点同一事务（任务书补充：money S2）

it('[AC-B1-09h#5] 交给处理器的事务回滚：这一行什么都不留（在该事务里写、不自行提交）', async () => {
  const f = await setup(h.db);
  const processor = f.processor();
  const task = f.task();
  const sentinel = new Error(ROLLBACK);
  let seen: number | undefined;
  await expect(
    h.db.transaction().execute(async (trx) => {
      expect(await processor.process(task, rowOf(RELATION), trx)).toEqual({ kind: 'succeeded' });
      const inside = await trx
        .selectFrom('blocklist')
        .select('id')
        .where('app_id', '=', f.appId)
        .execute();
      seen = inside.length;
      throw sentinel;
    }),
  ).rejects.toBe(sentinel);
  expect(seen).toBe(1);
  expect(await f.entries()).toEqual([]);
});

it('[AC-B1-09h#5] 交给处理器的事务提交：名单随之提交；同一行再来一次计 duplicate、不再插', async () => {
  const f = await setup(h.db);
  const processor = f.processor();
  const task = f.task();
  const first = await h.db
    .transaction()
    .execute(async (trx) => processor.process(task, rowOf(RELATION), trx));
  expect(first).toEqual({ kind: 'succeeded' });
  expect(await f.entries()).toHaveLength(1);
  const again = await h.db
    .transaction()
    .execute(async (trx) => processor.process(task, rowOf(RELATION), trx));
  expect(again).toEqual({ kind: 'duplicate' });
  expect(await f.entries()).toHaveLength(1);
});
