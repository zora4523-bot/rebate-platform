// B2-04l rule tests: R11 admin hold / unhold (orders' rebate.adminHold / adminUnhold; BR-FUND-06
// 细则「后台 hold / unhold」, D10-155, D10-157; BR-FUND-01 R11, CAS). Default order (credit kit):
// WAITING, hold=false. Refusals write nothing; the audit is orders' (settlement writes none).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { NOW, TIMEOUT, databaseFixture, harness } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it.each([
  ['WAITING', 'RISK'],
  ['ESTIMATED', 'CS'],
] as const)(
  '[AC-B2-04l#28] %s 订单 hold（原因码 %s）：applied；hold=true、hold_reason=原因码，返利状态不变，row_version+1、updated_at=now；不写凭证、不写审计',
  async (rebateStatus, reasonCode) => {
    const h = await harness(p.db);
    const o = await h.order({ patch: { rebate_status: rebateStatus } });
    const before = await h.read(o);

    expect(await h.hold('hold', o, { reasonCode })).toEqual({ kind: 'applied' });
    expect(await h.read(o)).toMatchObject({
      rebate_status: rebateStatus,
      hold: true,
      hold_reason: reasonCode,
      rights_pending: false,
      row_version: before.row_version + 1,
      updated_at: new Date(NOW),
    });
    expect(await h.orderVoucherKeys(o)).toEqual([]);
    expect(await h.audits()).toEqual([]);
  },
  TIMEOUT,
);

it.each(['RISK', 'CS', 'UNMAPPED_STATUS'] as const)(
  '[AC-B2-04l#29] 已 hold（hold_reason %s）的 WAITING 订单 unhold：applied；hold=false、hold_reason=null，返利状态不变，row_version+1；UNMAPPED_STATUS 的待处理记录由 orders 先判',
  async (heldReason) => {
    const h = await harness(p.db);
    const o = await h.order({ patch: { hold: true, hold_reason: heldReason } });
    const before = await h.read(o);

    expect(await h.hold('unhold', o, { reasonCode: 'CS' })).toEqual({ kind: 'applied' });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'WAITING',
      hold: false,
      hold_reason: null,
      row_version: before.row_version + 1,
      updated_at: new Date(NOW),
    });
    expect(await h.audits()).toEqual([]);
  },
  TIMEOUT,
);

it.each([
  ['hold', true],
  ['unhold', false],
] as const)(
  '[AC-B2-04l#30] 同状态（%s 时 hold 已是 %s）：same_state，订单不变、不写历史',
  async (mode, held) => {
    const h = await harness(p.db);
    const o = await h.order({ patch: { hold: held, hold_reason: held ? 'RISK' : null } });
    const before = await h.everything();

    expect(await h.hold(mode, o)).toEqual({ kind: 'same_state' });
    expect(await h.everything()).toEqual(before);
  },
  TIMEOUT,
);

it.each([
  ['hold', false, -1],
  ['hold', false, 1],
  ['unhold', true, -1],
  ['unhold', true, 1],
] as const)(
  '[AC-B2-04l#31] %s（hold=%s）时 expected_row_version 与库内差 %s：cas_conflict，什么都不写',
  async (mode, held, offset) => {
    const h = await harness(p.db);
    const o = await h.order({
      patch: { hold: held, hold_reason: held ? 'CS' : null, row_version: 3 },
    });
    const before = await h.everything();

    expect(await h.hold(mode, o, { expected: (row) => row.row_version + offset })).toEqual({
      kind: 'cas_conflict',
    });
    expect(await h.everything()).toEqual(before);
  },
  TIMEOUT,
);

it.each([
  ['hold', 'UNATTRIBUTED', false],
  ['hold', 'CREDITED', false],
  ['hold', 'VOID', false],
  ['hold', 'CLAWED_BACK', false],
  ['unhold', 'UNATTRIBUTED', true],
  ['unhold', 'CREDITED', true],
  ['unhold', 'VOID', true],
  ['unhold', 'CLAWED_BACK', true],
] as const)(
  '[AC-B2-04l#32] %s 不在 R11 的来源（返利 %s，hold=%s）：not_applicable，订单不变、不写历史（CREDITED 之后不得 hold；作废后保留的 hold 不提供解除）',
  async (mode, rebateStatus, held) => {
    const h = await harness(p.db);
    const o = await h.order({
      patch: { rebate_status: rebateStatus, hold: held, hold_reason: held ? 'RISK' : null },
    });
    const before = await h.everything();

    expect(await h.hold(mode, o)).toEqual({ kind: 'not_applicable' });
    expect(await h.everything()).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04l#33] hold 不碰维权与金额列：rights_pending=true 的 WAITING 订单 hold 后 rights_pending 仍为 true，预估、结算佣金与 booked 不变',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ patch: { rights_pending: true } });

    expect(await h.hold('hold', o)).toEqual({ kind: 'applied' });
    expect(await h.read(o)).toMatchObject({
      hold: true,
      hold_reason: 'RISK',
      rights_pending: true,
      est_commission_fen: 3222n,
      settle_commission_fen: 1000n,
      booked_base_fen: null,
      booked_n_fen: null,
      reason: null,
    });
  },
  TIMEOUT,
);

it.each(['hold', 'unhold'] as const)(
  '[AC-B2-04l#34] 只用调用方的事务：%s applied 后调用方事务失败 → hold、hold_reason、row_version 一起回滚',
  async (mode) => {
    const h = await harness(p.db);
    const held = mode === 'unhold';
    const o = await h.order({ patch: { hold: held, hold_reason: held ? 'RISK' : null } });
    const before = await h.everything();

    await expect(
      h.hold(mode, o, {
        after: async () => {
          throw new Error('caller rolls back');
        },
      }),
    ).rejects.toThrow('caller rolls back');
    expect(await h.everything()).toEqual(before);
  },
  TIMEOUT,
);
