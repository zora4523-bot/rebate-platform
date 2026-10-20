import {
  buildVouchers,
  type BeneficiaryCreditInput,
  type CreditBeneficiary,
  type CreditBeneficiaryState,
  type CreditNetPosition,
  type CreditVoucherRequest,
  type InitialCreditInput,
  type LedgerRole,
} from '@couli/domain';

export const normal: CreditBeneficiaryState = {
  risk_state: 'normal',
  deletion_status: null,
  is_minor: false,
};

export function person(
  role: LedgerRole,
  ratio_bp: bigint,
  current: Partial<CreditBeneficiaryState> = {},
): CreditBeneficiary {
  return {
    user_id: `u-${role}`,
    role,
    ratio_bp,
    snapshot_status: 'active',
    current: { ...normal, ...current },
  };
}

export function initial(overrides: Partial<InitialCreditInput> = {}): InitialCreditInput {
  return {
    platform: 'taobao',
    sub_order_id: '1234567',
    b_credit_fen: 800n,
    reserve_fen: 200n,
    beneficiaries: [person('self', 5000n), person('direct', 1000n)],
    ...overrides,
  };
}

export function position(overrides: Partial<CreditNetPosition> = {}): CreditNetPosition {
  return {
    user_id: 'u-self',
    role: 'self',
    ratio_bp: 5000n,
    snapshot_status: 'active',
    net_fen: 400n,
    has_open_obligation: true,
    ...overrides,
  };
}

/** 已入账400，当前B=960应得480，剩余80；整单应收1120=1200-80。 */
export function supplemental(
  overrides: Partial<BeneficiaryCreditInput> = {},
): BeneficiaryCreditInput {
  return {
    platform: 'taobao',
    sub_order_id: '1234567',
    rebate_status: 'CREDITED',
    rights_pending: false,
    settlement_seq: 7n,
    expected_settlement_seq: 7n,
    snapshot_id: 'snapshot-1',
    booked_base_fen: 960n,
    booked_n_fen: 1200n,
    union_receivable_net_fen: 1120n,
    positions: [position()],
    current: normal,
    obligation: {
      beneficiary_credit_id: 'obligation-1',
      user_id: 'u-self',
      role: 'self',
      snapshot_id: 'snapshot-1',
      status: 'open',
      kind: 'deferred',
      credit_template: 'ADJ:DEFERRED:SETTLE_DIFF',
    },
    ...overrides,
  };
}

export function materialize(requests: readonly CreditVoucherRequest[]) {
  return requests.flatMap(({ template_id, params }) => buildVouchers(template_id, params));
}

/** 无 I/O；冻结到每一层，mutation 会使测试失败。 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
