import { planCommissionAdjustment } from '@couli/domain';
import type { AdjustmentBeneficiary } from '@couli/domain';
import { expect, it } from 'vitest';
import { beneficiary, input } from './fixtures.ts';

it.each(['banned', 'frozen', 'appealing'] as const)(
  '[AC-B2-04g#16] BR-CALC-09：%s 负差照扣 available，不能按当前余额限扣',
  (risk_state) => {
    const result = planCommissionAdjustment(
      input({ beneficiaries: [beneficiary({ risk_state })], platform_net_fen: 600n }),
    );
    expect(result.beneficiaries).toMatchObject([
      {
        delta_fen: -160n,
        net_after_fen: 240n,
        posting: 'user_available',
        pending_after_fen: 0n,
        forfeit_fen: 0n,
      },
    ]);
    expect(result.union_receivable_delta_fen).toBe(-400n);
  },
);

it.each(['processing', 'done'] as const)(
  '[AC-B2-04g#17] BR-FUND-08/09：注销 %s 的扣回记坏账并减少该受益人净额',
  (deletion_status) => {
    const first = planCommissionAdjustment(
      input({
        event: 'settlement',
        n_new_fen: 900n,
        beneficiaries: [beneficiary({ deletion_status })],
        platform_net_fen: 600n,
      }),
    );
    expect(first.beneficiaries).toMatchObject([
      { user_id: 'u1', role: 'self', delta_fen: -40n, net_after_fen: 360n, posting: 'bad_debt' },
    ]);
    const second = planCommissionAdjustment(
      input({
        event: 'settlement',
        n_new_fen: 600n,
        ...first.booked_after,
        platform_net_fen: first.platform_after_fen,
        beneficiaries: [
          beneficiary({ deletion_status, net_fen: first.beneficiaries[0]!.net_after_fen }),
        ],
      }),
    );
    expect(second.beneficiaries).toMatchObject([
      { delta_fen: -120n, net_after_fen: 240n, posting: 'bad_debt' },
    ]);
    expect(second.union_receivable_delta_fen).toBe(-300n);
  },
);

it.each([null, 'cooling', 'cancelled'] as const)(
  '[AC-B2-04g#18] BR-CALC-09：正常与注销冷静/撤回 %s 正差照常补给用户',
  (deletion_status) => {
    const result = planCommissionAdjustment(
      input({
        event: 'settlement',
        n_new_fen: 1200n,
        platform_net_fen: 600n,
        beneficiaries: [beneficiary({ deletion_status })],
      }),
    );
    expect(result.route).toBe('approval');
    expect(result.beneficiaries).toMatchObject([
      {
        delta_fen: 80n,
        net_after_fen: 480n,
        posting: 'user_available',
        forfeit_fen: 0n,
        pending_after_fen: 0n,
      },
    ]);
  },
);

const forfeitingStates: readonly {
  state: Partial<AdjustmentBeneficiary>;
  reason: 'banned' | 'deleted';
}[] = [
  { state: { risk_state: 'banned' }, reason: 'banned' },
  { state: { deletion_status: 'processing' }, reason: 'deleted' },
  { state: { deletion_status: 'done' }, reason: 'deleted' },
];

const boundaryStates: readonly {
  label: string;
  state: Partial<AdjustmentBeneficiary>;
  reason: 'banned' | 'deleted' | 'minor';
  negativePosting: 'user_available' | 'bad_debt';
}[] = [
  {
    label: 'banned',
    state: { risk_state: 'banned' },
    reason: 'banned',
    negativePosting: 'user_available',
  },
  {
    label: 'processing',
    state: { deletion_status: 'processing' },
    reason: 'deleted',
    negativePosting: 'bad_debt',
  },
  {
    label: 'done',
    state: { deletion_status: 'done' },
    reason: 'deleted',
    negativePosting: 'bad_debt',
  },
  {
    label: 'minor-share',
    state: { is_minor: true, role: 'share' },
    reason: 'minor',
    negativePosting: 'user_available',
  },
  {
    label: 'minor-direct',
    state: { is_minor: true, role: 'direct' },
    reason: 'minor',
    negativePosting: 'user_available',
  },
  {
    label: 'minor-indirect',
    state: { is_minor: true, role: 'indirect' },
    reason: 'minor',
    negativePosting: 'user_available',
  },
];

