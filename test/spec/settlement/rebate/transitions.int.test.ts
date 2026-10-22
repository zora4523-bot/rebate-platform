import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PrecreditEvent } from '../../../../apps/api/src/modules/settlement/index.ts';
import { fixture, at, NOW, RECEIVED, capture, noMoney, expectCas } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  // The shared harness reads the admin database URL; never executed in the Codex sandbox.
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

// BR-FUND-01 R1/R2: DB default UNATTRIBUTED is not the logical import source state.
it.each(['PAID', 'RECEIVED', 'SETTLED'] as const)(
  '[AC-B2-04j#1] R1 未归因首次入库 %s 保持 UNATTRIBUTED，不建待入账周期',
  async (platform) => {
    const f = await fixture(db, {
      user_id: null,
      platform_status: platform,
      received_at: at(RECEIVED),
    });
    await f.run((trx, api) => api.onImported(trx, f.imported));
    expect(await f.read()).toMatchObject({
      rebate_status: 'UNATTRIBUTED',
      settle_period: null,
      received_synced_at: null,
      hold: false,
      rights_pending: false,
    });
    expect(await f.history()).toEqual([
      expect.objectContaining({
        field: 'rebate',
        from_status: null,
        event: 'IMPORT_UNATTRIBUTED',
        to_status: 'UNATTRIBUTED',
        at: at(NOW),
      }),
    ]);
    expect(f.refresh).not.toHaveBeenCalled();
    await noMoney(db, f);
  },
);

it.each([1000n, 0n, null])(
  '[AC-B2-04j#2] R2 已归因付款单初始佣金 %s 不作废',
  async (commission) => {
    const f = await fixture(db, { est_commission_fen: commission });
    f.bases.mockResolvedValue({ before: null, after: commission === null ? null : 0n });
    await f.run((trx, api) => api.onImported(trx, f.imported));
    expect(await f.read()).toMatchObject({
      rebate_status: 'ESTIMATED',
      reason: null,
      settle_period: null,
      received_synced_at: null,
      user_id: f.userId,
      locked: false,
    });
    expect(await f.history()).toEqual([
      expect.objectContaining({
        field: 'rebate',
        from_status: null,
        event: 'IMPORT_ATTRIBUTED',
        to_status: 'ESTIMATED',
      }),
    ]);
    expect(f.refresh).toHaveBeenCalledWith(f.transactions[0], f.ref);
    expect(f.publish).not.toHaveBeenCalled();
    expectCas(f);
    await noMoney(db, f);
  },
);

it('[AC-B2-04j#3] 定金入库只到 ESTIMATED，不生成预估或结算周期', async () => {
  const f = await fixture(db, { platform_status: 'DEPOSIT_PAID' });
  await f.run((trx, api) => api.onImported(trx, { ...f.imported, snapshot: 'none' }));
  expect(await f.read()).toMatchObject({ rebate_status: 'ESTIMATED', settle_period: null });
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
  await noMoney(db, f);
});

it.each(['RECEIVED', 'SETTLED'] as const)(
  '[AC-B2-04j#4] 首次 %s 同事务 R2→R4，按北京时间跨年取结算月',
  async (platform) => {
    const f = await fixture(db, { platform_status: platform, received_at: at(RECEIVED) });
    await f.run((trx, api) => api.onImported(trx, f.imported));
    expect(await f.read()).toMatchObject({
      rebate_status: 'WAITING',
      settle_period: '2027-01',
      received_synced_at: at(NOW),
      received_at: at(RECEIVED),
    });
    expect((await f.history()).map((h) => [h.from_status, h.event, h.to_status])).toEqual([
      [null, 'IMPORT_ATTRIBUTED', 'ESTIMATED'],
      ['ESTIMATED', 'PLATFORM_RECEIVED_OR_SETTLED', 'WAITING'],
    ]);
    expectCas(f);
    await noMoney(db, f);
  },
);

