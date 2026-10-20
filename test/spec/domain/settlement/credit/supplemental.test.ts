import {
  planBeneficiaryCredit,
  planInitialCredit,
  type BeneficiaryCreditInput,
  type CreditObligation,
  type CreditBeneficiaryState,
} from '@couli/domain';
import { expect, it } from 'vitest';
import {
  deepFreeze,
  initial,
  materialize,
  normal,
  person,
  position,
  supplemental,
} from './fixtures.ts';

it('[AC-B2-04e#46] BR-FUND-04⑫ 义务必须匹配同用户同角色的未完成净额条目，不能套用别人的欠额', () => {
  const input = supplemental();
  expect(() => planBeneficiaryCredit({ ...input, positions: [] })).toThrow(RangeError);
  expect(() =>
    planBeneficiaryCredit({ ...input, positions: [position({ user_id: 'other' })] }),
  ).toThrow(RangeError);
  expect(() =>
    planBeneficiaryCredit({ ...input, positions: [position({ role: 'direct' })] }),
  ).toThrow(RangeError);
  expect(() =>
    planBeneficiaryCredit({
      ...input,
      positions: [position({ has_open_obligation: false })],
      union_receivable_net_fen: 1200n,
    }),
  ).toThrow(RangeError);
});

it('[AC-B2-04e#30] BR-FUND-04⑫ 延后差额只补剩余80，模板以义务ID为键，不追加forfeited事件', () => {
  const plan = planBeneficiaryCredit(supplemental());
  expect(plan).toEqual({
    beneficiary_credit_id: 'obligation-1',
    action: 'credit',
    remaining_fen: 80n,
    obligation_action: 'complete',
    append_forfeited_event: false,
    forfeit_reason: null,
    alert: false,
    skip_reason: null,
    vouchers: [
      {
        template_id: 'ADJ:DEFERRED:SETTLE_DIFF',
        params: {
          order_key: 'taobao:1234567',
          platform: 'taobao',
          user_id: 'u-self',
          role: 'self',
          beneficiary_credit_id: 'obligation-1',
          pending_credit_fen: 80n,
        },
        forfeit_reason: null,
      },
    ],
  });
  const vouchers = materialize(plan.vouchers);
  expect(vouchers).toHaveLength(1);
  expect(vouchers[0]).toMatchObject({
    uniq_key: 'taobao:1234567:u-self:self:ADJ:DEFERRED:obligation-1',
    entries: [
      { account: { subject: 'UNION_RECEIVABLE:taobao' }, amount_fen: 80n },
      { account: { owner_id: 'u-self', subject: 'USER_BALANCE' }, amount_fen: -80n },
    ],
  });
});

it('[AC-B2-04e#31] BR-FUND-04⑫ 首次暂缓义务按执行时B=720补360，沿用首次CREDIT键', () => {
  const input = supplemental({
    booked_base_fen: 720n,
    booked_n_fen: 900n,
    union_receivable_net_fen: 540n,
    positions: [position({ net_fen: 0n })],
    obligation: { ...supplemental().obligation, kind: 'initial' },
  });
  const plan = planBeneficiaryCredit(input);
  expect(plan).toMatchObject({
    action: 'credit',
    remaining_fen: 360n,
    obligation_action: 'complete',
    append_forfeited_event: false,
    alert: false,
  });
  expect(plan.vouchers).toEqual([
    {
      template_id: 'CREDIT:SELF',
      params: {
        order_key: 'taobao:1234567',
        platform: 'taobao',
        user_id: 'u-self',
        role: 'self',
        share_fen: 360n,
      },
      forfeit_reason: null,
    },
  ]);
  expect(materialize(plan.vouchers)[0]?.uniq_key).toBe('taobao:1234567:u-self:self:CREDIT');
});

// B=960、比例5000bp，应得480；首次净额0欠480，延后差额净额400欠80。
// 两种输入均满足⑤：720=1200-480；1120=1200-80。
const obligationCases = [
  { kind: 'initial', net_fen: 0n, remaining_fen: 480n, receivable_fen: 720n, revenue_fen: -480n },
  { kind: 'deferred', net_fen: 400n, remaining_fen: 80n, receivable_fen: 1120n, revenue_fen: -80n },
] as const;

