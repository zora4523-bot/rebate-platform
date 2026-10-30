// B2-04l rule tests: rights.record before credit and on terminal orders (BR-FUND-06 维权中 /
// 维权结果; BR-FUND-07 入账前失效; BR-FUND-01 rights_pending, P7 / P8, 订单锁定), the K-2 dedupe key
// (app_id, order_id, type, platform_rights_no; NULLS NOT DISTINCT) and not_applicable. Default
// order (credit kit): WAITING, platform SETTLED, settle_commission_fen 1000 (est 3222 as a decoy).
// Deductions in #15–#27 are chosen so that full / partial do not depend on which commission column
// counts: 5000 is above both, 400 below both. The boundary cases (#37 / #38) use reserve 0 and pin
// the full / partial split on the effective union commission (BR-CALC-02: settlement first).
// commission's valuation port is a test double (kit): the tests read what settlement asked it.
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import {
  NOW,
  OCCURRED_AT,
  TIMEOUT,
  databaseFixture,
  harness,
  type Harness,
  type SeededOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const ESTIMATED = {
  seqs: [],
  patch: { rebate_status: 'ESTIMATED', platform_status: 'PAID', received_at: null },
} as const;

const RESERVE_0 = { reserveBp: 0 } as const;

/** No voucher of the order and no rebate history row after seeding. */
async function expectNoMoney(h: Harness, o: SeededOrder): Promise<void> {
  expect(await h.orderVoucherKeys(o)).toEqual([]);
  expect((await h.read(o)).booked_base_fen).toBeNull();
}

/**
 * The effective union commission (BR-CALC-02: settlement first, else estimate) that settlement
 * handed commission's valuation port, one entry per call.
 */
function valuedCommissions(h: Harness): (bigint | null)[] {
  return h.estimateBases.mock.calls.map(([, input]) => input.settleCommissionFen ?? input.estAfter);
}

interface KeptRecord {
  readonly result: Awaited<ReturnType<Harness['record']>>;
  readonly trx: Transaction<DB> | undefined;
}

/** One rights.record whose transaction is kept, to check what ran on it. */
async function recordKeepingTrx(
  h: Harness,
  o: SeededOrder,
  deductionFen: bigint,
): Promise<KeptRecord> {
  let trx: Transaction<DB> | undefined;
  const result = await h.record(
    o,
    { deductionFen },
    {
      after: (t) => {
        trx = t;
        return Promise.resolve();
      },
    },
  );
  return { result, trx };
}

/** R7 RIGHTS_PARTIAL before credit: status kept, history row, estimate recomputed on `trx`. */
async function expectR7(
  h: Harness,
  o: SeededOrder,
  trx: Transaction<DB> | undefined,
  from: 'ESTIMATED' | 'WAITING',
  newCommission: bigint,
  published: number,
): Promise<void> {
  expect(await h.read(o)).toMatchObject({
    rebate_status: from,
    reason: null,
    rights_pending: false,
    hold: false,
  });
  expect(await h.history(o)).toEqual([
    expect.objectContaining({
      field: 'rebate',
      from_status: from,
      event: 'RIGHTS_PARTIAL',
      to_status: from,
    }),
  ]);
  expect(trx).toBeDefined();
  expect(valuedCommissions(h)).toEqual([newCommission]);
  expect(h.estimateBases).toHaveBeenCalledWith(
    trx,
    expect.objectContaining({ appId: h.appId, orderId: o.orderId }),
  );
  expect(h.estimateRefresh).toHaveBeenCalledTimes(1);
  expect(h.estimateRefresh).toHaveBeenCalledWith(trx, {
    appId: h.appId,
    orderId: o.orderId,
    attrAt: o.attrAt,
  });
  expect(h.publishedSince(published)).not.toContain('order.invalidated');
  await expectNoMoney(h, o);
}

it(
  '[AC-B2-04l#15] 入账前维权处理中（PROCESSING）：写一条记录（来源、类型、金额、发生时间、单号照入参，created_at / updated_at = 注入的 now），rights_pending=true（row_version+1、updated_at=now），返利状态不变、不写历史与事件',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const before = await h.read(o);
    const published = h.publish.mock.calls.length;

    expect(
      await h.record(o, {
        source: 'API',
        status: 'PROCESSING',
        amountFen: 1990n,
        deductionFen: null,
      }),
    ).toEqual({ kind: 'applied' });
    expect(await h.onlyRights(o)).toMatchObject({
      app_id: h.appId,
      order_id: o.orderId,
      source: 'API',
      type: 'RIGHTS',
      status: 'PROCESSING',
      amount_fen: 1990n,
      deduction_commission_fen: null,
      occurred_at: new Date(OCCURRED_AT),
      platform_rights_no: 'rights-n1',
      created_at: new Date(NOW),
      updated_at: new Date(NOW),
    });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'WAITING',
      rights_pending: true,
      hold: false,
      reason: null,
      row_version: before.row_version + 1,
      updated_at: new Date(NOW),
    });
    expect(await h.history(o)).toEqual([]);
    expect(h.publishedSince(published)).toEqual([]);
    await expectNoMoney(h, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#16] 维权处理中后失败（同一维权单号）：同一条记录原地改为 FAILED（id 不变、row_version+1），rights_pending 回到 false，返利状态与金额不变',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    expect(await h.record(o, { status: 'PROCESSING' })).toEqual({ kind: 'applied' });
    const processing = await h.onlyRights(o);

    expect(await h.record(o, { status: 'FAILED' })).toEqual({ kind: 'applied' });
    expect(await h.onlyRights(o)).toMatchObject({
      id: processing.id,
      status: 'FAILED',
      row_version: processing.row_version + 1,
      updated_at: new Date(NOW),
    });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'WAITING',
      rights_pending: false,
      reason: null,
      est_commission_fen: 3222n,
      settle_commission_fen: 1000n,
    });
    expect(await h.history(o)).toEqual([]);
    await expectNoMoney(h, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#17] rights_pending 按全部记录重算：两条处理中的维权，其中一条失败后仍为 true；另一条也失败后才为 false',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    expect(await h.record(o, { status: 'PROCESSING' })).toEqual({ kind: 'applied' });
    expect(await h.record(o, { status: 'PROCESSING', rightsNo: 'rights-n2' })).toEqual({
      kind: 'applied',
    });

    expect(await h.record(o, { status: 'FAILED' })).toEqual({ kind: 'applied' });
    expect((await h.read(o)).rights_pending).toBe(true);
    expect(await h.record(o, { status: 'FAILED', rightsNo: 'rights-n2' })).toEqual({
      kind: 'applied',
    });
    expect((await h.read(o)).rights_pending).toBe(false);
    expect((await h.rightsRows(o)).map((r) => r.status)).toEqual(['FAILED', 'FAILED']);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#18] 入账前处罚（PUNISH，SUCCEEDED）：按 R6 置 VOID（原因码 PUNISH），写 rebate 历史，同事务入队 order.invalidated；不写任何分录',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const published = h.publish.mock.calls.length;

    expect(await h.record(o, { type: 'PUNISH', rightsNo: 'punish-n1' })).toEqual({
      kind: 'applied',
    });
    expect(await h.onlyRights(o)).toMatchObject({ type: 'PUNISH', status: 'SUCCEEDED' });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'VOID',
      reason: 'PUNISH',
      rights_pending: false,
    });
    expect(await h.history(o)).toEqual([
      expect.objectContaining({
        field: 'rebate',
        from_status: 'WAITING',
        event: 'PUNISH',
        to_status: 'VOID',
      }),
    ]);
    expect(h.publishedSince(published)).toEqual(['order.invalidated']);
    expect(h.publish).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: 'order.invalidated',
        payload: expect.objectContaining({ order_id: o.orderId, reason: 'PUNISH' }),
      }),
    );
    await expectNoMoney(h, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#19] 入账前维权全额成功（ESTIMATED，应扣佣金 5000 不低于有效联盟佣金）：按 R6 RIGHTS_FULL 置 VOID（原因码 RIGHTS），入队 order.invalidated，不写分录',
  async () => {
    const h = await harness(p.db);
    const o = await h.order(ESTIMATED);
    const published = h.publish.mock.calls.length;

    expect(await h.record(o, { deductionFen: 5000n })).toEqual({ kind: 'applied' });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'VOID',
      reason: 'RIGHTS',
      rights_pending: false,
    });
    expect(await h.history(o)).toEqual([
      expect.objectContaining({
        field: 'rebate',
        from_status: 'ESTIMATED',
        event: 'RIGHTS_FULL',
        to_status: 'VOID',
      }),
    ]);
    expect(h.publishedSince(published)).toEqual(['order.invalidated']);
    await expectNoMoney(h, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#20] 入账前维权部分成功（应扣佣金 400 低于有效联盟佣金 1000）：按 R7 RIGHTS_PARTIAL（WAITING 不变）写一条 rebate 历史，同事务按 N_new = 1000 − 400 = 600 重算预估（交给估值的有效联盟佣金为 600、预估刷新一次）；不作废（无原因码、不发 order.invalidated），记录 SUCCEEDED，rights_pending=false，不写分录',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    // commission's valuation of N 1000 → 600 at reserve 1500: B 850 → 510 (not a base to zero).
    h.estimateBases.mockResolvedValue({ before: 850n, after: 510n });
    const published = h.publish.mock.calls.length;

    const { result, trx } = await recordKeepingTrx(h, o, 400n);
    expect(result).toEqual({ kind: 'applied' });
    expect(await h.onlyRights(o)).toMatchObject({
      status: 'SUCCEEDED',
      deduction_commission_fen: 400n,
    });
    await expectR7(h, o, trx, 'WAITING', 600n, published);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#21] 入账前维权成功而无应扣佣金（BR-FUND-06 例「部分成功、佣金未更新」）：记录置 WAIT_COMMISSION，rights_pending=true（继续阻止入账），返利状态不变、不作废',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();

    expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
    expect(await h.onlyRights(o)).toMatchObject({ type: 'RIGHTS', status: 'WAIT_COMMISSION' });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'WAITING',
      reason: null,
      rights_pending: true,
    });
    expect((await h.history(o)).filter((r) => r.to_status === 'VOID')).toEqual([]);
    await expectNoMoney(h, o);
  },
  TIMEOUT,
);

