// 单元测试：B2-04e 实现层的取舍；规则测试在 test/spec/domain/settlement/credit。
import { expect, it } from 'vitest';
import {
  checkCreditInvariant,
  planBeneficiaryCredit,
  planInitialCredit,
  type BeneficiaryCreditInput,
  type CreditBeneficiary,
} from './credit-plan.ts';

const normal = { risk_state: 'normal', deletion_status: null, is_minor: false } as const;

function person(overrides: Partial<CreditBeneficiary> = {}): CreditBeneficiary {
  return {
    user_id: 'u1',
    role: 'direct',
    ratio_bp: 5000n,
    snapshot_status: 'active',
    current: normal,
    ...overrides,
  };
}

function supplemental(overrides: Partial<BeneficiaryCreditInput> = {}): BeneficiaryCreditInput {
  return {
    platform: 'taobao',
    sub_order_id: '1',
    rebate_status: 'CREDITED',
    rights_pending: false,
    settlement_seq: 1n,
    expected_settlement_seq: 1n,
    snapshot_id: 's1',
    booked_base_fen: 100n,
    booked_n_fen: 100n,
    union_receivable_net_fen: 50n,
    positions: [
      {
        user_id: 'u1',
        role: 'direct',
        ratio_bp: 5000n,
        snapshot_status: 'active',
        net_fen: 0n,
        has_open_obligation: true,
      },
    ],
    current: normal,
    obligation: {
      beneficiary_credit_id: 'o1',
      user_id: 'u1',
      role: 'direct',
      snapshot_id: 's1',
      status: 'open',
      kind: 'initial',
    },
    ...overrides,
  };
}

it('[AC-B2-04e#u1] 多个失效原因并存时依次取 deleted、banned、minor，金额与动作不变', () => {
  const plan = planInitialCredit({
    platform: 'taobao',
    sub_order_id: '1',
    b_credit_fen: 100n,
    reserve_fen: 0n,
    beneficiaries: [
      person({
        user_id: 'a',
        current: { risk_state: 'banned', deletion_status: 'done', is_minor: true },
      }),
      person({
        user_id: 'b',
        ratio_bp: 1000n,
        current: { risk_state: 'banned', deletion_status: null, is_minor: true },
      }),
      person({
        user_id: 'c',
        ratio_bp: 1000n,
        current: { risk_state: 'frozen', deletion_status: null, is_minor: true },
      }),
    ],
  });
  expect(plan.beneficiaries.map((p) => [p.action, p.forfeit_reason, p.share_fen])).toEqual([
    ['forfeited', 'deleted', 50n],
    ['forfeited', 'banned', 10n],
    ['forfeited', 'minor', 10n],
  ]);
  expect(plan.platform_credit_fen).toBe(30n);
});

it('[AC-B2-04e#u2] 快照已没收的条目即使标记未完成义务也不计待补记额', () => {
  expect(
    checkCreditInvariant({
      booked_base_fen: 100n,
      booked_n_fen: 100n,
      union_receivable_net_fen: 100n,
      positions: [
        {
          user_id: 'u1',
          role: 'direct',
          ratio_bp: 5000n,
          snapshot_status: 'forfeited',
          net_fen: 0n,
          has_open_obligation: true,
        },
      ],
    }),
  ).toMatchObject({ pending_credit_fen: 0n, valid: true });
});

it('[AC-B2-04e#u3] 未知义务状态、模板或受益人状态是输入错误，不产生资金计划', () => {
  const input = supplemental();
  expect(() =>
    planBeneficiaryCredit({
      ...input,
      obligation: { ...input.obligation, status: 'done' as 'open' },
    }),
  ).toThrow(RangeError);
  expect(() =>
    planBeneficiaryCredit({
      ...input,
      obligation: {
        ...input.obligation,
        kind: 'deferred',
        credit_template: 'CREDIT:SELF' as 'ADJ:DEFERRED:RESTORE',
      },
    }),
  ).toThrow(RangeError);
  expect(() =>
    planBeneficiaryCredit({
      ...input,
      current: { ...normal, risk_state: 'locked' as 'normal' },
    }),
  ).toThrow(RangeError);
});

it('[AC-B2-04e#u4] 首次入账义务补记沿用角色 CREDIT 模板，执行条件先于义务匹配校验', () => {
  const plan = planBeneficiaryCredit(supplemental());
  expect(plan.vouchers.map((v) => [v.template_id, v.params['share_fen']])).toEqual([
    ['CREDIT:DIRECT', 50n],
  ]);
  expect(
    planBeneficiaryCredit(supplemental({ rights_pending: true, positions: [] })),
  ).toMatchObject({ action: 'skipped', skip_reason: 'rights_pending' });
});
