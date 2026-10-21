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

const deferredOpen = { beneficiary_credit_id: 'd1', kind: 'deferred' } as const;

// 基数 500、预留 5000bp；唯一受益人 5000bp 重拆 250、净额 200，延后义务待补记 50。
function sameBaseOrder(overrides: Partial<AdjustmentInput> = {}): AdjustmentInput {
  return order({
    event: 'settlement',
    reserve_bp: 5000n,
    booked_base_fen: 500n,
    booked_n_fen: 1000n,
    n_new_fen: 1001n,
    platform_net_fen: 750n,
    beneficiaries: [person({ net_fen: 200n, obligation: deferredOpen })],
    ...overrides,
  });
}

it('[AC-B2-04g#10] 基数相等、佣金 1000→1001：只调平台 +1，用户差额 0，未完成义务原样保留', () => {
  const plan = planCommissionAdjustment(sameBaseOrder());
  expect(plan).toMatchObject({
    route: 'approval',
    transition: 'R10',
    ledger_type: 'SETTLE_ADJUST',
    booked_after: { booked_base_fen: 500n, booked_n_fen: 1001n },
    platform_after_fen: 751n,
    platform_delta_fen: 1n,
    platform_posting: { amount_fen: 1n, debit: 'UNION_RECEIVABLE', credit: 'COMMISSION_REVENUE' },
    union_receivable_delta_fen: 1n,
    void_pending_candidates: false,
  });
  expect(plan.beneficiaries[0]).toMatchObject({
    entitlement_fen: 250n,
    delta_fen: 0n,
    net_after_fen: 200n,
    posting: null,
    pending_before_fen: 50n,
    pending_after_fen: 50n,
    obligation_action: 'keep',
    beneficiary_credit_id: 'd1',
  });
});

it('[AC-B2-04g#10] 基数相等、佣金 1001→1000：平台即时 -1，用户差额 0，义务保持', () => {
  const plan = planCommissionAdjustment(
    sameBaseOrder({ booked_n_fen: 1001n, n_new_fen: 1000n, platform_net_fen: 751n }),
  );
  expect(plan).toMatchObject({
    route: 'immediate',
    transition: 'R10',
    platform_delta_fen: -1n,
    platform_posting: { amount_fen: 1n, debit: 'COMMISSION_REVENUE', credit: 'UNION_RECEIVABLE' },
    union_receivable_delta_fen: -1n,
  });
  expect(plan.beneficiaries[0]).toMatchObject({
    delta_fen: 0n,
    pending_after_fen: 50n,
    obligation_action: 'keep',
  });
});

it('[AC-B2-04g#10] 基数相等时封禁受益人的未完成义务不没收，不归平台', () => {
  const plan = planCommissionAdjustment(
    sameBaseOrder({
      beneficiaries: [person({ net_fen: 200n, risk_state: 'banned', obligation: deferredOpen })],
    }),
  );
  expect(plan.platform_delta_fen).toBe(1n);
  expect(plan.beneficiaries[0]).toMatchObject({
    delta_fen: 0n,
    forfeit_fen: 0n,
    forfeit_reason: null,
    pending_after_fen: 50n,
    obligation_action: 'keep',
    append_forfeited_event: false,
  });
});

it('[AC-B2-04g#10] 扣回事件基数相等、佣金 1001→1000：R9 只冲平台 1，义务保持并作废候选', () => {
  const plan = planCommissionAdjustment(
    sameBaseOrder({
      event: 'clawback',
      booked_n_fen: 1001n,
      n_new_fen: 1000n,
      platform_net_fen: 751n,
    }),
  );
  expect(plan).toMatchObject({
    transition: 'R9',
    ledger_type: 'CLAWBACK',
    platform_delta_fen: -1n,
    union_receivable_delta_fen: -1n,
    void_pending_candidates: true,
  });
  expect(plan.beneficiaries[0]).toMatchObject({ delta_fen: 0n, obligation_action: 'keep' });
});