const forfeits: readonly { state: Partial<CreditBeneficiaryState>; reason: string }[] = [
  { state: { risk_state: 'banned' }, reason: 'banned' },
  { state: { deletion_status: 'processing' }, reason: 'deleted' },
  { state: { deletion_status: 'done' }, reason: 'deleted' },
];
it.each(obligationCases.flatMap((item) => forfeits.map((entry) => ({ ...item, ...entry }))))(
  '[AC-B2-04e#32] BR-FUND-04⑫ $kind义务$state只没收剩余$remaining_fen，不动已入账净额',
  ({ kind, net_fen, remaining_fen, receivable_fen, revenue_fen, state, reason }) => {
    const input = supplemental();
    const plan = planBeneficiaryCredit({
      ...input,
      union_receivable_net_fen: receivable_fen,
      positions: [position({ net_fen })],
      obligation: kind === 'initial' ? { ...input.obligation, kind } : input.obligation,
      current: { ...normal, ...state },
    });
    expect(plan).toMatchObject({
      action: 'forfeited',
      remaining_fen,
      obligation_action: 'forfeit',
      append_forfeited_event: kind === 'initial',
      forfeit_reason: reason,
      alert: false,
      skip_reason: null,
    });
    expect(plan.vouchers).toEqual([
      {
        template_id: kind === 'initial' ? 'FORFEIT' : 'FORFEIT:DEFERRED',
        params: {
          order_key: 'taobao:1234567',
          platform: 'taobao',
          uid: 'u-self',
          role: 'self',
          ...(kind === 'initial'
            ? { share_fen: 480n }
            : { beneficiary_credit_id: 'obligation-1', pending_credit_fen: 80n }),
        },
        forfeit_reason: reason,
      },
    ]);
    expect(materialize(plan.vouchers)[0]).toMatchObject({
      uniq_key:
        kind === 'initial'
          ? 'taobao:1234567:PLATFORM:FORFEIT:u-self:self'
          : 'taobao:1234567:PLATFORM:FORFEIT:u-self:self:DEFERRED:obligation-1',
      entries: [
        { account: { subject: 'UNION_RECEIVABLE:taobao' }, amount_fen: remaining_fen },
        { account: { subject: 'COMMISSION_REVENUE' }, amount_fen: revenue_fen },
      ],
    });
  },
);

it('[AC-B2-04e#33] BR-CALC-13 首次义务转没收追加事件，与R5共用FORFEIT键', () => {
  const input = supplemental({
    booked_base_fen: 800n,
    booked_n_fen: 1000n,
    union_receivable_net_fen: 600n,
    positions: [position({ net_fen: 0n })],
    current: { ...normal, risk_state: 'banned' },
    obligation: { ...supplemental().obligation, kind: 'initial' },
  });
  const plan = planBeneficiaryCredit(input);
  expect(plan).toMatchObject({
    action: 'forfeited',
    remaining_fen: 400n,
    obligation_action: 'forfeit',
    append_forfeited_event: true,
    forfeit_reason: 'banned',
  });
  expect(plan.vouchers[0]).toEqual({
    template_id: 'FORFEIT',
    params: {
      order_key: 'taobao:1234567',
      platform: 'taobao',
      uid: 'u-self',
      role: 'self',
      share_fen: 400n,
    },
    forfeit_reason: 'banned',
  });
  const first = planInitialCredit(
    initial({ beneficiaries: [person('self', 5000n, { risk_state: 'banned' })] }),
  );
  expect(materialize(plan.vouchers)[0]?.uniq_key).toBe(materialize(first.vouchers)[0]?.uniq_key);
});