it('[AC-B2-04j#5] 首次 INVALID 同事务 R2→R6，原因 REFUND 且入队失效事件', async () => {
  const f = await fixture(db, { platform_status: 'INVALID' });
  await f.run((trx, api) => api.onImported(trx, { ...f.imported, snapshot: 'none' }));
  expect(await f.read()).toMatchObject({ rebate_status: 'VOID', reason: 'REFUND' });
  expect((await f.history()).map((h) => h.to_status)).toEqual(['ESTIMATED', 'VOID']);
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(f.publish).toHaveBeenCalledWith(
    f.transactions[0],
    expect.objectContaining({
      appId: f.appId,
      name: 'order.invalidated',
      payload: expect.objectContaining({ order_id: f.orderId }),
    }),
  );
  expect(await f.events()).toEqual([expect.objectContaining({ name: 'order.invalidated' })]);
  await noMoney(db, f);
});

it.each(['PAID', 'RECEIVED', 'SETTLED'] as const)(
  '[AC-B2-04j#6] R3a 重跑归属后 %s 迁移，不锁定用户、不重写归属',
  async (platform) => {
    const f = await fixture(db, { platform_status: platform, received_at: at(RECEIVED) });
    await f.update({ attributed_now: true });
    expect(await f.read()).toMatchObject({
      rebate_status: platform === 'PAID' ? 'ESTIMATED' : 'WAITING',
      user_id: f.userId,
      user_basis: 'param',
      locked: false,
      settle_period: platform === 'PAID' ? null : '2027-01',
    });
    expect((await f.history())[0]).toMatchObject({
      field: 'rebate',
      from_status: 'UNATTRIBUTED',
      event: 'SYNC_ATTRIBUTED',
      to_status: 'ESTIMATED',
    });
    expect(f.refresh).toHaveBeenCalledWith(f.transactions[0], f.ref);
    await noMoney(db, f);
  },
);

it('[AC-B2-04j#7] R3a locked 守卫拒绝迁移，整个订单不写', async () => {
  const f = await fixture(db, { locked: true });
  expect(await capture(() => f.update({ attributed_now: true }))).toMatchObject({
    ok: false,
    error: { name: 'IllegalTransition' },
  });
  expect(await f.read()).toEqual(f.initial);
  expect(await f.history()).toEqual([]);
  expect(f.refresh).not.toHaveBeenCalled();
});

it.each([
  ['2026-12-31T15:59:59.999Z', '2026-12'],
  ['2026-12-31T16:00:00.000Z', '2027-01'],
  ['2028-02-29T15:59:59.999Z', '2028-02'],
] as const)('[AC-B2-04j#8] R4 %s 的结算周期是 %s，与同步月无关', async (received, period) => {
  const f = await fixture(db, {
    rebate_status: 'ESTIMATED',
    platform_status: 'RECEIVED',
    received_at: at(received),
  });
  f.configValues.set('credit.enabled.pdd', false);
  await f.update(
    { from_status: 'PAID', rule: 'P3' },
    { event: 'PLATFORM_RECEIVED', raw_status: 'synthetic-received' },
  );
  expect(await f.read()).toMatchObject({
    rebate_status: 'WAITING',
    settle_period: period,
    received_synced_at: at(NOW),
    row_version: f.initial.row_version + 1,
  });
  expect(f.get).toHaveBeenCalledWith(f.appId, 'settle.period_basis.pdd');
  expectCas(f);
  await noMoney(db, f);
});

it('[AC-B2-04j#9] R4 无平台时间不能拿 Clock 代替，守卫恢复后才能进 WAITING', async () => {
  const f = await fixture(db, { rebate_status: 'ESTIMATED', platform_status: 'RECEIVED' });
  await f.update(
    { from_status: 'PAID', rule: 'P3' },
    { event: 'PLATFORM_RECEIVED', raw_status: 'synthetic' },
  );
  expect(await f.read()).toMatchObject({
    rebate_status: 'ESTIMATED',
    received_at: null,
    received_synced_at: null,
    settle_period: null,
  });
  expect(await f.history()).toEqual([]);
  // orders owns time backfill and NO_RECEIVED_AT pending; do not prescribe its writes here.
  await db
    .updateTable('orders')
    .set({ received_at: at(RECEIVED) })
    .where('app_id', '=', f.appId)
    .execute();
  await f.update(
    { received_at: at(RECEIVED) },
    { event: 'PLATFORM_RECEIVED', raw_status: 'synthetic' },
  );
  expect(await f.read()).toMatchObject({ rebate_status: 'WAITING', settle_period: '2027-01' });
});

