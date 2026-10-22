// 仅验证 BR-CALC-02、BR-FUND-04 ⑪、BR-FUND-18 的读取口径。
// 真实 PG 存订单与分佣快照；无余额写入、无联盟请求，不覆盖批次和资产快照调度。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { addFen } from '@couli/money';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createPendingEarningsSource } from '../../../../apps/api/src/modules/settlement/reads/pending-earnings.ts';
import { emptyUser, harness, scope, seed } from './fixtures.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
let readonlyDb: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonlyDb = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
}, 60_000);

afterAll(async () => {
  try {
    if (readonlyDb) await destroyDb(readonlyDb);
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 60_000);

it('[AC-B2-04x#1] BR-FUND-18 空用户与空 app 返回零、null、false', async () => {
  const f = await scope(db);
  const source = harness().source();
  await db.transaction().execute(async (trx) => {
    expect(await source.forUser(trx, f)).toEqual(emptyUser);
    expect(await source.forApp(trx, f)).toEqual({ total_waiting_fen: 0n, total_estimated_fen: 0n });
  });
});

it('[AC-B2-04x#2] BR-FUND-18 按状态分类，排除定金、未归属、已入账、失效和扣回', async () => {
  const f = await scope(db);
  await seed(db, f);
  await seed(db, f, {
    order: { rebate_status: 'WAITING', platform_status: 'RECEIVED', settle_period: '2026-10' },
  });
  await seed(db, f, {
    order: { rebate_status: 'WAITING', platform_status: 'SETTLED', settle_period: '2026-10' },
  });
  for (const [rebate_status, platform_status] of [
    ['UNATTRIBUTED', 'PAID'],
    ['UNATTRIBUTED', 'DEPOSIT_PAID'],
    ['ESTIMATED', 'DEPOSIT_PAID'],
    ['ESTIMATED', 'RECEIVED'],
    ['CREDITED', 'SETTLED'],
    ['VOID', 'INVALID'],
    ['CLAWED_BACK', 'INVALID'],
  ] as const) {
    await seed(db, f, { order: { rebate_status, platform_status } });
  }
  const source = harness().source();
  await db.transaction().execute(async (trx) => {
    expect(await source.forUser(trx, f)).toEqual({
      ...emptyUser,
      estimated_total_fen: 1275n,
      estimated_fen: 425n,
      pending_credit_fen: 850n,
      next_credit_period: '2026-11',
    });
    expect(await source.forApp(trx, f)).toEqual({
      total_waiting_fen: 850n,
      total_estimated_fen: 425n,
    });
  });
});

it('[AC-B2-04x#3] BR-FUND-18 按快照任一角色归属汇总，同用户多角色各计一次，不按购买人过滤', async () => {
  const f = await scope(db);
  const buyer = randomUUID();
  await seed(db, f, {
    order: { user_id: buyer },
    people: [
      { userId: buyer, role: 'self', ratioBp: 5000 },
      { userId: f.userId, role: 'direct', ratioBp: 1000 },
      { userId: f.userId, role: 'indirect', ratioBp: 500 },
    ],
  });
  await seed(db, f, {
    order: { user_id: buyer },
    people: [{ userId: f.userId, role: 'share', ratioBp: 5000 }],
  });
  await seed(db, f);
  const source = harness().source();
  await db.transaction().execute(async (trx) => {
    expect(await source.forUser(trx, f)).toEqual({
      ...emptyUser,
      estimated_total_fen: 977n,
      estimated_fen: 977n,
    });
    expect(await source.forUser(trx, { ...f, userId: buyer })).toEqual({
      ...emptyUser,
      estimated_total_fen: 425n,
      estimated_fen: 425n,
    });
    expect(await source.forUser(trx, { ...f, userId: randomUUID() })).toEqual(emptyUser);
    // 所有用户份额之和，排除平台预留和留存，也不能按人关联重复累计订单。
    expect(await source.forApp(trx, f)).toEqual({
      total_waiting_fen: 0n,
      total_estimated_fen: 1402n,
    });
  });
});

it.each([
  {
    name: '无结算时取最新预估并向下取整',
    est: 1001n,
    settle: null,
    reserve: 1500,
    deduct: 0n,
    ratio: 5000,
    expected: 425n,
  },
  {
    name: '结算优先于较高的预估',
    est: 9999n,
    settle: 2001n,
    reserve: 1500,
    deduct: 0n,
    ratio: 5000,
    expected: 850n,
  },
  {
    name: '结算零不能回退预估',
    est: 9999n,
    settle: 0n,
    reserve: 1500,
    deduct: 0n,
    ratio: 5000,
    expected: 0n,
  },
  {
    name: '结算负数先归零',
    est: 9999n,
    settle: -1n,
    reserve: 1500,
    deduct: 0n,
    ratio: 5000,
    expected: 0n,
  },
  {
    name: '无结算的负预估归零',
    est: -1n,
    settle: null,
    reserve: 1500,
    deduct: 0n,
    ratio: 5000,
    expected: 0n,
  },
  {
    name: '先扣预留再扣淘礼金',
    est: 1001n,
    settle: null,
    reserve: 1500,
    deduct: 101n,
    ratio: 5000,
    expected: 374n,
  },
  {
    name: '淘礼金超出基数钳到零',
    est: 1001n,
    settle: null,
    reserve: 1500,
    deduct: 851n,
    ratio: 5000,
    expected: 0n,
  },
  {
    name: '全额预留',
    est: 1001n,
    settle: null,
    reserve: 10000,
    deduct: 0n,
    ratio: 5000,
    expected: 0n,
  },
  {
    name: '无预留且超过 JS 安全整数',
    est: 9007199254740993n,
    settle: null,
    reserve: 0,
    deduct: 0n,
    ratio: 10000,
    expected: 9007199254740993n,
  },
])('[AC-B2-04x#4] BR-CALC-02 $name，用户与 app 都按有效佣金重算', async (c) => {
  const f = await scope(db);
  await seed(db, f, {
    order: { est_commission_fen: c.est, settle_commission_fen: c.settle },
    reserveBp: c.reserve,
    tljDeductFen: c.deduct,
    people: [{ userId: f.userId, role: 'self', ratioBp: c.ratio }],
  });
  await seed(db, f, {
    order: {
      rebate_status: 'WAITING',
      platform_status: 'RECEIVED',
      settle_period: '2026-10',
      est_commission_fen: c.est,
      settle_commission_fen: c.settle,
    },
    reserveBp: c.reserve,
    tljDeductFen: c.deduct,
    people: [{ userId: f.userId, role: 'self', ratioBp: c.ratio }],
  });
  const source = harness().source();
  await db.transaction().execute(async (trx) => {
    expect(await source.forUser(trx, f)).toEqual({
      ...emptyUser,
      estimated_total_fen: addFen(c.expected, c.expected),
      estimated_fen: c.expected,
      pending_credit_fen: c.expected,
      next_credit_period: '2026-11',
    });
    expect(await source.forApp(trx, f)).toEqual({
      total_waiting_fen: c.expected,
      total_estimated_fen: c.expected,
    });
  });
});

it('[AC-B2-04x#5] BR-CALC-02/BR-FUND-18 逐单逐角色取整，不能合并基数或比例后取整', async () => {
  const f = await scope(db);
  for (let i = 0; i < 2; i++) {
    await seed(db, f, {
      order: { est_commission_fen: 3n },
      reserveBp: 0,
      people: [
        { userId: f.userId, role: 'self', ratioBp: 3333 },
        { userId: f.userId, role: 'direct', ratioBp: 3333 },
      ],
    });
  }
  const source = harness().source();
  await db.transaction().execute(async (trx) => {
    expect(await source.forUser(trx, f)).toEqual(emptyUser);
    expect(await source.forApp(trx, f)).toEqual({ total_waiting_fen: 0n, total_estimated_fen: 0n });
  });
});

it('[AC-B2-04x#6] BR-FUND-18 暂缓是 hold 或维权的并集，关闭平台和逾期不扣除待入账金额', async () => {
  const f = await scope(db);
  for (const flags of [
    { hold: true },
    { rights_pending: true },
    { hold: true, rights_pending: true },
    { platform: 'jd' },
    {},
  ]) {
    await seed(db, f, {
      order: {
        rebate_status: 'WAITING',
        platform_status: 'RECEIVED',
        settle_period: '2026-08',
        ...flags,
      },
    });
  }
  // ESTIMATED 的 hold 不进入 pending_credit_paused_fen。
  await seed(db, f, { order: { hold: true } });
  const source = harness({ 'credit.enabled.jd': false }).source();
  await db.transaction().execute(async (trx) => {
    expect(await source.forUser(trx, f)).toEqual({
      estimated_total_fen: 2550n,
      estimated_fen: 425n,
      pending_credit_fen: 2125n,
      pending_credit_paused_fen: 1275n,
      next_credit_period: null,
      credit_overdue: true,
    });
    expect(await source.forApp(trx, f)).toEqual({
      total_waiting_fen: 2125n,
      total_estimated_fen: 425n,
    });
  });
});

it('[AC-B2-04x#7] BR-FUND-18 跨平台取最早合格月份，剔除暂缓、关闭、逾期并保留逾期标识', async () => {
  const f = await scope(db);
  for (const order of [
    { settle_period: '2026-11' },
    { settle_period: '2026-10', platform: 'jd' },
    { settle_period: '2026-09', hold: true },
    { settle_period: '2026-09', rights_pending: true },
    { settle_period: '2026-09', platform: 'pdd' },
    { settle_period: '2026-08' },
  ]) {
    await seed(db, f, {
      order: { rebate_status: 'WAITING', platform_status: 'RECEIVED', ...order },
    });
  }
  const source = harness({ 'credit.enabled.pdd': false }).source();
  const result = await db.transaction().execute((trx) => source.forUser(trx, f));
  expect(result).toEqual({
    ...emptyUser,
    estimated_total_fen: 2550n,
    pending_credit_fen: 2550n,
    pending_credit_paused_fen: 850n,
    next_credit_period: '2026-11',
    credit_overdue: true,
  });
});

it('[AC-B2-04x#8] BR-FUND-04 ⑪ 联盟结算时刻按北京时间所在月优先，且不受回补收货时间影响', async () => {
  const f = await scope(db);
  await seed(db, f, {
    order: {
      rebate_status: 'WAITING',
      platform_status: 'RECEIVED',
      settle_period: '2026-08',
      received_at: new Date('2026-09-30T16:00:00Z'),
      union_settled_at: new Date('2026-10-31T16:00:00Z'),
    },
  });
  const source = harness({ 'settle.period_offset_months.taobao': 5 }).source();
  expect(await db.transaction().execute((trx) => source.forUser(trx, f))).toEqual({
    ...emptyUser,
    estimated_total_fen: 425n,
    pending_credit_fen: 425n,
    next_credit_period: '2026-11',
  });
});

it('[AC-B2-04x#9] BR-FUND-04 ⑪ 无联盟时间按固化周期与各平台偏移跨年计算', async () => {
  const f = await scope(db);
  await seed(db, f, {
    order: {
      rebate_status: 'WAITING',
      platform_status: 'RECEIVED',
      settle_period: '2026-12',
      received_at: new Date('2027-02-01T00:00:00Z'),
    },
  });
  const h = harness({ 'settle.period_offset_months.taobao': 2 }, '2026-12-20T00:00:00Z');
  const source = h.source();
  expect(await db.transaction().execute((trx) => source.forUser(trx, f))).toEqual({
    ...emptyUser,
    estimated_total_fen: 425n,
    pending_credit_fen: 425n,
    next_credit_period: '2027-02',
  });
  await seed(db, f, {
    order: {
      platform: 'jd',
      rebate_status: 'WAITING',
      platform_status: 'RECEIVED',
      settle_period: '2026-12',
    },
  });
  h.clock.advanceMs(60_001);
  expect(await db.transaction().execute((trx) => source.forUser(trx, f))).toEqual({
    ...emptyUser,
    estimated_total_fen: 850n,
    pending_credit_fen: 850n,
    next_credit_period: '2027-01',
  });
});

it.each([
  { now: '2026-11-03T15:59:59.999Z', overdue: false, next: '2026-10' },
  { now: '2026-11-03T16:00:00.000Z', overdue: true, next: null },
])('[AC-B2-04x#10] BR-FUND-04 ⑪ 默认账单日24加10天，当前日期严格晚于才逾期：$now', async (c) => {
  const f = await scope(db);
  await seed(db, f, {
    order: { rebate_status: 'WAITING', platform_status: 'RECEIVED', settle_period: '2026-09' },
  });
  const source = harness({}, c.now).source();
  expect(await db.transaction().execute((trx) => source.forUser(trx, f))).toEqual({
    ...emptyUser,
    estimated_total_fen: 425n,
    pending_credit_fen: 425n,
    next_credit_period: c.next,
    credit_overdue: c.overdue,
  });
});

it('[AC-B2-04x#11] BR-FUND-04 ⑪ 使用配置的账单日、零宽限与零月偏移', async () => {
  const f = await scope(db);
  await seed(db, f, {
    order: { rebate_status: 'WAITING', platform_status: 'RECEIVED', settle_period: '2026-10' },
  });
  const source = harness(
    {
      'settle.bill_day': 22,
      'settle.statement.grace_days': 0,
      'settle.period_offset_months.taobao': 0,
    },
    '2026-10-22T16:00:00Z',
  ).source();
  expect(await db.transaction().execute((trx) => source.forUser(trx, f))).toEqual({
    ...emptyUser,
    estimated_total_fen: 425n,
    pending_credit_fen: 425n,
    credit_overdue: true,
  });
});

it.each([
  { name: 'hold', order: { hold: true }, enabled: true, paused: 425n },
  { name: '维权', order: { rights_pending: true }, enabled: true, paused: 425n },
  { name: '开关关闭', order: {}, enabled: false, paused: 0n },
  { name: '开关未配置默认关闭', order: {}, enabled: undefined, paused: 0n },
])('[AC-B2-04x#12] BR-FUND-04/18 $name 屏蔽预计月份与逾期，金额保留', async (c) => {
  const f = await scope(db);
  await seed(db, f, {
    order: {
      rebate_status: 'WAITING',
      platform_status: 'SETTLED',
      settle_period: '2026-01',
      union_settled_at: new Date('2026-02-01T00:00:00Z'),
      ...c.order,
    },
  });
  const source = harness({ 'credit.enabled.taobao': c.enabled }).source();
  expect(await db.transaction().execute((trx) => source.forUser(trx, f))).toEqual({
    ...emptyUser,
    estimated_total_fen: 425n,
    pending_credit_fen: 425n,
    pending_credit_paused_fen: c.paused,
  });
});

it('[AC-B2-04x#13] BR-FUND-18 用户、app、配置隔离，其他人的逾期不得污染当前用户', async () => {
  const f = await scope(db);
  const other = { ...(await scope(db)), userId: f.userId };
  await seed(db, f);
  await seed(db, f, {
    order: { rebate_status: 'WAITING', platform_status: 'RECEIVED', settle_period: '2026-01' },
    people: [{ userId: randomUUID(), role: 'self', ratioBp: 5000 }],
  });
  await seed(db, other, {
    order: {
      user_id: randomUUID(),
      rebate_status: 'WAITING',
      platform_status: 'RECEIVED',
      settle_period: '2026-10',
      est_commission_fen: 2000n,
    },
  });
  const h = harness();
  const source = createPendingEarningsSource({
    ...h.deps,
    config: {
      get: async (appId, key) => (key === 'credit.enabled.taobao' ? appId === f.appId : undefined),
    },
  });
  await db.transaction().execute(async (trx) => {
    expect(await source.forUser(trx, f)).toEqual({
      ...emptyUser,
      estimated_total_fen: 425n,
      estimated_fen: 425n,
    });
    expect(await source.forUser(trx, other)).toEqual({
      ...emptyUser,
      estimated_total_fen: 850n,
      pending_credit_fen: 850n,
    });
    expect(await source.forApp(trx, f)).toEqual({
      total_estimated_fen: 425n,
      total_waiting_fen: 425n,
    });
    expect(await source.forApp(trx, other)).toEqual({
      total_estimated_fen: 0n,
      total_waiting_fen: 850n,
    });
  });
});

it('[AC-B2-04x#14] BR-CALC-02 当前版本经快照端口读取，但金额以当前有效佣金重算', async () => {
  const f = await scope(db);
  const orderId = await seed(db, f, { order: { est_commission_fen: 201n } });
  const app = db.withSchema('app');
  const totals = await app
    .selectFrom('commission_split_totals')
    .selectAll()
    .where('app_id', '=', f.appId)
    .executeTakeFirstOrThrow();
  const amounts = await app
    .selectFrom('commission_split_amounts')
    .selectAll()
    .where('app_id', '=', f.appId)
    .execute();
  await app
    .insertInto('commission_split_totals')
    .values({
      ...totals,
      commission_version: 2,
      n_total_fen: 0n,
      pre_base_deduct_fen: 0n,
      base_fen: 0n,
      user_share_total_fen: 0n,
      platform_est_profit_fen: 0n,
    })
    .execute();
  await app
    .insertInto('commission_split_amounts')
    .values(amounts.map((a) => ({ ...a, commission_version: 2, base_fen: 0n, amount_fen: 0n })))
    .execute();
  await app
    .updateTable('orders')
    .set({ commission_version: 2 })
    .where('order_id', '=', orderId)
    .where('app_id', '=', f.appId)
    .execute();
  const h = harness();
  const readSnapshot = vi.fn(h.deps.readSnapshot);
  const source = createPendingEarningsSource({ ...h.deps, readSnapshot });
  expect(await db.transaction().execute((trx) => source.forUser(trx, f))).toEqual({
    ...emptyUser,
    estimated_total_fen: 85n,
    estimated_fen: 85n,
  });
  expect(readSnapshot).toHaveBeenCalledWith(expect.anything(), {
    appId: f.appId,
    orderId,
    commissionVersion: 2,
  });
});

it('[AC-B2-04x#15] BR-FUND-18 两个端口都能在只读角色与 READ ONLY 事务运行', async () => {
  const f = await scope(db);
  await seed(db, f);
  await seed(db, f, {
    order: { rebate_status: 'WAITING', platform_status: 'RECEIVED', settle_period: '2026-10' },
  });
  const source = harness().source();
  await readonlyDb.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    const result = await source.forUser(trx, f);
    expect(result).toEqual({
      ...emptyUser,
      estimated_total_fen: 850n,
      estimated_fen: 425n,
      pending_credit_fen: 425n,
      next_credit_period: '2026-11',
    });
    expect(await source.forUser(trx, f)).toEqual(result);
    expect(await source.forApp(trx, f)).toEqual({
      total_waiting_fen: 425n,
      total_estimated_fen: 425n,
    });
  });
});

