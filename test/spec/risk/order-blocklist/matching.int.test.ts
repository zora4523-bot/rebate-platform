import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { ABORT, START, END, databaseFixture, seedBlock, setup, state } from './kit.ts';

const database = databaseFixture();

it.each([
  ['3301987654123456', '123456', true],
  ['3301987654012345', '123456', false],
  ['9007199254740993012345', '012345', true],
  ['9007199254740993123456', '012345', false],
  ['000001', '000001', true],
  ['1', '000001', false],
  ['', '000000', false],
  [null, '000000', false],
  ['parentAbCdEf', 'AbCdEf', true],
  ['parentabcdef', 'AbCdEf', false],
  ['parent 12345', '012345', false],
  ['parent１２３４５６', '123456', false],
  ['parent😀12345', '😀12345', true],
] as const)(
  '[AC-B1-09a#1] 淘宝父单号 %s 与尾号 %s 按字符匹配（%s），不转数字或规范化',
  async (parent, value, matched) => {
    const db = database();
    const f = setup(db);
    const id = await seedBlock(db, f, { dimension: 'order_no_suffix', value });
    expect(await f.match({ trade_parent_id: parent })).toEqual(
      matched ? [{ blocklist_id: id, dimension: 'order_no_suffix', value }] : [],
    );
  },
);

it.each(['jd', 'pdd', 'douyin'])(
  '[AC-B1-09a#2] 非淘宝平台 %s 不检查淘宝父单尾号',
  async (platform) => {
    const db = database();
    const f = setup(db);
    await seedBlock(db, f, { dimension: 'order_no_suffix' });
    expect(await f.match({ platform })).toEqual([]);
  },
);

it('[AC-B1-09a#3] 尾号仅匹配当前 app 的 active 条目，忽略旧 relation_id 维度', async () => {
  const db = database();
  const f = setup(db);
  await seedBlock(db, f, { dimension: 'order_no_suffix', status: 'inactive' });
  await seedBlock(db, f, { dimension: 'order_no_suffix', app_id: `${f.app}_other` });
  await db
    .insertInto('blocklist')
    .values({
      id: randomUUID(),
      app_id: f.app,
      dimension: 'relation_id',
      value_hmac: f.crypto.blindIndex('R8', 'blocklist.relation_id'),
      violation_type: 'other',
      status: 'active',
      created_by: 'fixture',
      expire_at: END,
    })
    .execute();
  expect(await f.match()).toEqual([]);
});

it.each([
  ['2026-10-10T06:59:59.999Z', false],
  ['2026-10-10T07:00:00.000Z', true],
  ['2026-10-10T15:00:00+08:00', true],
  ['2026-10-30T15:59:59.999Z', true],
  ['2026-10-30T16:00:00.000Z', false],
  ['2026-10-31T00:00:00+08:00', false],
  ['2026-10-31T00:00:00.001+08:00', false],
] as const)('[AC-B1-09a#4] 渠道 attr_at=%s 按绝对时刻及半开区间命中=%s', async (at, matched) => {
  const db = database();
  const f = setup(db);
  const id = await seedBlock(db, f, { end_at: END });
  expect(await f.match({ attr_at: new Date(at) })).toEqual(
    matched ? [{ blocklist_id: id, dimension: 'channel', value: 'R8' }] : [],
  );
});

it('[AC-B1-09a#5] 渠道 end_at 为空持续生效，名单 expire_at 与执行时钟不替代 attr_at', async () => {
  const db = database();
  const f = setup(db);
  const id = await seedBlock(db, f, { expire_at: new Date('2020-01-01T00:00:00Z') });
  f.clock.set('2099-01-01T00:00:00Z');
  const hit = [{ blocklist_id: id, dimension: 'channel', value: 'R8' }];
  expect(await f.match({ attr_at: START })).toEqual(hit);
  expect(await f.match({ attr_at: new Date('2100-01-01T00:00:00Z') })).toEqual(hit);
  expect(await f.match({ attr_at: new Date(START.getTime() - 1) })).toEqual([]);
});

it('[AC-B1-09a#6] 渠道按 app、union_account_id、relation_id 和 active 精确隔离', async () => {
  const db = database();
  const f = setup(db);
  await seedBlock(db, f, { app_id: `${f.app}_other` });
  await seedBlock(db, f, { union_account_id: randomUUID() });
  await seedBlock(db, f, { value: 'r8' });
  await seedBlock(db, f, { value: 'R8 ' });
  await seedBlock(db, f, { status: 'inactive' });
  expect(await f.match()).toEqual([]);
  const id = await seedBlock(db, f);
  expect(await f.match()).toEqual([{ blocklist_id: id, dimension: 'channel', value: 'R8' }]);
  expect(await f.match({ union_account_id: null })).toEqual([]);
  expect(await f.match({ relation_id: null })).toEqual([]);
  expect(await f.match({ relation_id: '' })).toEqual([]);
});

it('[AC-B1-09a#7] 两维度可同时返回；只读事务查询不登记规则或命中、不更改名单', async () => {
  const db = database();
  const f = setup(db);
  const channel = await seedBlock(db, f);
  const suffix = await seedBlock(db, f, { dimension: 'order_no_suffix' });
  const before = await state(db, f.app);
  const result = await db.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    return f.ports.match(trx, f.query);
  });
  expect(result).toHaveLength(2);
  expect(result).toEqual(
    expect.arrayContaining([
      { blocklist_id: channel, dimension: 'channel', value: 'R8' },
      { blocklist_id: suffix, dimension: 'order_no_suffix', value: '123456' },
    ]),
  );
  expect(await state(db, f.app)).toEqual(before);
});

it('[AC-B1-09a#8] 查询使用调用方事务，可见未提交名单，回滚后不残留记录', async () => {
  const db = database();
  const f = setup(db);
  await expect(
    db.transaction().execute(async (trx) => {
      const id = await seedBlock(trx, f);
      expect(await f.ports.match(trx, f.query)).toEqual([
        { blocklist_id: id, dimension: 'channel', value: 'R8' },
      ]);
      throw ABORT;
    }),
  ).rejects.toBe(ABORT);
  expect(await f.match()).toEqual([]);
  expect(await state(db, f.app)).toEqual({ blocks: [], hits: [], rules: [] });
});

it.each(['jd', 'pdd'])(
  '[AC-B1-09a#22] 渠道维度在 %s 也按账号和区间匹配，不受淘宝尾号平台限制',
  async (platform) => {
    const db = database();
    const f = setup(db);
    const id = await seedBlock(db, f, { platform });
    await seedBlock(db, f, { dimension: 'order_no_suffix' });
    expect(await f.match({ platform })).toEqual([
      { blocklist_id: id, dimension: 'channel', value: 'R8' },
    ]);
  },
);