it('[AC-B2-04j#10] WAITING 重放与后到真实收货时间不重算周期、不覆写同步时刻', async () => {
  const f = await fixture(db, {
    rebate_status: 'ESTIMATED',
    platform_status: 'SETTLED',
    received_at: at('2026-12-31T15:00:00Z'),
    platform_received_at: at(RECEIVED),
  });
  const origin = { event: 'PLATFORM_SETTLED' as const, raw_status: 'synthetic-settled' };
  await f.update({ from_status: 'PAID', rule: 'P5' }, origin);
  const first = await f.read();
  expect(first.settle_period).toBe('2026-12');
  const history = await f.history();
  f.clock.advanceMs(31 * 24 * 60 * 60 * 1000);
  await f.update({}, origin);
  expect(await f.read()).toEqual(first);
  expect(await f.history()).toEqual(history);
});

it.each(['vip', 'douyin', 'eleme'])(
  '[AC-B2-04j#11] 未登记可入账事件的平台 %s 不自动进入 WAITING',
  async (platform) => {
    const f = await fixture(db, {
      platform,
      rebate_status: 'ESTIMATED',
      platform_status: 'RECEIVED',
      received_at: at(RECEIVED),
    });
    await f.update(
      { from_status: 'PAID' },
      { event: 'PLATFORM_RECEIVED', raw_status: 'synthetic' },
    );
    expect(await f.read()).toMatchObject({
      rebate_status: 'ESTIMATED',
      settle_period: null,
      received_synced_at: null,
    });
    await noMoney(db, f);
  },
);

it.each(['UNATTRIBUTED', 'ESTIMATED', 'WAITING'])(
  '[AC-B2-04j#12] R6 %s 上四种明确逆向事件均作废并给正确原因',
  async (state) => {
    const cases: readonly [PrecreditEvent, string][] = [
      ['PLATFORM_INVALID', 'REFUND'],
      ['RIGHTS_FULL', 'RIGHTS'],
      ['PUNISH', 'PUNISH'],
      ['BLACKLIST_HIT', 'BLACKLIST'],
    ];
    for (const [event, reason] of cases) {
      const f = await fixture(db, {
        rebate_status: state,
        hold: true,
        hold_reason: 'RISK',
        rights_pending: true,
      });
      await f.run((trx, api) => api.apply(trx, f.command, event));
      expect(await f.read()).toMatchObject({
        rebate_status: 'VOID',
        reason,
        platform_status: 'PAID',
        hold: true,
        hold_reason: 'RISK',
        rights_pending: true,
      });
      expect(await f.history()).toEqual([
        expect.objectContaining({
          field: 'rebate',
          from_status: state,
          event,
          to_status: 'VOID',
          at: at(NOW),
        }),
      ]);
      expect(f.publish).toHaveBeenCalledTimes(1);
      expect((await f.events())[0]?.name).toBe('order.invalidated');
      expectCas(f);
      await noMoney(db, f);
    }
  },
);

it('[AC-B2-04j#13] P8 处罚依据 source.event 走 R6，不能按平台状态不变忽略', async () => {
  const f = await fixture(db, { rebate_status: 'WAITING', platform_status: 'SETTLED' });
  await f.update({ rule: 'P8' }, { event: 'PLATFORM_PUNISH', raw_status: 'synthetic-punish' });
  expect(await f.read()).toMatchObject({
    rebate_status: 'VOID',
    platform_status: 'SETTLED',
    reason: 'PUNISH',
  });
  expect((await f.history())[0]?.event).toBe('PUNISH');
  await noMoney(db, f);
});

