// B2-04s rule tests: R9b — the settlement record is unchanged and only the estimated commission
// changes on a CREDITED order (BR-FUND-01 R9b; BR-FUND-08; 决-01 A). Archive only: no voucher,
// booked pair unchanged; a recon diff「入账后预估佣金变化」when the estimate's base (BR-CALC-02,
// snapshot reserve_bp) differs from booked_base_fen, once per sub-order and estimate value, behind
// settle.estimate_change_diff.enabled (default on). Default order: booked_base 850 / booked_n 1000,
// reserve 1500; estimate 2000 → base 1700, 3000 → 2550, 1000 → 850 (equal), 0 → 0.
// 「R9 与 R9b 的判定」(BR-FUND-01): refunded_quantity increased in the same sync, or an order_rights
// row exists for the order → R9, not R9b; with the settlement record unchanged and no deduction
// given, N_new has no source (BR-FUND-08 ③) → WAIT_COMMISSION.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  DIFF_SWITCH,
  TIMEOUT,
  databaseFixture,
  harness,
  receivable,
  type Harness,
  type SeededOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

async function unchanged(h: Harness, o: SeededOrder): Promise<void> {
  expect(await h.clawbackKeys(o)).toEqual([]);
  expect(await h.rebateColumns(o)).toEqual({
    rebate_status: 'CREDITED',
    booked_base_fen: 850n,
    booked_n_fen: 1000n,
    reason: null,
    diff_reason_code: null,
    rights_pending: false,
    hold: false,
  });
  expect(await h.balance(o.user('self'))).toBe(425n);
  expect(await h.balance(o.user('direct'))).toBe(85n);
  expect(await h.balance(o.user('indirect'))).toBe(42n);
  expect(await h.orderSubjectNet(o, receivable(o))).toBe(1000n);
}

/** Warn lines (pino level 40) with an `alert` field and app_id that name this sub-order. */
function alertsFor(h: Harness, o: SeededOrder): Record<string, unknown>[] {
  return h.logs.filter(
    (line) =>
      line['level'] === 40 &&
      typeof line['alert'] === 'string' &&
      line['app_id'] === h.appId &&
      Object.values(line).some(
        (v) => typeof v === 'string' && (v === o.orderId || v.includes(o.subOrderId)),
      ),
  );
}

/** WAIT_COMMISSION only: no voucher; booked pair and balances kept; pending row opened. */
async function waiting(h: Harness, o: SeededOrder): Promise<void> {
  expect(await h.clawbackKeys(o)).toEqual([]);
  expect(await h.rebateColumns(o)).toMatchObject({
    rebate_status: 'CREDITED',
    booked_base_fen: 850n,
    booked_n_fen: 1000n,
    reason: null,
  });
  expect(await h.balance(o.user('self'))).toBe(425n);
  expect(await h.balance(o.user('direct'))).toBe(85n);
  expect(await h.balance(o.user('indirect'))).toBe(42n);
  expect(await h.orderSubjectNet(o, receivable(o))).toBe(1000n);
  expect(await h.rebateHistoryAfterCredit(o)).toEqual([]);
  expect(h.openPending).toHaveBeenCalledWith(
    h.transactions.at(-1),
    expect.objectContaining({
      appId: h.appId,
      orderId: o.orderId,
      platform: o.platform,
      subOrderId: o.subOrderId,
      reason: 'CLAWBACK_NO_COMMISSION',
    }),
  );
  expect(await h.pendingRows(o)).toEqual([
    expect.objectContaining({ reason: 'CLAWBACK_NO_COMMISSION', status: 'open' }),
  ]);
  // Not R9b: no「入账后预估佣金变化」diff.
  expect(await h.reconDiffs()).toEqual([]);
}