it('[AC-B2-04g#14] 扣回事件金额差为 0：无凭证，但仍作废该单未批准的正差候选', () => {
  const plan = planCommissionAdjustment(order({ event: 'clawback', n_new_fen: 1000n }));
  expect(plan).toMatchObject({
    route: 'none',
    transition: null,
    ledger_type: null,
    platform_posting: null,
    union_receivable_delta_fen: 0n,
    void_pending_candidates: true,
  });
  expect(plan.beneficiaries[0]).toMatchObject({ delta_fen: 0n, posting: null });
});

it('[AC-B2-04g#14] 扣回事件金额差为 0 且有未完成义务：义务保持，候选仍作废', () => {
  const plan = planCommissionAdjustment(sameBaseOrder({ event: 'clawback', n_new_fen: 1000n }));
  expect(plan).toMatchObject({ route: 'none', void_pending_candidates: true });
  expect(plan.beneficiaries[0]).toMatchObject({
    delta_fen: 0n,
    pending_after_fen: 50n,
    obligation_action: 'keep',
  });
});

it('[AC-B2-04g#14] 结算事件两值均相等：不作废候选', () => {
  const plan = planCommissionAdjustment(sameBaseOrder({ n_new_fen: 1000n }));
  expect(plan).toMatchObject({ route: 'none', void_pending_candidates: false });
});

it('[AC-B2-04g#10] 扣回事件基数不变、受益人封禁且有未完成义务：义务没收，重拆份额归平台', () => {
  const plan = planCommissionAdjustment(
    sameBaseOrder({
      event: 'clawback',
      booked_n_fen: 1001n,
      n_new_fen: 1000n,
      platform_net_fen: 751n,
      beneficiaries: [
        person({
          net_fen: 0n,
          risk_state: 'banned',
          obligation: { beneficiary_credit_id: 'c1', kind: 'first_credit' },
        }),
      ],
    }),
  );
  expect(plan).toMatchObject({
    route: 'immediate',
    transition: 'R9',
    rebate_status: 'CREDITED',
    ledger_type: 'CLAWBACK',
    booked_after: { booked_base_fen: 500n, booked_n_fen: 1000n },
    platform_after_fen: 1000n,
    platform_delta_fen: 249n,
    platform_posting: { amount_fen: 249n, debit: 'UNION_RECEIVABLE', credit: 'COMMISSION_REVENUE' },
    union_receivable_delta_fen: 249n,
    void_pending_candidates: true,
  });
  expect(plan.beneficiaries[0]).toMatchObject({
    entitlement_fen: 0n,
    delta_fen: 0n,
    net_after_fen: 0n,
    posting: null,
    forfeit_fen: 250n,
    forfeit_reason: 'banned',
    pending_before_fen: 250n,
    pending_after_fen: 0n,
    obligation_action: 'forfeited',
    beneficiary_credit_id: 'c1',
    append_forfeited_event: true,
  });
});

// 第 4 轮（编排 D10-101）：结算补差与扣回分两条路径，扣回任何差额（含 0）都按当前状态重算。
// 评审 r3 例：booked_n 1000、booked_base 800、预留 2000bp；唯一受益人 5000bp，净额 0，
// 首次入账义务待补记 400，平台净额 600。
function zeroDeductOrder(overrides: Partial<AdjustmentBeneficiary> = {}): AdjustmentInput {
  return order({
    n_new_fen: 1000n,
    beneficiaries: [
      person({
        net_fen: 0n,
        obligation: { beneficiary_credit_id: 'f1', kind: 'first_credit' },
        ...overrides,
      }),
    ],
  });
}

it('[AC-B2-04g#43] 扣回应扣佣金 0、受益人冻结转封禁：义务没收、400 归平台，即时 R9', () => {
  const plan = planCommissionAdjustment(zeroDeductOrder({ risk_state: 'banned' }));
  expect(plan).toMatchObject({
    route: 'immediate',
    transition: 'R9',
    rebate_status: 'CREDITED',
    ledger_type: 'CLAWBACK',
    booked_after: { booked_base_fen: 800n, booked_n_fen: 1000n },
    platform_after_fen: 1000n,
    platform_delta_fen: 400n,
    platform_posting: { amount_fen: 400n, debit: 'UNION_RECEIVABLE', credit: 'COMMISSION_REVENUE' },
    union_receivable_delta_fen: 400n,
    void_pending_candidates: true,
  });
  expect(plan.beneficiaries[0]).toMatchObject({
    entitlement_fen: 0n,
    delta_fen: 0n,
    posting: null,
    forfeit_fen: 400n,
    forfeit_reason: 'banned',
    pending_before_fen: 400n,
    pending_after_fen: 0n,
    obligation_action: 'forfeited',
    beneficiary_credit_id: 'f1',
    append_forfeited_event: true,
  });
});