it('[AC-B2-04j#14] P7 结算后失效的入账前单仍走 R6，不以 to_status 判定', async () => {
  const f = await fixture(db, { rebate_status: 'WAITING', platform_status: 'SETTLED' });
  await f.update({ rule: 'P7' }, { event: 'PLATFORM_INVALID', raw_status: 'synthetic-invalid' });
  expect(await f.read()).toMatchObject({
    rebate_status: 'VOID',
    reason: 'REFUND',
    platform_status: 'SETTLED',
  });
  expect(f.publish).toHaveBeenCalledTimes(1);
});

it('[AC-B2-04j#15] P8 泛维权信号不能当作全额成功，R11 留给维权命令任务', async () => {
  const f = await fixture(db, { rebate_status: 'ESTIMATED' });
  await f.update({ rule: 'P8' }, { event: 'PLATFORM_RIGHTS', raw_status: 'synthetic-rights' });
  expect(await f.read()).toEqual(f.initial);
  expect(f.publish).not.toHaveBeenCalled();
  expect(
    await db.selectFrom('order_rights').selectAll().where('app_id', '=', f.appId).execute(),
  ).toEqual([]);
});

it.each(['UNATTRIBUTED', 'ESTIMATED', 'WAITING'])(
  '[AC-B2-04j#16] %s 有效基数正数变零按 R6，原始佣金仍正也不能漏判',
  async (state) => {
    const f = await fixture(db, { rebate_status: state, est_commission_fen: 1n });
    // Hand-picked boundary supplied by commission: 1 fen can round to base 0.
    f.bases.mockResolvedValue({ before: 1n, after: 0n });
    await f.update({ est_before: 2n, est_after: 1n });
    expect(await f.read()).toMatchObject({ rebate_status: 'VOID', reason: 'COMMISSION_ZERO' });
    expect((await f.history())[0]?.event).toBe('BASE_ZERO');
    expect(f.bases).toHaveBeenCalledWith(f.transactions[0], {
      ...f.ref,
      estBefore: 2n,
      estAfter: 1n,
      settleCommissionFen: null,
    });
    expect(f.publish).toHaveBeenCalledTimes(1);
    await noMoney(db, f);
  },
);

it.each([
  [0n, 0n],
  [null, 0n],
  [null, 720n],
  [900n, null],
  [900n, 720n],
] as const)(
  '[AC-B2-04j#17] R7 基数 %s→%s 不是正数归零，保持状态并重算预估',
  async (before, after) => {
    const f = await fixture(db, { rebate_status: 'ESTIMATED', est_commission_fen: 800n });
    f.bases.mockResolvedValue({ before, after });
    await f.update({ est_before: before === null ? null : 1000n, est_after: 800n });
    expect(await f.read()).toMatchObject({ rebate_status: 'ESTIMATED', reason: null });
    expect(f.refresh).toHaveBeenCalledWith(f.transactions[0], f.ref);
    expect(f.publish).not.toHaveBeenCalled();
    await noMoney(db, f);
  },
);

it.each(['ESTIMATED', 'WAITING'])(
  '[AC-B2-04j#18] R7 %s 部分退款、部分维权同事务重算，保留暂停与维权标志',
  async (state) => {
    for (const event of ['PARTIAL_REFUND', 'RIGHTS_PARTIAL'] as const) {
      const f = await fixture(db, {
        rebate_status: state,
        hold: true,
        hold_reason: 'CS',
        rights_pending: true,
        est_commission_fen: 800n,
        refunded_quantity: 1,
        commission_version: 2,
      });
      await f.run((trx, api) => api.apply(trx, f.command, event));
      expect(await f.read()).toMatchObject({
        rebate_status: state,
        reason: null,
        hold: true,
        hold_reason: 'CS',
        rights_pending: true,
        commission_version: 2,
        refunded_quantity: 1,
      });
      expect(f.refresh).toHaveBeenCalledTimes(1);
      expect(f.refresh).toHaveBeenCalledWith(f.transactions[0], f.ref);
      expect(await f.history()).toEqual([
        expect.objectContaining({ event, from_status: state, to_status: state }),
      ]);
      expectCas(f);
      await noMoney(db, f);
    }
  },
);