// 无预留、快照比例 5000bp：旧基数 1000、用户净额 500、平台净额 500。
// 新基数 998 / 1000 / 1002 手算重拆为 499 / 500 / 501；多出的 1 分归平台。
const entitlementBoundaries = [
  {
    boundary: '等于净额',
    n_new_fen: 1000n,
    entitlement_fen: 500n,
    delta_fen: 0n,
    forfeit_fen: 0n,
    platform_after_fen: 500n,
    platform_delta_fen: 0n,
    union_receivable_delta_fen: 0n,
    route: 'none',
  },
  {
    boundary: '比净额多 1 分',
    n_new_fen: 1002n,
    entitlement_fen: 500n,
    delta_fen: 0n,
    forfeit_fen: 1n,
    platform_after_fen: 502n,
    platform_delta_fen: 2n,
    union_receivable_delta_fen: 2n,
    route: 'approval',
  },
  {
    boundary: '比净额少 1 分',
    n_new_fen: 998n,
    entitlement_fen: 499n,
    delta_fen: -1n,
    forfeit_fen: 0n,
    platform_after_fen: 499n,
    platform_delta_fen: -1n,
    union_receivable_delta_fen: -2n,
    route: 'immediate',
  },
] as const;

it.each(
  boundaryStates.flatMap((state) => entitlementBoundaries.map((row) => ({ ...state, ...row }))),
)(
  '[AC-B2-04g#41] BR-CALC-09：$label 重拆份额$boundary，新应得取较小值',
  ({ state, reason, negativePosting, ...expected }) => {
    const result = planCommissionAdjustment(
      input({
        event: 'settlement',
        reserve_bp: 0n,
        booked_base_fen: 1000n,
        booked_n_fen: 1000n,
        n_new_fen: expected.n_new_fen,
        platform_net_fen: 500n,
        beneficiaries: [beneficiary({ ...state, net_fen: 500n })],
      }),
    );
    expect(result.beneficiaries).toMatchObject([
      {
        entitlement_fen: expected.entitlement_fen,
        delta_fen: expected.delta_fen,
        net_after_fen: expected.entitlement_fen,
        posting: expected.delta_fen < 0n ? negativePosting : null,
        forfeit_fen: expected.forfeit_fen,
        pending_after_fen: 0n,
      },
    ]);
    if (expected.forfeit_fen === 1n) {
      expect(result.beneficiaries[0]!.forfeit_reason).toBe(reason);
    }
    expect(result).toMatchObject({
      route: expected.route,
      platform_after_fen: expected.platform_after_fen,
      platform_delta_fen: expected.platform_delta_fen,
      union_receivable_delta_fen: expected.union_receivable_delta_fen,
    });
  },
);

it.each(forfeitingStates)(
  '[AC-B2-04g#19] BR-CALC-09：$reason 正差归平台不计用户净额，新应得取较小值',
  ({ state, reason }) => {
    const result = planCommissionAdjustment(
      input({
        event: 'settlement',
        n_new_fen: 1200n,
        platform_net_fen: 600n,
        beneficiaries: [beneficiary(state)],
      }),
    );
    expect(result.beneficiaries).toMatchObject([
      {
        entitlement_fen: 400n,
        delta_fen: 0n,
        net_after_fen: 400n,
        posting: null,
        forfeit_fen: 80n,
        forfeit_reason: reason,
        pending_after_fen: 0n,
      },
    ]);
    expect(result).toMatchObject({
      route: 'approval',
      platform_after_fen: 800n,
      platform_delta_fen: 200n,
      union_receivable_delta_fen: 200n,
    });
  },
);

it.each(forfeitingStates)(
  '[AC-B2-04g#20] BR-FUND-09 X-05：$reason 曾没收正差后下调，不补回已归平台份额',
  ({ state }) => {
    const result = planCommissionAdjustment(
      input({
        event: 'settlement',
        reserve_bp: 0n,
        booked_base_fen: 1200n,
        booked_n_fen: 1200n,
        n_new_fen: 1100n,
        platform_net_fen: 700n,
        beneficiaries: [beneficiary({ ...state, net_fen: 500n })],
      }),
    );
    expect(result.beneficiaries).toMatchObject([
      {
        entitlement_fen: 500n,
        delta_fen: 0n,
        net_after_fen: 500n,
        forfeit_fen: 50n,
        posting: null,
      },
    ]);
    expect(result).toMatchObject({
      route: 'immediate',
      platform_after_fen: 600n,
      platform_delta_fen: -100n,
      union_receivable_delta_fen: -100n,
    });
  },
);