it.each([
  { label: 'processing', state: { deletion_status: 'processing' }, reason: 'deleted' },
  { label: 'done', state: { deletion_status: 'done' }, reason: 'deleted' },
  { label: 'minor-share', state: { is_minor: true, role: 'share' }, reason: 'minor' },
] as const)(
  '[AC-B2-04g#43] 扣回应扣佣金 0、受益人 $label：首次义务同样没收归平台',
  ({ state, reason }) => {
    const plan = planCommissionAdjustment(zeroDeductOrder(state));
    expect([plan.route, plan.transition, plan.platform_delta_fen]).toEqual([
      'immediate',
      'R9',
      400n,
    ]);
    expect(plan.beneficiaries[0]).toMatchObject({
      forfeit_fen: 400n,
      forfeit_reason: reason,
      obligation_action: 'forfeited',
      append_forfeited_event: true,
    });
  },
);

it('[AC-B2-04g#43] 同一输入换成结算事件：两值相等无动作，封禁受益人的义务原样保留', () => {
  const plan = planCommissionAdjustment({
    ...zeroDeductOrder({ risk_state: 'banned' }),
    event: 'settlement',
  });
  expect(plan).toMatchObject({ route: 'none', transition: null, void_pending_candidates: false });
  expect(plan.beneficiaries[0]).toMatchObject({
    forfeit_fen: 0n,
    pending_after_fen: 400n,
    obligation_action: 'keep',
    append_forfeited_event: false,
  });
});

it.each(['normal', 'frozen', 'appealing'] as const)(
  '[AC-B2-04g#43] 扣回应扣佣金 0、受益人 %s：待补记不变，无凭证但作废候选',
  (risk_state) => {
    const plan = planCommissionAdjustment(zeroDeductOrder({ risk_state }));
    expect(plan).toMatchObject({
      route: 'none',
      transition: null,
      ledger_type: null,
      platform_posting: null,
      union_receivable_delta_fen: 0n,
      void_pending_candidates: true,
    });
    expect(plan.beneficiaries[0]).toMatchObject({
      pending_after_fen: 400n,
      obligation_action: 'keep',
    });
  },
);

it('[AC-B2-04g#43] 扣回事件 N 上升也不走审批：正常受益人正差留作待补记，即时 R9', () => {
  const plan = planCommissionAdjustment(order({ n_new_fen: 1200n }));
  expect(plan).toMatchObject({
    route: 'immediate',
    transition: 'R9',
    ledger_type: 'CLAWBACK',
    booked_after: { booked_base_fen: 960n, booked_n_fen: 1200n },
    platform_after_fen: 720n,
    platform_delta_fen: 120n,
    union_receivable_delta_fen: 120n,
  });
  expect(plan.beneficiaries[0]).toMatchObject({
    delta_fen: 0n,
    net_after_fen: 400n,
    posting: null,
    pending_after_fen: 80n,
    obligation_action: 'open',
  });
});

it('[AC-B2-04g#43] 扣回事件受益人无义务、零差：重算无变化即无动作', () => {
  const plan = planCommissionAdjustment(
    order({ n_new_fen: 1000n, beneficiaries: [person({ risk_state: 'banned' })] }),
  );
  expect(plan).toMatchObject({ route: 'none', void_pending_candidates: true });
  expect(plan.beneficiaries[0]).toMatchObject({
    entitlement_fen: 400n,
    forfeit_fen: 0n,
    obligation_action: null,
  });
});

it('[AC-B2-04g#15] 扣回事件两值相等也做应收自检，输入不平即抛错', () => {
  expect(() =>
    planCommissionAdjustment(order({ n_new_fen: 1000n, platform_net_fen: 601n })),
  ).toThrow(AdjustmentReceivableMismatch);
});