it('[AC-B2-04j#19] 已有结算佣金时预估单独归零只存档，不重算或触发 COMMISSION_ZERO', async () => {
  const f = await fixture(db, {
    rebate_status: 'WAITING',
    platform_status: 'SETTLED',
    settle_commission_fen: 800n,
    est_commission_fen: 0n,
  });
  // 结算优先，结算额未变则有效基数不变。
  f.bases.mockResolvedValue({ before: 800n, after: 800n });
  await f.update(
    { est_before: 1000n, est_after: 0n },
    { event: 'PLATFORM_SETTLED', raw_status: 'synthetic' },
  );
  expect(await f.read()).toEqual(f.initial);
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
  expect(await f.history()).toEqual([]);
});

it.each(['DEPOSIT_PAID', 'PAID'])(
  '[AC-B2-04j#20] 定金期佣金归零与 P2 首次零基数（当前 %s）均不作废',
  async (platform) => {
    const f = await fixture(db, {
      rebate_status: 'ESTIMATED',
      platform_status: platform,
      est_commission_fen: 0n,
    });
    f.bases.mockResolvedValue({ before: 900n, after: 0n });
    await f.update(
      {
        from_status: 'DEPOSIT_PAID',
        est_before: 1000n,
        est_after: 0n,
        rule: platform === 'PAID' ? 'P2' : null,
      },
      {
        event: platform === 'PAID' ? 'PLATFORM_PAID' : 'PLATFORM_DEPOSIT_PAID',
        raw_status: 'synthetic',
      },
    );
    expect(await f.read()).toMatchObject({ rebate_status: 'ESTIMATED', reason: null });
    expect(f.publish).not.toHaveBeenCalled();
    if (platform === 'DEPOSIT_PAID') expect(f.refresh).not.toHaveBeenCalled();
    else expect(f.refresh).toHaveBeenCalledWith(f.transactions[0], f.ref);
  },
);

it('[AC-B2-04j#21] 佣金未知不能视为零，缺失字段的规范化更新不改变原值', async () => {
  const f = await fixture(db, { rebate_status: 'ESTIMATED' });
  f.bases.mockResolvedValue({ before: 900n, after: null });
  await f.update();
  expect(await f.read()).toEqual(f.initial);
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});

it.each(['VOID', 'CLAWED_BACK'])(
  '[AC-B2-04j#22] %s 表外自动事件抛 IllegalTransition，调用者捕获后仍无任何写入',
  async (state) => {
    const f = await fixture(db, { rebate_status: state });
    // Catch INSIDE the transaction: rollback must not hide writes before classification.
    const result = await f.run((trx, api) =>
      capture(() => api.apply(trx, f.command, 'PARTIAL_REFUND')),
    );
    expect(result).toMatchObject({ ok: false, error: { name: 'IllegalTransition' } });
    expect(await f.read()).toEqual(f.initial);
    expect(await f.history()).toEqual([]);
    expect(await f.events()).toEqual([]);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.logs.some((log) => Number(log['level']) >= 40)).toBe(true);
    await noMoney(db, f);
  },
);

it.each(['VOID', 'CREDITED', 'CLAWED_BACK'])(
  '[AC-B2-04j#23] %s 平台正向推进或重复上报不抛错、不改变返利，只记日志',
  async (state) => {
    for (const [rule, from, to, event] of [
      ['P2', 'DEPOSIT_PAID', 'PAID', 'PLATFORM_PAID'],
      ['P3', 'PAID', 'RECEIVED', 'PLATFORM_RECEIVED'],
      ['P4', 'RECEIVED', 'SETTLED', 'PLATFORM_SETTLED'],
      ['P5', 'PAID', 'SETTLED', 'PLATFORM_SETTLED'],
      ['P14', 'DEPOSIT_PAID', 'RECEIVED', 'PLATFORM_RECEIVED'],
      ['P15', 'RECEIVED', 'RECEIVED', 'PLATFORM_RECEIVED'],
    ] as const) {
      // orders has already applied the platform update before calling this port.
      const f = await fixture(db, {
        rebate_status: state,
        platform_status: to,
        received_at: at(RECEIVED),
      });
      expect(
        await capture(() =>
          f.update(
            { rule, from_status: from, est_before: 0n, est_after: 1000n },
            { event, raw_status: 'synthetic' },
          ),
        ),
        rule,
      ).toEqual({ ok: true });
      expect(await f.read()).toEqual(f.initial);
      expect(await f.history()).toEqual([]);
      expect(await f.events()).toEqual([]);
      expect(f.refresh).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.logs.length).toBeGreaterThan(0);
      await noMoney(db, f);
    }
  },
);

