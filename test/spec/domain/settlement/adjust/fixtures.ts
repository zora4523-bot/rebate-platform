import type {
  AdjustmentBeneficiary,
  AdjustmentInput,
  ClawbackCommissionInput,
} from '@couli/domain';

export function beneficiary(overrides: Partial<AdjustmentBeneficiary> = {}): AdjustmentBeneficiary {
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

export function input(overrides: Partial<AdjustmentInput> = {}): AdjustmentInput {
  return {
    event: 'clawback',
    n_new_fen: 600n,
    reserve_bp: 2000n,
    booked_base_fen: 800n,
    booked_n_fen: 1000n,
    platform_net_fen: 520n,
    beneficiaries: [
      beneficiary(),
      beneficiary({ user_id: 'u2', role: 'direct', ratio_bp: 1000n, net_fen: 80n }),
    ],
    ...overrides,
  };
}

export function source(overrides: Partial<ClawbackCommissionInput> = {}): ClawbackCommissionInput {
  return {
    full_invalid: false,
    booked_n_fen: 1000n,
    settle_commission_fen: 1000n,
    settlement_seq_changed: false,
    est_commission_fen: null,
    estimate_changed: false,
    rights_deduct_fen: null,
    adapter_estimate_fen: null,
    ...overrides,
  };
}

/** 深冻结也包括每个受益人和义务；被测纯函数不得修改调用方数据。 */
export function freezeInput(value: AdjustmentInput): AdjustmentInput {
  for (const person of value.beneficiaries) {
    if (person.obligation !== null) Object.freeze(person.obligation);
    Object.freeze(person);
  }
  Object.freeze(value.beneficiaries);
  return Object.freeze(value);
}