it('[AC-B2-04x#16] BR-FUND-18 看见调用方事务内的订单变化，读取不提交调用方事务', async () => {
  const f = await scope(db);
  const orderId = await seed(db, f);
  const source = harness().source();
  const rollback = new Error('caller rollback');
  await expect(
    db.transaction().execute(async (trx) => {
      await trx
        .withSchema('app')
        .updateTable('orders')
        .set({ est_commission_fen: 2000n })
        .where('order_id', '=', orderId)
        .where('app_id', '=', f.appId)
        .execute();
      expect(await source.forUser(trx, f)).toEqual({
        ...emptyUser,
        estimated_total_fen: 850n,
        estimated_fen: 850n,
      });
      expect(await source.forApp(trx, f)).toEqual({
        total_waiting_fen: 0n,
        total_estimated_fen: 850n,
      });
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  const order = await db
    .withSchema('app')
    .selectFrom('orders')
    .select('est_commission_fen')
    .where('order_id', '=', orderId)
    .where('app_id', '=', f.appId)
    .executeTakeFirstOrThrow();
  expect(order.est_commission_fen).toBe(1000n);
});

it('[AC-B2-04x#17] BR-FUND-18 缓存最多60秒，结算到达后不再随预估变化', async () => {
  const f = await scope(db);
  const orderId = await seed(db, f);
  const h = harness();
  const source = h.source();
  expect((await db.transaction().execute((trx) => source.forUser(trx, f))).estimated_fen).toBe(
    425n,
  );
  expect(await db.transaction().execute((trx) => source.forApp(trx, f))).toEqual({
    total_waiting_fen: 0n,
    total_estimated_fen: 425n,
  });
  await db
    .withSchema('app')
    .updateTable('orders')
    .set({ settle_commission_fen: 2000n, est_commission_fen: 9999n })
    .where('order_id', '=', orderId)
    .where('app_id', '=', f.appId)
    .execute();
  h.clock.advanceMs(60_001);
  expect((await db.transaction().execute((trx) => source.forUser(trx, f))).estimated_fen).toBe(
    850n,
  );
  expect(await db.transaction().execute((trx) => source.forApp(trx, f))).toEqual({
    total_waiting_fen: 0n,
    total_estimated_fen: 850n,
  });
  await db
    .withSchema('app')
    .updateTable('orders')
    .set({ est_commission_fen: 1n })
    .where('order_id', '=', orderId)
    .where('app_id', '=', f.appId)
    .execute();
  h.clock.advanceMs(60_001);
  expect((await db.transaction().execute((trx) => source.forUser(trx, f))).estimated_fen).toBe(
    850n,
  );
});