it('[AC-B2-04j#24] CREDITED 所有同步更新只记日志，不能扣回补差或 hold', async () => {
  for (const event of [
    'PLATFORM_INVALID',
    'PLATFORM_PUNISH',
    'PLATFORM_SETTLED',
    'PLATFORM_RIGHTS',
  ] as const) {
    const f = await fixture(db, { rebate_status: 'CREDITED', platform_status: 'SETTLED' });
    await f.update({ est_before: 1000n, est_after: 0n }, { event, raw_status: 'synthetic' });
    expect(await f.read()).toEqual(f.initial);
    expect(await f.history()).toEqual([]);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.bases).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.logs.length).toBeGreaterThan(0);
    expect(f.logs.some((line) => line['app_id'] === f.appId)).toBe(true);
    await noMoney(db, f);
  }
});

it('[AC-B2-04j#25] 收货与有效基数归零同报文时不能漏掉 R6，最终必须作废', async () => {
  const f = await fixture(db, {
    rebate_status: 'ESTIMATED',
    platform_status: 'RECEIVED',
    received_at: at(RECEIVED),
    est_commission_fen: 0n,
  });
  f.bases.mockResolvedValue({ before: 900n, after: 0n });
  await f.update(
    { from_status: 'PAID', est_before: 1000n, est_after: 0n },
    { event: 'PLATFORM_RECEIVED', raw_status: 'synthetic' },
  );
  expect(await f.read()).toMatchObject({
    rebate_status: 'VOID',
    reason: 'COMMISSION_ZERO',
  });
  expect((await f.history()).at(-1)).toMatchObject({ event: 'BASE_ZERO', to_status: 'VOID' });
  expect(f.publish).toHaveBeenCalledTimes(1);
  await noMoney(db, f);
});

it('[AC-B2-04j#41] P13 未归因首次失效同事务 R1→R6，不停留在 UNATTRIBUTED', async () => {
  const f = await fixture(db, {
    user_id: null,
    user_basis: null,
    platform_status: 'INVALID',
    paid_at: at('2026-12-15T04:00:00Z'),
  });
  await f.run((trx, api) => api.onImported(trx, { ...f.imported, snapshot: 'none' }));
  expect(await f.read()).toMatchObject({
    user_id: null,
    rebate_status: 'VOID',
    reason: 'REFUND',
    settle_period: null,
    received_synced_at: null,
  });
  expect((await f.history()).map((h) => [h.from_status, h.event, h.to_status])).toEqual([
    [null, 'IMPORT_UNATTRIBUTED', 'UNATTRIBUTED'],
    ['UNATTRIBUTED', 'PLATFORM_INVALID', 'VOID'],
  ]);
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(
    f.transactions[0],
    expect.objectContaining({
      appId: f.appId,
      name: 'order.invalidated',
      payload: expect.objectContaining({ order_id: f.orderId }),
    }),
  );
  expect(await f.events()).toEqual([expect.objectContaining({ name: 'order.invalidated' })]);
  expectCas(f);
  await noMoney(db, f);
});

