import { planInitialCredit, type CreditBeneficiaryState, type LedgerRole } from '@couli/domain';
import { InvalidAmount, InvalidRatio } from '@couli/money';
import { expect, it } from 'vitest';
import { deepFreeze, initial, materialize, person } from './fixtures.ts';

it('[AC-B2-04e#15] BR-FUND-05 全部份额归用户且无预留，不输出零平台凭证', () => {
  const plan = planInitialCredit(
    initial({ b_credit_fen: 19n, reserve_fen: 0n, beneficiaries: [person('self', 10000n)] }),
  );
  expect(plan.platform_credit_fen).toBe(0n);
  expect(plan.vouchers.map((v) => v.template_id)).toEqual(['CREDIT:SELF']);
  expect(materialize(plan.vouchers)[0]?.entries[1]?.amount_fen).toBe(-19n);
});

it('[AC-B2-04e#16] BR-FUND-05 全部受益人暂缓仍记基础平台留存和预留', () => {
  const plan = planInitialCredit(
    initial({
      beneficiaries: [
        person('self', 5000n, { risk_state: 'frozen' }),
        person('direct', 1000n, { risk_state: 'appealing' }),
      ],
    }),
  );
  expect(plan.beneficiaries.map((p) => [p.action, p.open_initial_obligation])).toEqual([
    ['held', true],
    ['held', true],
  ]);
  expect(plan.vouchers).toEqual([
    {
      template_id: 'CREDIT:PLATFORM',
      params: { order_key: 'taobao:1234567', platform: 'taobao', platform_credit_fen: 520n },
      forfeit_reason: null,
    },
  ]);
});

it('[AC-B2-04e#1] BR-FUND-05 以入账B重拆，逐份向下取整，预留仅加到平台凭证', () => {
  const plan = planInitialCredit(initial({ b_credit_fen: 935n, reserve_fen: 165n }));
  expect(plan.beneficiaries).toEqual([
    {
      user_id: 'u-self',
      role: 'self',
      share_fen: 467n,
      action: 'credit',
      forfeit_reason: null,
      append_forfeited_event: false,
      open_initial_obligation: false,
    },
    {
      user_id: 'u-direct',
      role: 'direct',
      share_fen: 93n,
      action: 'credit',
      forfeit_reason: null,
      append_forfeited_event: false,
      open_initial_obligation: false,
    },
  ]);
  expect(plan).toMatchObject({
    platform_retain_fen: 375n,
    reserve_fen: 165n,
    platform_credit_fen: 540n,
  });
  expect(plan.vouchers).toEqual([
    {
      template_id: 'CREDIT:SELF',
      params: {
        order_key: 'taobao:1234567',
        platform: 'taobao',
        user_id: 'u-self',
        role: 'self',
        share_fen: 467n,
      },
      forfeit_reason: null,
    },
    {
      template_id: 'CREDIT:DIRECT',
      params: {
        order_key: 'taobao:1234567',
        platform: 'taobao',
        user_id: 'u-direct',
        role: 'direct',
        share_fen: 93n,
      },
      forfeit_reason: null,
    },
    {
      template_id: 'CREDIT:PLATFORM',
      params: { order_key: 'taobao:1234567', platform: 'taobao', platform_credit_fen: 540n },
      forfeit_reason: null,
    },
  ]);
  expect(materialize(plan.vouchers).map((v) => v.uniq_key)).toEqual([
    'taobao:1234567:u-self:self:CREDIT',
    'taobao:1234567:u-direct:direct:CREDIT',
    'taobao:1234567:PLATFORM:CREDIT',
  ]);
});

it.each(['frozen', 'appealing'] as const)(
  '[AC-B2-04e#2] BR-FUND-04⑩ %s 只暂缓本人并开义务，上级同批照常入账',
  (risk_state) => {
    const plan = planInitialCredit(
      initial({ beneficiaries: [person('self', 5000n, { risk_state }), person('direct', 1000n)] }),
    );
    expect(plan.beneficiaries).toMatchObject([
      {
        share_fen: 400n,
        action: 'held',
        open_initial_obligation: true,
        append_forfeited_event: false,
      },
      { share_fen: 80n, action: 'credit', open_initial_obligation: false },
    ]);
    expect(plan.platform_credit_fen).toBe(520n);
    expect(materialize(plan.vouchers).map((v) => v.uniq_key)).toEqual([
      'taobao:1234567:u-direct:direct:CREDIT',
      'taobao:1234567:PLATFORM:CREDIT',
    ]);
  },
);