it(
  '[AC-B2-04s#32] 结算记录未变、只有预估佣金变化（2000）：只存档，不写凭证、不改 booked；预估基数 1700 ≠ booked_base 850 → 登记一条差错单 estimate_changed_after_credit（open，指向本子订单，expected 850 / actual 1700 / diff 850）',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const { result } = await h.sync(o, { event: 'PLATFORM_SETTLED', estAfter: 2000n });

    expect(result).toEqual({
      outcome: 'estimate_archived',
      orderKey: o.orderKey,
      reconDiff: 'registered',
    });
    await unchanged(h, o);
    expect(await h.reconDiffs()).toEqual([
      expect.objectContaining({
        type: 'estimate_changed_after_credit',
        status: 'open',
        ref_id: expect.stringContaining(o.orderKey),
        expected_fen: 850n,
        actual_fen: 1700n,
        diff_fen: 850n,
      }),
    ]);
    // R9b: the diff is registered「并告警」.
    expect(alertsFor(h, o).length).toBeGreaterThan(0);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#33] 同一子订单同一预估值只生成一次：原样重投不再登记；改为 3000 再登记一条（actual 2550）；改回 2000 不再登记',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const first = await h.sync(o, { event: 'PLATFORM_SETTLED', estAfter: 2000n });
    expect(first.result).toMatchObject({ outcome: 'estimate_archived' });
    expect(await h.reconDiffs()).toHaveLength(1);

    await h.deliver(first.change, first.source);
    expect(await h.reconDiffs()).toHaveLength(1);

    await h.sync(o, { event: 'PLATFORM_SETTLED', estAfter: 3000n });
    const rows = await h.reconDiffs();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.actual_fen).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([
      1700n,
      2550n,
    ]);

    await h.sync(o, { event: 'PLATFORM_SETTLED', estAfter: 2000n });
    expect(await h.reconDiffs()).toHaveLength(2);
    await unchanged(h, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#34] 预估换算出的基数与 booked_base 相同（1000 → 850）：只存档，不登记差错单',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const { result } = await h.sync(o, { event: 'PLATFORM_SETTLED', estAfter: 1000n });

    expect(result).toEqual({
      outcome: 'estimate_archived',
      orderKey: o.orderKey,
      reconDiff: 'none',
    });
    expect(await h.reconDiffs()).toEqual([]);
    await unchanged(h, o);
    expect(alertsFor(h, o)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#35] 开关 settle.estimate_change_diff.enabled 关闭（false / "false" / "off"）：只存档、不生成差错单',
  async () => {
    const h = await harness(p.db);
    for (const off of [false, 'false', 'off'] as const) {
      h.configValues.set(DIFF_SWITCH, off);
      const o = await h.credited();
      const { result } = await h.sync(o, { event: 'PLATFORM_SETTLED', estAfter: 2000n });
      expect(result, String(off)).toEqual({
        outcome: 'estimate_archived',
        orderKey: o.orderKey,
        reconDiff: 'disabled',
      });
      await unchanged(h, o);
      expect(alertsFor(h, o), String(off)).toEqual([]);
    }
    expect(await h.reconDiffs()).toEqual([]);
    expect(h.configGet).toHaveBeenCalledWith(h.appId, DIFF_SWITCH);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#36] 结算记录未变而预估佣金变为 0：仍按 R9b 只存档（不按 R8 扣回），登记差错单 actual 0',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const { result } = await h.sync(o, { event: 'PLATFORM_SETTLED', estAfter: 0n });

    expect(result).toMatchObject({ outcome: 'estimate_archived', reconDiff: 'registered' });
    await unchanged(h, o);
    expect(await h.reconDiffs()).toEqual([
      expect.objectContaining({
        type: 'estimate_changed_after_credit',
        expected_fen: 850n,
        actual_fen: 0n,
        diff_fen: -850n,
      }),
    ]);
    expect(alertsFor(h, o).length).toBeGreaterThan(0);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#41] 同一次同步里退货件数增加（2 件退 1）、预估同时变为 2000：不按 R9b 只存档、不登记差错单，按 R9 处理；结算记录未变、无应扣佣金 → ③ WAIT_COMMISSION（待处理 CLAWBACK_NO_COMMISSION），不写凭证、booked 不变',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited({ patch: { quantity: 2 } });
    const { result } = await h.sync(o, {
      event: 'PLATFORM_SETTLED',
      estAfter: 2000n,
      refundedQuantityAfter: 1,
    });

    expect(result).toMatchObject({ outcome: 'wait_commission', orderKey: o.orderKey });
    expect(result.outcome).not.toBe('estimate_archived');
    await waiting(h, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#42] 订单存在 order_rights（PROCESSING、无应扣佣金）时预估变为 2000：不按 R9b 只存档、不登记差错单，按 R9 处理 → ③ WAIT_COMMISSION：order_rights 置 WAIT_COMMISSION、rights_pending 为 true，进待处理表，不写凭证、booked 不变',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const rightsId = await h.rights(o, { status: 'PROCESSING' });
    const { result } = await h.sync(o, { event: 'PLATFORM_SETTLED', estAfter: 2000n });

    expect(result).toMatchObject({ outcome: 'wait_commission', orderKey: o.orderKey });
    expect(result.outcome).not.toBe('estimate_archived');
    await waiting(h, o);
    expect(await h.rightsRow(rightsId)).toMatchObject({ status: 'WAIT_COMMISSION' });
    expect(await h.read(o)).toMatchObject({ rights_pending: true });
  },
  TIMEOUT,
);