it.each([
  ['ESTIMATED', 'PAID'],
  ['WAITING', 'RECEIVED'],
] as const)(
  '[AC-B2-04j#42] P6 入账前 %s 订单从 %s 退款，onUpdated 按 R6 作废',
  async (state, from) => {
    const f = await fixture(db, { rebate_status: state, platform_status: 'INVALID' });
    await f.update(
      { from_status: from, rule: 'P6' },
      { event: 'PLATFORM_INVALID', raw_status: 'synthetic-invalid' },
    );
    expect(await f.read()).toMatchObject({
      rebate_status: 'VOID',
      reason: 'REFUND',
      platform_status: 'INVALID',
    });
    expect(await f.history()).toEqual([
      expect.objectContaining({
        field: 'rebate',
        from_status: state,
        event: 'PLATFORM_INVALID',
        to_status: 'VOID',
        at: at(NOW),
      }),
    ]);
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(
      f.transactions[0],
      expect.objectContaining({
        appId: f.appId,
        name: 'order.invalidated',
        payload: expect.objectContaining({ order_id: f.orderId }),
      }),
    );
    expect(await f.events()).toEqual([expect.objectContaining({ name: 'order.invalidated' })]);
    expectCas(f);
    await noMoney(db, f);
  },
);

it.each([
  ['PAID', 'RECEIVED', 'P3', 'PLATFORM_RECEIVED', 1000n],
  ['RECEIVED', 'SETTLED', 'P4', 'PLATFORM_SETTLED', 1000n],
  ['PAID', 'PAID', 'P15', 'PLATFORM_PAID', 800n],
] as const)(
  '[AC-B2-04j#43] 未归因订单 %s→%s（%s）收货、结算或非零佣金变化不进 WAITING、不抛错',
  async (from, to, rule, event, commission) => {
    const f = await fixture(db, {
      user_id: null,
      user_basis: null,
      platform_status: to,
      received_at: to === 'PAID' ? null : at(RECEIVED),
      est_commission_fen: commission,
    });
    expect(
      await capture(() =>
        f.update(
          { from_status: from, rule, est_before: 1000n, est_after: commission, snapshot: 'none' },
          { event, raw_status: 'synthetic' },
        ),
      ),
    ).toEqual({ ok: true });
    expect(await f.read()).toEqual(f.initial);
    expect(await f.read()).toMatchObject({
      rebate_status: 'UNATTRIBUTED',
      settle_period: null,
      received_synced_at: null,
    });
    expect(await f.history()).toEqual([]);
    expect(await f.events()).toEqual([]);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    await noMoney(db, f);
  },
);

it.each([
  [true, false],
  [false, true],
  [true, true],
] as const)(
  '[AC-B2-04j#44] hold=%s、rights_pending=%s 的收货单仍按 R4 进 WAITING',
  async (hold, rightsPending) => {
    const f = await fixture(db, {
      rebate_status: 'ESTIMATED',
      platform_status: 'RECEIVED',
      received_at: at(RECEIVED),
      hold,
      hold_reason: hold ? 'RISK' : null,
      rights_pending: rightsPending,
    });
    await f.update(
      { from_status: 'PAID', rule: 'P3' },
      { event: 'PLATFORM_RECEIVED', raw_status: 'synthetic-received' },
    );
    expect(await f.read()).toMatchObject({
      rebate_status: 'WAITING',
      settle_period: '2027-01',
      received_synced_at: at(NOW),
      hold,
      hold_reason: hold ? 'RISK' : null,
      rights_pending: rightsPending,
    });
    expect(await f.history()).toEqual([
      expect.objectContaining({
        field: 'rebate',
        from_status: 'ESTIMATED',
        event: 'PLATFORM_RECEIVED_OR_SETTLED',
        to_status: 'WAITING',
      }),
    ]);
    expectCas(f);
    await noMoney(db, f);
  },
);

it.each(['PAID', 'RECEIVED', 'SETTLED'] as const)(
  '[AC-B2-04j#45] 导入 %s 缺平台收货时间只走 R2，不能用同步时间进入 WAITING',
  async (platform) => {
    // P11 missing-time fallback is PAID; also exercise R4's guard directly on later states.
    const f = await fixture(db, { platform_status: platform, received_at: null });
    await f.run((trx, api) => api.onImported(trx, f.imported));
    expect(await f.read()).toMatchObject({
      rebate_status: 'ESTIMATED',
      received_at: null,
      settle_period: null,
      received_synced_at: null,
    });
    expect((await f.history()).map((h) => [h.from_status, h.event, h.to_status])).toEqual([
      [null, 'IMPORT_ATTRIBUTED', 'ESTIMATED'],
    ]);
    expect(f.publish).not.toHaveBeenCalled();
    await noMoney(db, f);
  },
);