it.each(
  obligationCases.flatMap((item) =>
    (['frozen', 'appealing'] as const).map((risk_state) => ({ ...item, risk_state })),
  ),
)(
  '[AC-B2-04e#34] BR-FUND-04⑫ $kind义务仍$risk_state保持原义务与待补记额，不自动入账/没收',
  ({ kind, net_fen, remaining_fen, receivable_fen, risk_state }) => {
    const input = supplemental();
    const plan = planBeneficiaryCredit({
      ...input,
      union_receivable_net_fen: receivable_fen,
      positions: [position({ net_fen })],
      obligation: kind === 'initial' ? { ...input.obligation, kind } : input.obligation,
      current: { ...normal, risk_state },
    });
    expect(plan).toEqual({
      beneficiary_credit_id: 'obligation-1',
      action: 'deferred',
      remaining_fen,
      obligation_action: 'keep',
      append_forfeited_event: false,
      forfeit_reason: null,
      alert: false,
      skip_reason: null,
      vouchers: [],
    });
  },
);

it.each(['cooling', 'cancelled'] as const)(
  '[AC-B2-04e#35] BR-FUND-04⑫ 注销%s可以补记',
  (deletion_status) => {
    expect(
      planBeneficiaryCredit(supplemental({ current: { ...normal, deletion_status } })),
    ).toMatchObject({ action: 'credit', remaining_fen: 80n, obligation_action: 'complete' });
  },
);

it.each(
  obligationCases.flatMap((item) =>
    (['self', 'share', 'direct', 'indirect'] as const).map((role) => ({ ...item, role })),
  ),
)(
  '[AC-B2-04e#36] BR-CALC-13 未成年人$kind义务补记$role只没收推广欠额，不动既有净额',
  ({ kind, net_fen, remaining_fen, receivable_fen, revenue_fen, role }) => {
    const input = supplemental();
    const plan = planBeneficiaryCredit({
      ...input,
      union_receivable_net_fen: receivable_fen,
      positions: [position({ role, net_fen })],
      obligation:
        kind === 'initial' ? { ...input.obligation, kind, role } : { ...input.obligation, role },
      current: { ...normal, is_minor: true },
    });
    expect(plan).toMatchObject({
      action: role === 'self' ? 'credit' : 'forfeited',
      remaining_fen,
      obligation_action: role === 'self' ? 'complete' : 'forfeit',
      append_forfeited_event: kind === 'initial' && role !== 'self',
      forfeit_reason: role === 'self' ? null : 'minor',
      alert: false,
      skip_reason: null,
    });
    expect(plan.vouchers).toEqual([
      {
        template_id:
          role === 'self'
            ? kind === 'initial'
              ? 'CREDIT:SELF'
              : 'ADJ:DEFERRED:SETTLE_DIFF'
            : kind === 'initial'
              ? 'FORFEIT'
              : 'FORFEIT:DEFERRED',
        params: {
          order_key: 'taobao:1234567',
          platform: 'taobao',
          ...(role === 'self' ? { user_id: 'u-self' } : { uid: 'u-self' }),
          role,
          ...(kind === 'initial'
            ? { share_fen: 480n }
            : { beneficiary_credit_id: 'obligation-1', pending_credit_fen: 80n }),
        },
        forfeit_reason: role === 'self' ? null : 'minor',
      },
    ]);
    expect(materialize(plan.vouchers)[0]).toMatchObject({
      uniq_key:
        role === 'self'
          ? kind === 'initial'
            ? 'taobao:1234567:u-self:self:CREDIT'
            : 'taobao:1234567:u-self:self:ADJ:DEFERRED:obligation-1'
          : kind === 'initial'
            ? `taobao:1234567:PLATFORM:FORFEIT:u-self:${role}`
            : `taobao:1234567:PLATFORM:FORFEIT:u-self:${role}:DEFERRED:obligation-1`,
      entries: [
        { account: { subject: 'UNION_RECEIVABLE:taobao' }, amount_fen: remaining_fen },
        {
          account:
            role === 'self'
              ? { owner_id: 'u-self', subject: 'USER_BALANCE' }
              : { subject: 'COMMISSION_REVENUE' },
          amount_fen: revenue_fen,
        },
      ],
    });
  },
);