it.each([
  ['DEPOSIT_PAID', 'ESTIMATED'],
  ['INVALID', 'VOID'],
] as const)(
  '[AC-B2-04l#22] 平台状态 %s（不在 P7 / P8 的来源 PAID / RECEIVED / SETTLED 内，返利 %s）：not_applicable，不写记录、不改订单',
  async (platformStatus, rebateStatus) => {
    const h = await harness(p.db);
    const o = await h.order({
      seqs: [],
      patch: {
        platform_status: platformStatus,
        rebate_status: rebateStatus,
        received_at: null,
        ...(rebateStatus === 'VOID' ? { reason: 'REFUND' as const } : {}),
      },
    });
    const before = await h.everything();

    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'not_applicable' });
    expect(await h.everything()).toEqual(before);
  },
  TIMEOUT,
);

it.each(['VOID', 'CLAWED_BACK'] as const)(
  '[AC-B2-04l#23] 终态 %s（平台 SETTLED）收到维权成功：只记录（applied），返利状态、原因码、booked 与账务都不变，不写历史与事件',
  async (rebateStatus) => {
    const h = await harness(p.db);
    const o = await h.order({ patch: { rebate_status: rebateStatus, reason: 'REFUND' } });
    const before = await h.everything();

    expect(await h.record(o, { deductionFen: 400n })).toEqual({ kind: 'applied' });
    expect(await h.onlyRights(o)).toMatchObject({ type: 'RIGHTS', status: 'SUCCEEDED' });
    const after = await h.everything();
    expect(await h.rebateColumns(o)).toMatchObject({
      rebate_status: rebateStatus,
      reason: 'REFUND',
      booked_base_fen: null,
      booked_n_fen: null,
      rights_pending: false,
    });
    expect(after.vouchers).toEqual(before.vouchers);
    expect(after.balances).toEqual(before.balances);
    expect(after.history).toEqual(before.history);
    expect(after.events).toEqual(before.events);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#24] 去重键 NULLS NOT DISTINCT：同一订单、同一类型、平台单号都为空的处理中记录再来一次 → duplicate，只有一条记录、订单不再变化',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    expect(await h.record(o, { status: 'PROCESSING', rightsNo: null })).toEqual({
      kind: 'applied',
    });
    const first = await h.everything();

    expect(await h.record(o, { status: 'PROCESSING', rightsNo: null })).toEqual({
      kind: 'duplicate',
    });
    expect(await h.everything()).toEqual(first);
    expect(await h.onlyRights(o)).toMatchObject({ platform_rights_no: null });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#25] 去重键含类型：同一单号先记维权处理中、再记处罚成功 → 两条记录都 applied，处罚按 R6 置 VOID',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    expect(await h.record(o, { status: 'PROCESSING', rightsNo: 'shared-n1' })).toEqual({
      kind: 'applied',
    });

    expect(await h.record(o, { type: 'PUNISH', rightsNo: 'shared-n1' })).toEqual({
      kind: 'applied',
    });
    expect((await h.rightsRows(o)).map((r) => `${r.type}|${r.status}`).sort()).toEqual([
      'PUNISH|SUCCEEDED',
      'RIGHTS|PROCESSING',
    ]);
    expect(await h.read(o)).toMatchObject({ rebate_status: 'VOID', reason: 'PUNISH' });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#26] 已关闭的记录（FAILED）同键再来（任何状态）→ duplicate，什么都不写',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    expect(await h.record(o, { status: 'FAILED' })).toEqual({ kind: 'applied' });
    const first = await h.everything();

    expect(await h.record(o, { status: 'FAILED' })).toEqual({ kind: 'duplicate' });
    expect(await h.record(o, { status: 'SUCCEEDED', deductionFen: 5000n })).toEqual({
      kind: 'duplicate',
    });
    expect(await h.everything()).toEqual(first);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#27] 只用调用方的事务：入账前处罚置 VOID 后调用方事务失败 → 记录、返利状态、历史、事件一起回滚',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const before = await h.everything();

    await expect(
      h.record(
        o,
        { type: 'PUNISH', rightsNo: 'punish-n1' },
        {
          after: async () => {
            throw new Error('caller rolls back');
          },
        },
      ),
    ).rejects.toThrow('caller rolls back');
    expect(await h.everything()).toEqual(before);
  },
  TIMEOUT,
);