it.each([
  ['PAID', 'PLATFORM_PAID'],
  ['RECEIVED', 'PLATFORM_RECEIVED'],
  ['SETTLED', 'PLATFORM_SETTLED'],
] as const)(
  '[AC-B2-04j#46] VOID 上 P9 平台恢复到 %s 不自动复活，也不抛错回滚同步',
  async (platform, event) => {
    const f = await fixture(db, {
      rebate_status: 'VOID',
      reason: 'REFUND',
      platform_status: platform,
      received_at: platform === 'PAID' ? null : at(RECEIVED),
    });
    expect(
      await capture(() =>
        f.update(
          { rule: 'P9', from_status: 'INVALID', est_before: 0n, est_after: 1000n },
          { event, raw_status: 'synthetic-recovered' },
        ),
      ),
    ).toEqual({ ok: true });
    expect(await f.read()).toEqual(f.initial);
    expect(await f.history()).toEqual([]);
    expect(f.refresh).not.toHaveBeenCalled();
    await noMoney(db, f);
  },
);

it('[AC-B2-04j#47] 同报文预估与结算佣金同时归零，有效基数 800→0 按 R6 作废', async () => {
  const f = await fixture(db, {
    rebate_status: 'WAITING',
    platform_status: 'SETTLED',
    est_commission_fen: 0n,
    settle_commission_fen: 0n,
  });
  // orders 已写入本次佣金；估值端口按结算优先返回结算佣金 800→0 的有效基数。
  f.bases.mockResolvedValue({ before: 800n, after: 0n });
  await f.update(
    { est_before: 1000n, est_after: 0n },
    { event: 'PLATFORM_SETTLED', raw_status: 'synthetic' },
  );
  expect(await f.read()).toMatchObject({ rebate_status: 'VOID', reason: 'COMMISSION_ZERO' });
  expect(f.bases).toHaveBeenCalledWith(f.transactions[0], {
    ...f.ref,
    estBefore: 1000n,
    estAfter: 0n,
    settleCommissionFen: 0n,
  });
  expect(await f.history()).toEqual([
    expect.objectContaining({
      field: 'rebate',
      from_status: 'WAITING',
      event: 'BASE_ZERO',
      to_status: 'VOID',
    }),
  ]);
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(
    f.transactions[0],
    expect.objectContaining({
      appId: f.appId,
      name: 'order.invalidated',
      payload: expect.objectContaining({ order_id: f.orderId }),
    }),
  );
  expect(await f.events()).toEqual([expect.objectContaining({ name: 'order.invalidated' })]);
  expectCas(f);
  await noMoney(db, f);
});

it('[AC-B2-04j#48] 同报文预估与结算佣金同时调减，有效基数 800→500 按 R7 重算一次', async () => {
  const f = await fixture(db, {
    rebate_status: 'WAITING',
    platform_status: 'SETTLED',
    est_commission_fen: 600n,
    settle_commission_fen: 500n,
  });
  // 预估佣金 1000→600、结算佣金 800→500；有效基数按结算佣金取值。
  f.bases.mockResolvedValue({ before: 800n, after: 500n });
  await f.update(
    { est_before: 1000n, est_after: 600n },
    { event: 'PLATFORM_SETTLED', raw_status: 'synthetic' },
  );
  expect(await f.read()).toMatchObject({
    rebate_status: 'WAITING',
    reason: null,
    est_commission_fen: 600n,
    settle_commission_fen: 500n,
  });
  expect(f.bases).toHaveBeenCalledWith(f.transactions[0], {
    ...f.ref,
    estBefore: 1000n,
    estAfter: 600n,
    settleCommissionFen: 500n,
  });
  expect(f.refresh).toHaveBeenCalledExactlyOnceWith(f.transactions[0], f.ref);
  expect(f.publish).not.toHaveBeenCalled();
  expect(await f.events()).toEqual([]);
  await noMoney(db, f);
});
