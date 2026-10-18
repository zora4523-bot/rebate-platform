import { expect, it } from 'vitest';
import { planOrderUpdate } from '../../../../apps/api/src/modules/orders/index.ts';
import { at, order, RECEIVED, SETTLED, statusMap } from '../attribution/kit.ts';

// Synthetic map labels; expected steps are independent examples from the P table.
it.each([
  { from: 'DEPOSIT_PAID', raw: 'paid', rule: 'P2', steps: ['PAID'] },
  { from: 'PAID', raw: 'received', rule: 'P3', steps: ['RECEIVED'] },
  { from: 'RECEIVED', raw: 'settled', rule: 'P4', steps: ['SETTLED'] },
  { from: 'PAID', raw: 'settled', rule: 'P5', steps: ['RECEIVED', 'SETTLED'] },
  { from: 'DEPOSIT_PAID', raw: 'settled', rule: 'P5', steps: ['PAID', 'RECEIVED', 'SETTLED'] },
  { from: 'DEPOSIT_PAID', raw: 'received', rule: 'P14', steps: ['PAID', 'RECEIVED'] },
  { from: 'PAID', raw: 'invalid', rule: 'P6', steps: ['INVALID'] },
  { from: 'INVALID', raw: 'paid', rule: 'P9', steps: ['PAID'] },
  { from: 'INVALID', raw: 'received', rule: 'P9', steps: ['RECEIVED'] },
  { from: 'INVALID', raw: 'settled', rule: 'P9', steps: ['SETTLED'] },
] as const)('[AC-B1-08i#01] $rule $from + $raw 按序补 history', ({ from, raw, rule, steps }) => {
  const plan = planOrderUpdate(
    { platform_status: from, rebate_status: 'ESTIMATED', received_at: null },
    order({ raw_status: raw, received_at: at(RECEIVED), settled_at: at(SETTLED) }),
    statusMap('pdd'),
    true,
  );
  expect(plan).toMatchObject({
    kind: 'update',
    rule,
    pending: null,
    platform_status: steps.at(-1),
  });
  expect(plan.history).toEqual(
    steps.map((to, i) => ({
      from_status: i === 0 ? from : steps[i - 1],
      event: `PLATFORM_${to}`,
      to_status: to,
    })),
  );
});

it.each([
  ['PAID', 'received', []],
  ['DEPOSIT_PAID', 'received', ['PAID']],
  ['PAID', 'settled', []],
  ['DEPOSIT_PAID', 'settled', ['PAID']],
] as const)('[AC-B1-08i#02] %s + %s 缺时间不越过 PAID', (from, raw, steps) => {
  const plan = planOrderUpdate(
    { platform_status: from, rebate_status: 'ESTIMATED', received_at: null },
    // 收货事件不能借用结算时间；结算事件这里两种时间都没有。
    order({ raw_status: raw, settled_at: raw === 'received' ? at(SETTLED) : null }),
    statusMap('pdd'),
    true,
  );
  expect(plan).toMatchObject({
    kind: 'update',
    platform_status: 'PAID',
    received_at: null,
    pending: 'NO_RECEIVED_AT',
  });
  expect(plan.history.map((h) => h.to_status)).toEqual(steps);
});

it.each([true, false])(
  '[AC-B1-08i#03] P5 收货时间优先，否则取结算时间（有收货=%s）',
  (hasReceived) => {
    const plan = planOrderUpdate(
      { platform_status: 'PAID', rebate_status: 'ESTIMATED', received_at: null },
      order({
        raw_status: 'settled',
        received_at: hasReceived ? at(RECEIVED) : null,
        settled_at: at(SETTLED),
      }),
      statusMap('pdd'),
      true,
    );
    expect(plan.received_at).toEqual(at(hasReceived ? RECEIVED : SETTLED));
    expect(plan.platform_status).toBe('SETTLED');
  },
);