it.each([
  ['PUNISH', null, 'PUNISH', 'PUNISH'],
  ['RIGHTS', 5000n, 'RIGHTS_FULL', 'RIGHTS'],
  ['INVALID_AFTER_SETTLE', null, 'PLATFORM_INVALID', 'REFUND'],
] as const)(
  '[AC-B2-04l#35] 未归因订单（UNATTRIBUTED，BR-FUND-07 的来源状态之一）收到 %s 成功（应扣佣金 %s）：按 R6 %s 置 VOID（原因码 %s），写 rebate 历史，同事务入队 order.invalidated；不写任何分录',
  async (type, deductionFen, event, reason) => {
    const h = await harness(p.db);
    const o = await h.order({ patch: { rebate_status: 'UNATTRIBUTED', user_id: null } });
    const published = h.publish.mock.calls.length;

    expect(await h.record(o, { type, deductionFen, rightsNo: 'unattributed-n1' })).toEqual({
      kind: 'applied',
    });
    expect(await h.onlyRights(o)).toMatchObject({ type, status: 'SUCCEEDED' });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'VOID',
      reason,
      rights_pending: false,
      user_id: null,
    });
    expect(await h.history(o)).toEqual([
      expect.objectContaining({
        field: 'rebate',
        from_status: 'UNATTRIBUTED',
        event,
        to_status: 'VOID',
      }),
    ]);
    expect(h.publishedSince(published)).toEqual(['order.invalidated']);
    expect(h.publish).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: 'order.invalidated',
        payload: expect.objectContaining({ order_id: o.orderId, reason }),
      }),
    );
    await expectNoMoney(h, o);
  },
  TIMEOUT,
);

