import { expect, it } from 'vitest';
import {
  AdjustmentReceivableMismatch,
  planCommissionAdjustment,
  selectClawbackCommission,
} from './adjust.ts';
import type { AdjustmentBeneficiary, AdjustmentInput } from './adjust.ts';

function person(overrides: Partial<AdjustmentBeneficiary> = {}): AdjustmentBeneficiary {
  return {
    user_id: 'u1',
    role: 'self',
    ratio_bp: 5000n,
    status: 'active',
    risk_state: 'normal',
    deletion_status: null,
    is_minor: false,
    net_fen: 400n,
    obligation: null,
    ...overrides,
  };
}

function order(overrides: Partial<AdjustmentInput> = {}): AdjustmentInput {
  return {
    event: 'clawback',
    n_new_fen: 600n,
    reserve_bp: 2000n,
    booked_base_fen: 800n,
    booked_n_fen: 1000n,
    platform_net_fen: 600n,
    beneficiaries: [person()],
    ...overrides,
  };
}

it('[AC-B2-04g#15] 输入不满足待补记等式时自检抛错，不给出可落账的计划', () => {
  expect(() => planCommissionAdjustment(order({ platform_net_fen: 601n }))).toThrow(
    AdjustmentReceivableMismatch,
  );
});

it('[AC-B2-04g#15] 两值均相等时不做自检，也不产生任何差额', () => {
  const plan = planCommissionAdjustment(
    order({ event: 'settlement', n_new_fen: 1000n, platform_net_fen: 1n }),
  );
  expect([plan.route, plan.platform_delta_fen, plan.union_receivable_delta_fen]).toEqual([
    'none',
    0n,
    0n,
  ]);
});

it('[AC-B2-04g#24] forfeited 在 R8 中也不生成调整，残留义务一并作废', () => {
  const plan = planCommissionAdjustment(
    order({
      n_new_fen: 0n,
      platform_net_fen: 1000n,
      beneficiaries: [
        person({
          status: 'forfeited',
          net_fen: 0n,
          obligation: { beneficiary_credit_id: 'c1', kind: 'first_credit' },
        }),
      ],
    }),
  );
  expect(plan.beneficiaries[0]).toMatchObject({
    delta_fen: 0n,
    posting: null,
    obligation_action: 'voided',
    pending_before_fen: 0n,
  });
});

it('[AC-B2-04g#22] 未成年受益人的自购份额正差照常补给', () => {
  const plan = planCommissionAdjustment(
    order({
      event: 'settlement',
      n_new_fen: 1200n,
      beneficiaries: [person({ is_minor: true })],
    }),
  );
  expect(plan.beneficiaries[0]).toMatchObject({ delta_fen: 80n, forfeit_fen: 0n });
});

it('[AC-B2-04g#5] 结算 seq 标记变化但结算额为空时不当作新结算值', () => {
  expect(
    selectClawbackCommission({
      full_invalid: false,
      booked_n_fen: 1000n,
      settle_commission_fen: null,
      settlement_seq_changed: true,
      est_commission_fen: null,
      estimate_changed: false,
      rights_deduct_fen: null,
      adapter_estimate_fen: 300n,
    }),
  ).toEqual({ kind: 'wait_commission' });
});