it.each(['frozen', 'appealing'] as const)(
  '[AC-B2-04g#21] BR-CALC-09：%s 正差延后，只确认其余平台差额',
  (risk_state) => {
    const result = planCommissionAdjustment(
      input({
        event: 'settlement',
        n_new_fen: 1200n,
        platform_net_fen: 600n,
        beneficiaries: [beneficiary({ risk_state })],
      }),
    );
    expect(result.beneficiaries).toMatchObject([
      {
        delta_fen: 0n,
        net_after_fen: 400n,
        posting: null,
        forfeit_fen: 0n,
        pending_before_fen: 0n,
        pending_after_fen: 80n,
        obligation_action: 'open',
      },
    ]);
    expect(result).toMatchObject({
      route: 'approval',
      platform_delta_fen: 120n,
      union_receivable_delta_fen: 120n,
    });
  },
);

it.each(['share', 'direct', 'indirect'] as const)(
  '[AC-B2-04g#22] BR-CALC-09：未成年推广角色 %s 正差没收、负差照扣',
  (role) => {
    const positive = planCommissionAdjustment(
      input({
        event: 'settlement',
        n_new_fen: 1200n,
        platform_net_fen: 600n,
        beneficiaries: [beneficiary({ role, is_minor: true })],
      }),
    );
    expect(positive.beneficiaries).toMatchObject([
      {
        delta_fen: 0n,
        net_after_fen: 400n,
        forfeit_fen: 80n,
        forfeit_reason: 'minor',
        posting: null,
      },
    ]);
    expect(positive.platform_after_fen).toBe(800n);
    const negative = planCommissionAdjustment(
      input({ platform_net_fen: 600n, beneficiaries: [beneficiary({ role, is_minor: true })] }),
    );
    expect(negative.beneficiaries).toMatchObject([
      { delta_fen: -160n, net_after_fen: 240n, posting: 'user_available', forfeit_fen: 0n },
    ]);
  },
);

it('[AC-B2-04g#23] BR-CALC-09：同一未成年用户的 self 与 direct 分别处理，不按 uid 合并', () => {
  const result = planCommissionAdjustment(
    input({
      event: 'settlement',
      n_new_fen: 1200n,
      beneficiaries: [
        beneficiary({ is_minor: true }),
        beneficiary({ is_minor: true, role: 'direct', ratio_bp: 1000n, net_fen: 80n }),
      ],
    }),
  );
  expect(result.beneficiaries).toMatchObject([
    { user_id: 'u1', role: 'self', delta_fen: 80n, net_after_fen: 480n, forfeit_fen: 0n },
    {
      user_id: 'u1',
      role: 'direct',
      delta_fen: 0n,
      net_after_fen: 80n,
      forfeit_fen: 16n,
      forfeit_reason: 'minor',
    },
  ]);
  expect(result.union_receivable_delta_fen).toBe(200n);
});

it.each([600n, 1200n])(
  '[AC-B2-04g#24] BR-CALC-09：forfeited 恒为零，不因正常状态或新佣金 %s 复活',
  (n_new_fen) => {
    const result = planCommissionAdjustment(
      input({
        event: 'settlement',
        n_new_fen,
        platform_net_fen: 1000n,
        beneficiaries: [beneficiary({ status: 'forfeited', net_fen: 0n })],
      }),
    );
    expect(result.beneficiaries).toMatchObject([
      {
        entitlement_fen: 0n,
        delta_fen: 0n,
        net_after_fen: 0n,
        posting: null,
        forfeit_fen: 0n,
        pending_after_fen: 0n,
      },
    ]);
    expect(result.platform_after_fen).toBe(n_new_fen);
  },
);

it('[AC-B2-04g#25] BR-FUND-08 X-01：申诉恢复的当前 active 净额参与再次全扣', () => {
  const result = planCommissionAdjustment(
    input({
      n_new_fen: 0n,
      reserve_bp: 0n,
      booked_base_fen: 1000n,
      platform_net_fen: 500n,
      beneficiaries: [beneficiary({ status: 'active', net_fen: 500n })],
    }),
  );
  expect(result.beneficiaries).toMatchObject([
    { delta_fen: -500n, net_after_fen: 0n, posting: 'user_available' },
  ]);
  expect(result).toMatchObject({ platform_delta_fen: -500n, union_receivable_delta_fen: -1000n });
});

it('[AC-B2-04g#26] BR-FUND-08：从未入用户账户的已没收份额不产生注销坏账', () => {
  const result = planCommissionAdjustment(
    input({
      n_new_fen: 0n,
      platform_net_fen: 1000n,
      beneficiaries: [beneficiary({ status: 'forfeited', net_fen: 0n, deletion_status: 'done' })],
    }),
  );
  expect(result.beneficiaries).toMatchObject([{ delta_fen: 0n, posting: null }]);
  expect(result.platform_delta_fen).toBe(-1000n);
});