it.each(['REFUND_AFTER_SETTLE', 'INVALID_AFTER_SETTLE'] as const)(
  '[AC-B2-04l#36] 已结算未入账（WAITING，平台 SETTLED）收到 %s 维权记录（成功）：整单失效，按 R6 PLATFORM_INVALID 置 VOID（原因码 REFUND），入队 order.invalidated，不写分录',
  async (type) => {
    const h = await harness(p.db);
    const o = await h.order();
    const published = h.publish.mock.calls.length;

    expect(await h.record(o, { type, rightsNo: 'after-settle-n1' })).toEqual({ kind: 'applied' });
    expect(await h.onlyRights(o)).toMatchObject({ type, status: 'SUCCEEDED' });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'VOID',
      reason: 'REFUND',
      rights_pending: false,
    });
    expect(await h.history(o)).toEqual([
      expect.objectContaining({
        field: 'rebate',
        from_status: 'WAITING',
        event: 'PLATFORM_INVALID',
        to_status: 'VOID',
      }),
    ]);
    expect(h.publishedSince(published)).toEqual(['order.invalidated']);
    await expectNoMoney(h, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#37] 全额 / 部分分界（入账前，预留 0，有效联盟佣金 = 结算佣金 1000，预估 3222 为干扰）：应扣佣金恰为 1000 → N_new 0 → 全额，按 R6 RIGHTS_FULL 置 VOID（原因码 RIGHTS），发 order.invalidated，不写分录',
  async () => {
    const h = await harness(p.db);
    const o = await h.order(RESERVE_0);
    const published = h.publish.mock.calls.length;

    expect(await h.record(o, { deductionFen: 1000n })).toEqual({ kind: 'applied' });
    expect(await h.onlyRights(o)).toMatchObject({
      status: 'SUCCEEDED',
      deduction_commission_fen: 1000n,
    });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'VOID',
      reason: 'RIGHTS',
      rights_pending: false,
    });
    expect(await h.history(o)).toEqual([
      expect.objectContaining({
        field: 'rebate',
        from_status: 'WAITING',
        event: 'RIGHTS_FULL',
        to_status: 'VOID',
      }),
    ]);
    expect(h.publishedSince(published)).toEqual(['order.invalidated']);
    await expectNoMoney(h, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#38] 全额 / 部分分界的另一侧（入账前，预留 0，有效联盟佣金 1000）：应扣佣金 999 → N_new 1、B 1 > 0 → 部分，按 R7 RIGHTS_PARTIAL 保持 WAITING、同事务以有效联盟佣金 1 重算预估；不作废、不写分录',
  async () => {
    const h = await harness(p.db);
    const o = await h.order(RESERVE_0);
    // commission's valuation at reserve 0: B 1000 → 1.
    h.estimateBases.mockResolvedValue({ before: 1000n, after: 1n });
    const published = h.publish.mock.calls.length;

    const { result, trx } = await recordKeepingTrx(h, o, 999n);
    expect(result).toEqual({ kind: 'applied' });
    expect(await h.onlyRights(o)).toMatchObject({
      status: 'SUCCEEDED',
      deduction_commission_fen: 999n,
    });
    await expectR7(h, o, trx, 'WAITING', 1n, published);
  },
  TIMEOUT,
);