it.each([
  { kind: 'initial', net_fen: 0n, booked_base_fen: 0n, booked_n_fen: 0n },
  { kind: 'deferred', net_fen: 480n, booked_base_fen: 960n, booked_n_fen: 1200n },
  { kind: 'deferred', net_fen: 500n, booked_base_fen: 960n, booked_n_fen: 1200n },
] as const)(
  '[AC-B2-04e#37] BR-FUND-04⑫ $kind义务当前净额$net_fen不少于应得，零金额不写凭证但义务完成',
  ({ kind, net_fen, booked_base_fen, booked_n_fen }) => {
    const input = supplemental();
    const plan = planBeneficiaryCredit({
      ...input,
      booked_base_fen,
      booked_n_fen,
      union_receivable_net_fen: booked_n_fen,
      positions: [position({ net_fen })],
      obligation: kind === 'initial' ? { ...input.obligation, kind } : input.obligation,
    });
    expect(plan).toMatchObject({
      action: 'credit',
      remaining_fen: 0n,
      obligation_action: 'complete',
      append_forfeited_event: false,
      forfeit_reason: null,
      vouchers: [],
      alert: false,
      skip_reason: null,
    });
  },
);

it.each(['initial', 'deferred'] as const)(
  '[AC-B2-04e#38] BR-FUND-04⑫ %s义务零金额失效也关闭为没收，不写凭证',
  (kind) => {
    const input = supplemental();
    const obligation: CreditObligation =
      kind === 'initial' ? { ...input.obligation, kind } : input.obligation;
    const plan = planBeneficiaryCredit({
      ...input,
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      union_receivable_net_fen: 0n,
      positions: [position({ net_fen: 0n })],
      obligation,
      current: { ...normal, risk_state: 'banned' },
    });
    expect(plan).toMatchObject({
      action: 'forfeited',
      remaining_fen: 0n,
      obligation_action: 'forfeit',
      forfeit_reason: 'banned',
      append_forfeited_event: kind === 'initial',
      vouchers: [],
    });
  },
);

const gates: readonly { patch: Partial<BeneficiaryCreditInput>; reason: string }[] = [
  { patch: { rebate_status: 'WAITING' }, reason: 'order_not_credited' },
  { patch: { rebate_status: 'CLAWED_BACK' }, reason: 'order_not_credited' },
  { patch: { rebate_status: 'VOID' }, reason: 'order_not_credited' },
  { patch: { rebate_status: 'ESTIMATED' }, reason: 'order_not_credited' },
  { patch: { rights_pending: true }, reason: 'rights_pending' },
  { patch: { settlement_seq: 8n }, reason: 'settlement_changed' },
  { patch: { snapshot_id: 'snapshot-2' }, reason: 'snapshot_changed' },
];
it.each(gates)(
  '[AC-B2-04e#39] BR-FUND-04⑫ 执行条件变为$reason跳过，不处置义务',
  ({ patch, reason }) => {
    expect(planBeneficiaryCredit(supplemental(patch))).toEqual({
      beneficiary_credit_id: 'obligation-1',
      action: 'skipped',
      remaining_fen: 0n,
      obligation_action: 'keep',
      append_forfeited_event: false,
      forfeit_reason: null,
      alert: false,
      skip_reason: reason,
      vouchers: [],
    });
  },
);

it.each(['completed', 'forfeited', 'voided'] as const)(
  '[AC-B2-04e#40] BR-FUND-04⑫ 义务%s后旧批次不可重复补记/没收',
  (status) => {
    const input = supplemental();
    expect(
      planBeneficiaryCredit({
        ...input,
        obligation: { ...input.obligation, status },
        positions: [position({ has_open_obligation: false })],
        union_receivable_net_fen: 1200n,
      }),
    ).toMatchObject({
      action: 'skipped',
      skip_reason: 'obligation_closed',
      obligation_action: 'keep',
      append_forfeited_event: false,
      vouchers: [],
      alert: false,
    });
  },
);