const invalidStates: readonly { state: Partial<CreditBeneficiaryState>; reason: string }[] = [
  { state: { risk_state: 'banned' }, reason: 'banned' },
  { state: { deletion_status: 'processing' }, reason: 'deleted' },
  { state: { deletion_status: 'done' }, reason: 'deleted' },
];
it.each(invalidStates)(
  '[AC-B2-04e#3] BR-CALC-13 执行时失效 $state 独立没收，不重复计入平台CREDIT',
  ({ state, reason }) => {
    const plan = planInitialCredit(
      initial({ beneficiaries: [person('self', 5000n, state), person('direct', 1000n)] }),
    );
    expect(plan.beneficiaries[0]).toMatchObject({
      share_fen: 400n,
      action: 'forfeited',
      forfeit_reason: reason,
      append_forfeited_event: true,
      open_initial_obligation: false,
    });
    expect(plan.platform_credit_fen).toBe(520n);
    expect(plan.vouchers.find((v) => v.template_id === 'FORFEIT')).toEqual({
      template_id: 'FORFEIT',
      params: {
        order_key: 'taobao:1234567',
        platform: 'taobao',
        uid: 'u-self',
        role: 'self',
        share_fen: 400n,
      },
      forfeit_reason: reason,
    });
    const vouchers = materialize(plan.vouchers);
    expect(vouchers.map((v) => v.uniq_key)).toEqual([
      'taobao:1234567:PLATFORM:FORFEIT:u-self:self',
      'taobao:1234567:u-direct:direct:CREDIT',
      'taobao:1234567:PLATFORM:CREDIT',
    ]);
    expect(vouchers[0]?.entries).toMatchObject([
      { account: { subject: 'UNION_RECEIVABLE:taobao' }, amount_fen: 400n },
      { account: { subject: 'COMMISSION_REVENUE' }, amount_fen: -400n },
    ]);
  },
);

it('[AC-B2-04e#4] BR-CALC-13 快照已没收终局不变，直推份额不转给间推', () => {
  const plan = planInitialCredit(
    initial({
      b_credit_fen: 1234n,
      reserve_fen: 0n,
      beneficiaries: [
        person('self', 5000n),
        { ...person('direct', 1000n), snapshot_status: 'forfeited' },
        person('indirect', 500n),
      ],
    }),
  );
  expect(plan.beneficiaries).toMatchObject([
    { share_fen: 617n, action: 'credit' },
    {
      share_fen: 0n,
      action: 'forfeited',
      append_forfeited_event: false,
      open_initial_obligation: false,
    },
    { share_fen: 61n, action: 'credit' },
  ]);
  expect(plan.platform_credit_fen).toBe(556n);
  expect(plan.vouchers.map((v) => v.template_id)).toEqual([
    'CREDIT:SELF',
    'CREDIT:INDIRECT',
    'CREDIT:PLATFORM',
  ]);
});

it('[AC-B2-04e#5] BR-CALC-13 直推执行时封禁不影响间推独立入账', () => {
  const plan = planInitialCredit(
    initial({
      beneficiaries: [
        person('self', 5000n),
        person('direct', 1000n, { risk_state: 'banned' }),
        person('indirect', 500n),
      ],
    }),
  );
  expect(plan.beneficiaries.map((p) => [p.role, p.share_fen, p.action])).toEqual([
    ['self', 400n, 'credit'],
    ['direct', 80n, 'forfeited'],
    ['indirect', 40n, 'credit'],
  ]);
  expect(plan.platform_credit_fen).toBe(480n);
  expect(plan.vouchers.map((v) => v.template_id)).toEqual([
    'CREDIT:SELF',
    'FORFEIT',
    'CREDIT:INDIRECT',
    'CREDIT:PLATFORM',
  ]);
});

it.each(['self', 'share', 'direct', 'indirect'] as const)(
  '[AC-B2-04e#6] BR-CALC-13 未成年人%s角色仅推广份额没收',
  (role) => {
    const plan = planInitialCredit(
      initial({ beneficiaries: [person(role, 5000n, { is_minor: true })] }),
    );
    expect(plan.beneficiaries[0]).toMatchObject({
      share_fen: 400n,
      action: role === 'self' ? 'credit' : 'forfeited',
      forfeit_reason: role === 'self' ? null : 'minor',
      append_forfeited_event: role !== 'self',
    });
    expect(plan.vouchers.map((v) => v.template_id)).toEqual([
      role === 'self' ? 'CREDIT:SELF' : 'FORFEIT',
      'CREDIT:PLATFORM',
    ]);
  },
);

it.each(['cooling', 'cancelled'] as const)(
  '[AC-B2-04e#7] BR-CALC-13 注销%s仍按正常状态入账',
  (deletion_status) => {
    const plan = planInitialCredit(
      initial({ beneficiaries: [person('share', 5000n, { deletion_status })] }),
    );
    expect(plan.beneficiaries[0]).toMatchObject({ action: 'credit', share_fen: 400n });
    expect(materialize(plan.vouchers)[0]?.entries[1]).toMatchObject({
      ledger_type: 'SHARE_CREDIT',
      amount_fen: -400n,
    });
  },
);