it('[AC-B1-08i#04] 已有 received_at 满足 P3 守卫且永不覆盖', () => {
  const plan = planOrderUpdate(
    { platform_status: 'PAID', rebate_status: 'ESTIMATED', received_at: at(RECEIVED) },
    order({ raw_status: 'received' }),
    statusMap('pdd'),
    true,
  );
  expect(plan).toMatchObject({
    platform_status: 'RECEIVED',
    received_at: at(RECEIVED),
    pending: null,
  });
});

it.each([
  ['SETTLED', 'invalid', 'P7'],
  ['PAID', 'rights', 'P8'],
  ['RECEIVED', 'punish', 'P8'],
  ['SETTLED', 'rights', 'P8'],
  ['PAID', 'paid', 'P15'],
  ['INVALID', 'invalid', 'P15'],
] as const)(
  '[AC-B1-08i#05] %s + %s 为 noop，保留规则交 settlement，不记 history',
  (from, raw, rule) => {
    expect(
      planOrderUpdate(
        { platform_status: from, rebate_status: 'ESTIMATED', received_at: at(RECEIVED) },
        order({ raw_status: raw }),
        statusMap('pdd'),
        true,
      ),
    ).toMatchObject({ kind: 'update', platform_status: from, history: [], pending: null, rule });
  },
);

it.each([
  ['PAID', 'deposit'],
  ['RECEIVED', 'paid'],
  ['SETTLED', 'received'],
] as const)('[AC-B1-08i#06] P10 %s + %s 开关只改变是否整条拒收', (from, raw) => {
  for (const enabled of [true, false]) {
    expect(
      planOrderUpdate(
        { platform_status: from, rebate_status: 'ESTIMATED', received_at: at(RECEIVED) },
        order({ raw_status: raw }),
        statusMap('pdd'),
        enabled,
      ),
    ).toMatchObject({
      kind: enabled ? 'pending' : 'update',
      platform_status: from,
      history: [],
      pending: 'ILLEGAL_TRANSITION',
      rule: 'P10',
    });
  }
});

it.each([
  ['DEPOSIT_PAID', 'rights'],
  ['DEPOSIT_PAID', 'punish'],
  ['INVALID', 'deposit'],
  ['INVALID', 'rights'],
  ['INVALID', 'punish'],
] as const)('[AC-B1-08i#07] 表外事件 %s + %s 不受 P10 开关影响', (from, raw) => {
  expect(
    planOrderUpdate(
      { platform_status: from, rebate_status: 'ESTIMATED', received_at: null },
      order({ raw_status: raw }),
      statusMap('pdd'),
      false,
    ),
  ).toMatchObject({
    kind: 'pending',
    platform_status: from,
    history: [],
    pending: 'ILLEGAL_TRANSITION',
  });
});

it.each([
  ['ESTIMATED', 'update'],
  ['WAITING', 'update'],
  ['UNATTRIBUTED', 'update'],
  ['VOID', 'update'],
  ['CREDITED', 'pending'],
  ['CLAWED_BACK', 'pending'],
] as const)('[AC-B1-08i#08] 表外码按返利状态 %s 分流', (rebate, kind) => {
  expect(
    planOrderUpdate(
      { platform_status: 'PAID', rebate_status: rebate, received_at: null },
      order({ raw_status: 'synthetic-unknown' }),
      statusMap('pdd'),
      true,
    ),
  ).toMatchObject({
    kind,
    platform_status: 'PAID',
    history: [],
    pending: 'UNMAPPED_STATUS',
    rule: null,
  });
});

it('[AC-B1-08i#09] 使用注入映射而不硬编码原始平台状态码', () => {
  const map = {
    platform: 'pdd',
    entries: new Map([
      [
        'other-code',
        {
          event: 'PLATFORM_RECEIVED' as const,
          source: 'synthetic',
          verified: false,
          note: '',
        },
      ],
    ]),
  };
  const plan = planOrderUpdate(
    { platform_status: 'PAID', rebate_status: 'ESTIMATED', received_at: null },
    order({ raw_status: 'other-code', received_at: at(RECEIVED) }),
    map,
    true,
  );
  expect(plan).toMatchObject({ platform_status: 'RECEIVED', rule: 'P3', pending: null });
});