it.each(['normal', 'banned', 'frozen'] as const)(
  '[AC-B2-04e#41] BR-FUND-04⑫ 份额已归平台却未关闭义务，⑤失败时%s也不能再处置',
  (risk_state) => {
    // 应收已1200（份额已处置），但义务仍开、按净额尚欠80：⑤期望1120。
    expect(
      planBeneficiaryCredit(
        supplemental({ union_receivable_net_fen: 1200n, current: { ...normal, risk_state } }),
      ),
    ).toEqual({
      beneficiary_credit_id: 'obligation-1',
      action: 'skipped',
      remaining_fen: 0n,
      obligation_action: 'keep',
      append_forfeited_event: false,
      forfeit_reason: null,
      alert: true,
      skip_reason: 'invariant_mismatch',
      vouchers: [],
    });
  },
);

it('[AC-B2-04e#42] BR-FUND-19⑤ 用户净额合计越过B，补记即使为零也跳过告警', () => {
  expect(
    planBeneficiaryCredit(
      supplemental({ union_receivable_net_fen: 1200n, positions: [position({ net_fen: 961n })] }),
    ),
  ).toMatchObject({
    action: 'skipped',
    skip_reason: 'invariant_mismatch',
    alert: true,
    obligation_action: 'keep',
    vouchers: [],
  });
});

it('[AC-B2-04e#43] BR-FUND-04⑫ 多义务按整单⑤验算，只为目标用户角色补记，不串到另一角色', () => {
  const input = supplemental({
    union_receivable_net_fen: 1024n,
    positions: [position(), position({ role: 'direct', ratio_bp: 1000n, net_fen: 0n })],
  });
  const plan = planBeneficiaryCredit(input);
  expect(plan).toMatchObject({
    action: 'credit',
    remaining_fen: 80n,
    obligation_action: 'complete',
    alert: false,
  });
  expect(materialize(plan.vouchers).map((v) => v.uniq_key)).toEqual([
    'taobao:1234567:u-self:self:ADJ:DEFERRED:obligation-1',
  ]);
  // 只扣目标80来核对会错放：另一个角色还欠96。
  expect(planBeneficiaryCredit({ ...input, union_receivable_net_fen: 1120n })).toMatchObject({
    action: 'skipped',
    alert: true,
    vouchers: [],
  });
});

it.each([
  'ADJ:DEFERRED:SETTLE_DIFF',
  'ADJ:DEFERRED:PRICE_COMPARE',
  'ADJ:DEFERRED:PRICE_PROTECT',
  'ADJ:DEFERRED:RESTORE',
] as const)('[AC-B2-04e#44] 补记输出沿用开立模板%s，可交buildVouchers', (credit_template) => {
  const input = supplemental();
  const plan = planBeneficiaryCredit({
    ...input,
    obligation: { ...input.obligation, kind: 'deferred', credit_template },
  });
  expect(plan.vouchers[0]?.template_id).toBe(credit_template);
  expect(materialize(plan.vouchers)[0]?.entries[1]).toMatchObject({
    amount_fen: -80n,
    ledger_type: credit_template.endsWith('RESTORE') ? 'ADMIN_ADJUST' : 'SETTLE_ADJUST',
    sub_type: credit_template.split(':')[2],
  });
});

it('[AC-B2-04e#45] BR-FUND-04⑫ 重试稳定、后续新义务使用新ID，输入快照不变', () => {
  const input = deepFreeze(supplemental());
  const before = structuredClone(input);
  const plan = planBeneficiaryCredit(input);
  expect(planBeneficiaryCredit(input)).toEqual(plan);
  expect(input).toEqual(before);
  const next = planBeneficiaryCredit({
    ...input,
    obligation: { ...input.obligation, beneficiary_credit_id: 'obligation-2' },
  });
  expect(materialize(next.vouchers)[0]?.uniq_key).toBe(
    'taobao:1234567:u-self:self:ADJ:DEFERRED:obligation-2',
  );
  expect(materialize(next.vouchers)[0]?.uniq_key).not.toBe(materialize(plan.vouchers)[0]?.uniq_key);
});