it.each([0n, 1n, 1000n])(
  '[AC-B2-04e#8] BR-FUND-05 B为0而预留%s独立入账，零份额不开义务/凭证',
  (reserve_fen) => {
    const plan = planInitialCredit(
      initial({
        b_credit_fen: 0n,
        reserve_fen,
        beneficiaries: [
          person('self', 5000n, { risk_state: 'frozen' }),
          person('direct', 1000n, { risk_state: 'banned' }),
        ],
      }),
    );
    expect(plan.beneficiaries.every((p) => p.share_fen === 0n && !p.open_initial_obligation)).toBe(
      true,
    );
    expect(plan.platform_credit_fen).toBe(reserve_fen);
    expect(plan.vouchers.map((v) => v.template_id)).toEqual(
      reserve_fen === 0n ? [] : ['CREDIT:PLATFORM'],
    );
    expect(materialize(plan.vouchers)).toHaveLength(reserve_fen === 0n ? 0 : 1);
  },
);

it('[AC-B2-04e#9] BR-CALC-04 缺少上级全部留平台；小额分别floor，零用户份额不输出模板', () => {
  const plan = planInitialCredit(
    initial({ b_credit_fen: 1n, reserve_fen: 0n, beneficiaries: [person('self', 5000n)] }),
  );
  expect(plan.beneficiaries[0]?.share_fen).toBe(0n);
  expect(plan.platform_credit_fen).toBe(1n);
  expect(plan.vouchers.map((v) => v.template_id)).toEqual(['CREDIT:PLATFORM']);
});

it('[AC-B2-04e#10] BR-FUND-05 重放同输入同键、跨平台同号不同键、输入不变', () => {
  const input = deepFreeze(initial());
  const before = structuredClone(input);
  const first = planInitialCredit(input);
  expect(planInitialCredit(input)).toEqual(first);
  expect(input).toEqual(before);
  const firstKeys = materialize(first.vouchers).map((v) => v.uniq_key);
  const otherKeys = materialize(planInitialCredit({ ...input, platform: 'jd' }).vouchers).map(
    (v) => v.uniq_key,
  );
  expect(otherKeys).toEqual([
    'jd:1234567:u-self:self:CREDIT',
    'jd:1234567:u-direct:direct:CREDIT',
    'jd:1234567:PLATFORM:CREDIT',
  ]);
  expect(otherKeys.some((k) => firstKeys.includes(k))).toBe(false);
});

it('[AC-B2-04e#11] BR-FUND-05 防止同受益人同角色重复产出入账或义务', () => {
  const duplicate = person('self', 3000n);
  expect(() => planInitialCredit(initial({ beneficiaries: [duplicate, duplicate] }))).toThrow(
    RangeError,
  );
});

it.each(['self', 'share', 'direct', 'indirect'] satisfies LedgerRole[])(
  '[AC-B2-04e#12] BR-FUND-05 %s 正常入账模板可直接构建',
  (role) => {
    const plan = planInitialCredit(initial({ beneficiaries: [person(role, 5000n)] }));
    expect(plan.vouchers[0]?.template_id).toBe(`CREDIT:${role.toUpperCase()}`);
    expect(materialize(plan.vouchers)[0]?.uniq_key).toBe(`taobao:1234567:u-${role}:${role}:CREDIT`);
  },
);

it('[AC-B2-04e#13] 金额大于JS安全整数仍精确重拆', () => {
  const plan = planInitialCredit(
    initial({
      b_credit_fen: 9007199254740993n,
      reserve_fen: 0n,
      beneficiaries: [person('self', 5000n)],
    }),
  );
  expect(plan.beneficiaries[0]?.share_fen).toBe(4503599627370496n);
  expect(plan.platform_credit_fen).toBe(4503599627370497n);
});

it('[AC-B2-04e#14] 拒绝负基数/负预留/越界比例，不能以错误输入生成资金计划', () => {
  expect(() => planInitialCredit(initial({ b_credit_fen: -1n }))).toThrow(InvalidAmount);
  expect(() => planInitialCredit(initial({ reserve_fen: -1n }))).toThrow(InvalidAmount);
  expect(() => planInitialCredit(initial({ beneficiaries: [person('self', 10001n)] }))).toThrow(
    InvalidRatio,
  );
  expect(() =>
    planInitialCredit(initial({ beneficiaries: [person('self', 6000n), person('direct', 5000n)] })),
  ).toThrow(InvalidRatio);
});
