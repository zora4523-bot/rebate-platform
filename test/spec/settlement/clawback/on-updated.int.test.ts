// B2-04s rule tests: the onUpdated reverse-event entry on a CREDITED sub-order (BR-FUND-01 P6 /
// P7 / P8 → R8; BR-FUND-08). Example (credited by B2-04m): N = 1000, reserve_bp = 1500 → B = 850,
// reserve 150; self 5000 / direct 1000 / indirect 500 → 425 / 85 / 42; platform 298 + 150 = 448;
// UNION_RECEIVABLE 1000. A full clawback takes 425 / 85 / 42 back and the platform difference is
// 448 (debit COMMISSION_REVENUE / credit UNION_RECEIVABLE), so UNION_RECEIVABLE nets to 0.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  NOW,
  TIMEOUT,
  clawbackKey,
  databaseFixture,
  harness,
  platformClawbackKey,
  platformDecreaseLines,
  receivable,
  userClawbackLines,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04s#1] P7 结算后失效（onUpdated，平台状态仍为 SETTLED、事件 PLATFORM_INVALID）：R8 全额扣回，三张受益人 CLAWBACK（FULL）+ 平台差额凭证，键 P{row_version}，booked 成对清零，CLAWED_BACK、原因码 REFUND、历史 INVALID_AFTER_SETTLE、order.clawed_back 同事务',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const { result, rowVersion } = await h.sync(o, { event: 'PLATFORM_INVALID', rule: 'P7' });
    const id = `P${String(rowVersion)}`;

    expect(result).toEqual({
      outcome: 'clawed_back',
      transition: 'R8',
      orderKey: o.orderKey,
      rightsEventId: id,
      bookedBaseFen: 0n,
      bookedNFen: 0n,
    });
    expect(await h.clawbackKeys(o)).toEqual(
      [
        clawbackKey(o, 'self', id),
        clawbackKey(o, 'direct', id),
        clawbackKey(o, 'indirect', id),
        platformClawbackKey(o, id),
      ].sort(),
    );
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 425n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 85n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'indirect', id))).toEqual(
      userClawbackLines(o, 'indirect', 42n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 448n),
    );
    for (const key of await h.clawbackKeys(o)) {
      expect(await h.voucherTypes(key), key).toEqual(['CLAWBACK|FULL']);
      expect(await h.voucher(key), key).toMatchObject({
        voucher_kind: 'CLAWBACK',
        order_key: o.orderKey,
      });
    }
    for (const role of ['self', 'direct', 'indirect'] as const) {
      expect(await h.voucher(clawbackKey(o, role, id))).toMatchObject({
        beneficiary_user_id: o.user(role),
        role,
      });
      expect(await h.balance(o.user(role))).toBe(0n);
      expect(await h.netOf(o, role)).toBe(0n);
    }
    expect(await h.voucher(platformClawbackKey(o, id))).toMatchObject({
      beneficiary_user_id: null,
      role: null,
    });
    // BR-FUND-08: UNION_RECEIVABLE net impact = −(booked_n 1000 − 0) → the order's receivable is 0.
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
    expect(await h.orderSubjectNet(o, 'COMMISSION_REVENUE')).toBe(0n);
    expect((await h.nets(o)).platform_net_fen).toBe(0n);

    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      reason: 'REFUND',
      platform_status: 'SETTLED',
      row_version: rowVersion + 1,
    });
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({
        field: 'rebate',
        from_status: 'CREDITED',
        to_status: 'CLAWED_BACK',
        event: 'INVALID_AFTER_SETTLE',
        at: new Date(NOW),
      }),
    ]);
    expect(h.publish).toHaveBeenCalledWith(
      h.transactions.at(-1),
      expect.objectContaining({
        appId: h.appId,
        name: 'order.clawed_back',
        payload: expect.objectContaining({ order_id: o.orderId }),
      }),
    );
    expect((await h.published()).map((e) => e.name)).toEqual([
      'order.credited',
      'order.clawed_back',
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#2] P6 已收货订单失效（RECEIVED → INVALID）：R8 全额扣回，键 P{row_version}，历史事件 PLATFORM_INVALID、原因码 REFUND、sub_type FULL',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited({ patch: { platform_status: 'RECEIVED' } });
    const { result, rowVersion } = await h.sync(o, {
      event: 'PLATFORM_INVALID',
      rule: 'P6',
      platformStatus: 'INVALID',
    });
    const id = `P${String(rowVersion)}`;

    expect(result).toMatchObject({ outcome: 'clawed_back', transition: 'R8', rightsEventId: id });
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 425n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 85n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'indirect', id))).toEqual(
      userClawbackLines(o, 'indirect', 42n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 448n),
    );
    for (const key of await h.clawbackKeys(o)) {
      expect(await h.voucherTypes(key), key).toEqual(['CLAWBACK|FULL']);
    }
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      reason: 'REFUND',
    });
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({
        from_status: 'CREDITED',
        to_status: 'CLAWED_BACK',
        event: 'PLATFORM_INVALID',
      }),
    ]);
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#3] P8 处罚（onUpdated，事件 PLATFORM_PUNISH，平台状态不变）：R8 全额扣回，sub_type PUNISH、原因码 PUNISH、历史事件 PUNISH，键 P{row_version}',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const { result, rowVersion } = await h.sync(o, { event: 'PLATFORM_PUNISH', rule: 'P8' });
    const id = `P${String(rowVersion)}`;

    expect(result).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R8',
      rightsEventId: id,
      bookedBaseFen: 0n,
      bookedNFen: 0n,
    });
    expect(await h.clawbackKeys(o)).toEqual(
      [
        clawbackKey(o, 'self', id),
        clawbackKey(o, 'direct', id),
        clawbackKey(o, 'indirect', id),
        platformClawbackKey(o, id),
      ].sort(),
    );
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 425n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 448n),
    );
    for (const key of await h.clawbackKeys(o)) {
      expect(await h.voucherTypes(key), key).toEqual(['CLAWBACK|PUNISH']);
    }
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      reason: 'PUNISH',
      platform_status: 'SETTLED',
    });
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([
      expect.objectContaining({
        from_status: 'CREDITED',
        to_status: 'CLAWED_BACK',
        event: 'PUNISH',
      }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#4] P8 维权（事件 PLATFORM_RIGHTS）不在本入口扣回（维权成功入口待 B2-04l）：跳过，不写凭证、不迁移、余额与 booked 不变',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const { result } = await h.sync(o, { event: 'PLATFORM_RIGHTS', rule: 'P8' });

    expect(result).toMatchObject({ outcome: 'skipped' });
    expect(await h.clawbackKeys(o)).toEqual([]);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      reason: null,
    });
    expect(await h.rebateHistoryAfterCredit(o)).toEqual([]);
    expect(await h.balance(o.user('self'))).toBe(425n);
    expect(await h.balance(o.user('direct'))).toBe(85n);
    expect(await h.balance(o.user('indirect'))).toBe(42n);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#5] 未入账订单（WAITING）收到失效：扣回入口跳过（not_credited），不写任何凭证、不改返利列（入账前作废归 B2-04j）',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const before = await h.rebateColumns(o);
    const { result } = await h.sync(o, { event: 'PLATFORM_INVALID', rule: 'P7' });

    expect(result).toEqual({ outcome: 'skipped', reason: 'not_credited' });
    expect(await h.orderVoucherKeys(o)).toEqual([]);
    expect(await h.rebateColumns(o)).toEqual(before);
    expect(await h.history(o)).toEqual([]);
    expect(h.post).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#6] 重放：R8 之后同一失效再次同步或原样重投，订单已是 CLAWED_BACK → 跳过，凭证、余额与历史都不再增加',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const first = await h.sync(o, { event: 'PLATFORM_INVALID', rule: 'P7' });
    expect(first.result).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
    const keys = await h.orderVoucherKeys(o);
    const history = await h.rebateHistoryAfterCredit(o);

    expect(await h.deliver(first.change, first.source)).toEqual({
      outcome: 'skipped',
      reason: 'not_credited',
    });
    const again = await h.sync(o, { event: 'PLATFORM_INVALID', rule: 'P7' });
    expect(again.result).toEqual({ outcome: 'skipped', reason: 'not_credited' });

    expect(await h.orderVoucherKeys(o)).toEqual(keys);
    expect(await h.rebateHistoryAfterCredit(o)).toEqual(history);
    expect(await h.balance(o.user('self'))).toBe(0n);
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
    expect((await h.published()).filter((e) => e.name === 'order.clawed_back')).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04s#7] 原子性：order.clawed_back 入队失败 → 整个同步事务回滚，凭证、余额、订单列、历史与事件都回到扣回前',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    h.boot();
    const before = await h.state();
    h.publish.mockImplementationOnce(async () => {
      throw new Error('injected publish failure');
    });

    await expect(h.sync(o, { event: 'PLATFORM_INVALID', rule: 'P7' })).rejects.toThrow(
      'injected publish failure',
    );
    expect(await h.state()).toEqual(before);
  },
  TIMEOUT,
);
