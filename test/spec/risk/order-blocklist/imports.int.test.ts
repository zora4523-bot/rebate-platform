import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ABORT, START, END, databaseFixture, seedBlock, setup, state } from './kit.ts';

const database = databaseFixture();

it('[AC-B1-09a#9] 批量导入逐行保存，start_at 取导入时刻，end_at 可空，管理员及 other 正确', async () => {
  const db = database();
  const f = setup(db);
  const rows = [
    { relation_id: 'R8', end_at: null },
    { relation_id: '000009', end_at: END },
  ];
  const result = await db.transaction().execute((trx) =>
    f.ports.importChannels(trx, {
      ...f.importInput,
      rows,
    }),
  );
  expect(result).toHaveLength(2);
  expect(result.map((row) => row.status)).toEqual(['inserted', 'inserted']);
  expect(new Set(result.map((row) => row.blocklist_id)).size).toBe(2);
  const stored = await state(db, f.app);
  expect(stored.blocks).toHaveLength(2);
  for (const [index, row] of rows.entries()) {
    expect(stored.blocks.find((block) => block.id === result[index]!.blocklist_id)).toMatchObject({
      app_id: f.app,
      dimension: 'channel',
      platform: 'taobao',
      union_account_id: f.account,
      value: row.relation_id,
      value_hmac: null,
      start_at: START,
      end_at: row.end_at,
      violation_type: 'other',
      status: 'active',
      created_by: f.importInput.created_by,
    });
  }
  expect(stored.hits).toEqual([]);
  expect(stored.rules).toEqual([]);
  expect(await f.match({ attr_at: new Date(START.getTime() - 1) })).toEqual([]);
  expect(await f.match({ attr_at: START })).toEqual([
    { blocklist_id: result[0]!.blocklist_id, dimension: 'channel', value: 'R8' },
  ]);
});

it.each([
  { name: 'active 无截止', status: 'active', end: null, future: false, duplicate: true },
  {
    name: 'active 截止晚 1ms',
    status: 'active',
    end: new Date(START.getTime() + 1),
    future: false,
    duplicate: true,
  },
  {
    name: 'active 截止恰好导入时刻',
    status: 'active',
    end: START,
    future: false,
    duplicate: false,
  },
  {
    name: 'active 已截止',
    status: 'active',
    end: new Date(START.getTime() - 1),
    future: false,
    duplicate: false,
  },
  { name: 'inactive 无截止', status: 'inactive', end: null, future: false, duplicate: false },
  { name: 'inactive 未截止', status: 'inactive', end: END, future: false, duplicate: false },
  // K-5 重复口径没有 start_at 条件；不能错误复用订单 attr_at 区间匹配。
  { name: 'active 未来开始但未截止', status: 'active', end: null, future: true, duplicate: true },
])('[AC-B1-09a#10] K-5 重复判定：$name', async ({ status, end, future, duplicate }) => {
  const db = database();
  const f = setup(db);
  const id = await seedBlock(db, f, {
    status,
    end_at: end,
    start_at: new Date(START.getTime() + (future ? 60_000 : -60_000)),
  });
  const before = await state(db, f.app);
  const result = await db
    .transaction()
    .execute((trx) => f.ports.importChannels(trx, f.importInput));
  expect(result).toHaveLength(1);
  expect(result[0]!.status).toBe(duplicate ? 'duplicate' : 'inserted');
  const after = await state(db, f.app);
  expect(after.blocks.find((block) => block.id === id)).toEqual(before.blocks[0]);
  expect(after.blocks).toHaveLength(duplicate ? 1 : 2);
  if (duplicate) expect(result[0]!.blocklist_id).toBe(id);
  else expect(result[0]!.blocklist_id).not.toBe(id);
});

it('[AC-B1-09a#11] 同批重复和重试返回 duplicate，既有条目不改管理员、时间或截止日期', async () => {
  const db = database();
  const f = setup(db);
  const input = {
    ...f.importInput,
    rows: [
      { relation_id: 'R8', end_at: null },
      { relation_id: 'R8', end_at: END },
      { relation_id: 'R9', end_at: END },
    ],
  };
  const first = await db.transaction().execute((trx) => f.ports.importChannels(trx, input));
  expect(first.map((row) => row.status)).toEqual(['inserted', 'duplicate', 'inserted']);
  expect(first[1]!.blocklist_id).toBe(first[0]!.blocklist_id);
  const before = await state(db, f.app);
  f.clock.set('2099-01-01T00:00:00Z');
  const again = await db.transaction().execute((trx) =>
    f.ports.importChannels(trx, {
      ...input,
      created_by: 'different-admin',
    }),
  );
  expect(again).toEqual(first.map((row) => ({ ...row, status: 'duplicate' })));
  expect(await state(db, f.app)).toEqual(before);
});

it('[AC-B1-09a#12] 导入重复键区分 app、联盟账号和精确 relation_id，不与尾号混淆', async () => {
  const db = database();
  const f = setup(db);
  await seedBlock(db, f, { app_id: `${f.app}_other` });
  await seedBlock(db, f, { union_account_id: randomUUID() });
  await seedBlock(db, f, { value: 'r8' });
  await seedBlock(db, f, { dimension: 'order_no_suffix', value: '123456' });
  const result = await db.transaction().execute((trx) =>
    f.ports.importChannels(trx, {
      ...f.importInput,
      rows: [
        { relation_id: 'R8', end_at: null },
        { relation_id: '123456', end_at: null },
        { relation_id: '000008', end_at: null },
        { relation_id: '8', end_at: null },
      ],
    }),
  );
  expect(result.map((row) => row.status)).toEqual(['inserted', 'inserted', 'inserted', 'inserted']);
  expect(new Set(result.map((row) => row.blocklist_id)).size).toBe(4);
  expect((await state(db, `${f.app}_other`)).blocks).toHaveLength(1);
});

it('[AC-B1-09a#13] 空批不写入；导入借用调用方事务，回滚整批且不独立提交', async () => {
  const db = database();
  const f = setup(db);
  expect(
    await db.transaction().execute((trx) =>
      f.ports.importChannels(trx, {
        ...f.importInput,
        rows: [],
      }),
    ),
  ).toEqual([]);
  await expect(
    db.transaction().execute(async (trx) => {
      const result = await f.ports.importChannels(trx, f.importInput);
      expect(result[0]!.status).toBe('inserted');
      expect(await f.ports.match(trx, f.query)).toEqual([
        { blocklist_id: result[0]!.blocklist_id, dimension: 'channel', value: 'R8' },
      ]);
      const duplicate = await f.ports.importChannels(trx, f.importInput);
      expect(duplicate).toEqual([{ ...result[0], status: 'duplicate' }]);
      throw ABORT;
    }),
  ).rejects.toBe(ABORT);
  expect(await state(db, f.app)).toEqual({ blocks: [], hits: [], rules: [] });
});

it('[AC-B1-09a#14] 两个并发导入事务只有一份生效条目，另一份返回 duplicate', async () => {
  const db = database();
  const f = setup(db);
  const results = await Promise.all(
    [0, 1].map(() => db.transaction().execute((trx) => f.ports.importChannels(trx, f.importInput))),
  );
  expect(
    results
      .flat()
      .map((row) => row.status)
      .sort(),
  ).toEqual(['duplicate', 'inserted']);
  expect(new Set(results.flat().map((row) => row.blocklist_id)).size).toBe(1);
  expect((await state(db, f.app)).blocks).toHaveLength(1);
});
