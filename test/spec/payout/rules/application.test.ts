import { expect, it, vi } from 'vitest';
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  createDefaultFeeTaxCalculator,
  createWithdrawRules,
  readWithdrawLimits,
  type WithdrawHold,
} from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';
import { actor, applicationFixture, input, limits } from './fixtures.ts';
import { contract } from './http-kit.ts';

it('[AC-B2-05c#30] 配置缺失使用全部默认值，并带 app_id 与调用方句柄', async () => {
  const f = applicationFixture();
  expect(await readWithdrawLimits(f.handle, actor, f.options)).toEqual(limits());
  const calls = vi.mocked(f.options.config.configValue).mock.calls;
  expect(new Set(calls.map((c) => c[1]))).toEqual(
    new Set([
      'withdraw.enabled',
      'withdraw.min_amount_fen',
      'withdraw.amount_step_fen',
      'withdraw.max_amount_fen',
      'withdraw.daily_count_per_user',
      'withdraw.monthly_count_per_user',
      'withdraw.payee_daily_count',
      'withdraw.payee_daily_distinct_users',
      'withdraw.method_max_amount_fen.alipay',
      'withdraw.method_max_amount_fen.bank_card',
      'withdraw.method_max_amount_fen.wechat',
      'withdraw.minor_monthly_cap_fen',
      'withdraw.self_purchase_90d.enabled',
      'withdraw.self_purchase_90d.min_fen',
      'withdraw.allowed_member_levels',
    ]),
  );
  for (const [app, , handle] of calls) {
    expect(app).toBe(actor.appId);
    expect(handle).toBe(f.handle);
  }
});

it.each([
  ['withdraw.min_amount_fen', 0],
  ['withdraw.amount_step_fen', 0],
  ['withdraw.max_amount_fen', 0],
  ['withdraw.min_amount_fen', 1.5],
  ['withdraw.max_amount_fen', '500'],
  ['withdraw.daily_count_per_user', -1],
  ['withdraw.monthly_count_per_user', 1.5],
  ['withdraw.payee_daily_count', null],
  ['withdraw.payee_daily_distinct_users', false],
  ['withdraw.method_max_amount_fen.wechat', -1],
  ['withdraw.minor_monthly_cap_fen', -1],
  ['withdraw.self_purchase_90d.min_fen', -1],
  ['withdraw.self_purchase_90d.enabled', 'yes'],
  ['withdraw.allowed_member_levels', ['vip']],
  ['withdraw.enabled', 'invalid'],
] as const)('[AC-B2-05c#31] 非法配置 %s=%j 记 warn 并使用该键默认值', async (key, value) => {
  const f = applicationFixture();
  f.values.set(key, value);
  expect(await readWithdrawLimits(f.handle, actor, f.options)).toEqual(limits());
  expect(f.options.logger.warn).toHaveBeenCalled();
});

it('[AC-B2-05c#32] 配置覆盖立即生效，次数 0 不限、minor cap 0 禁提不混用', async () => {
  const f = applicationFixture();
  for (const key of [
    'daily_count_per_user',
    'monthly_count_per_user',
    'payee_daily_count',
    'payee_daily_distinct_users',
    'minor_monthly_cap_fen',
  ])
    f.values.set(`withdraw.${key}`, 0);
  f.values.set('withdraw.min_amount_fen', 300);
  f.values.set('withdraw.amount_step_fen', 25);
  f.values.set('withdraw.max_amount_fen', 100000);
  f.values.set('withdraw.method_max_amount_fen.wechat', 10000);
  expect(await readWithdrawLimits(f.handle, actor, f.options)).toEqual({
    ...limits(),
    min_amount_fen: 300n,
    amount_step_fen: 25n,
    max_amount_fen: 100000n,
    daily_count_per_user: 0,
    monthly_count_per_user: 0,
    payee_daily_count: 0,
    payee_daily_distinct_users: 0,
    minor_monthly_cap_fen: 0n,
    method_max_amount_fen: { alipay: 0n, bank_card: 0n, wechat: 10000n },
  });
  f.values.set('withdraw.min_amount_fen', 400);
  expect((await readWithdrawLimits(f.handle, actor, f.options)).min_amount_fen).toBe(400n);
});

it.each([false, 'off'])(
  '[AC-B2-05c#33] withdraw.enabled=%s 最先阻断，估算三项为 null',
  async (off) => {
    const f = applicationFixture();
    f.values.set('withdraw.enabled', off);
    const service = createWithdrawRules(f.options);
    expect(await service.getRules(f.handle, actor, 50n)).toMatchObject({
      can_withdraw: false,
      block_code: 30306,
      block_reason: null,
      max_withdrawable_fen: 0,
      est_fee_fen: null,
      est_tax_fen: null,
      est_net_fen: null,
    });
    expect(f.options.feeTax.calculate).not.toHaveBeenCalled();
  },
);

it.each([
  ['2026-10-01T15:59:59.999Z', true],
  ['2026-10-01T16:00:00.000Z', true],
  ['2026-10-01T16:00:00.001Z', false],
  [null, false],
] as const)(
  '[AC-B2-05c#34] frozen_until=%s 与注入时钟比较，到期瞬间解除',
  async (until, allowed) => {
    const f = applicationFixture();
    vi.mocked(f.options.risk.read).mockResolvedValue(
      new Map([
        [actor.userId, { state: 'frozen', frozen_until: until === null ? null : new Date(until) }],
      ]),
    );
    const result = await createWithdrawRules(f.options).getRules(f.handle, actor);
    expect(result).toMatchObject({
      can_withdraw: allowed,
      block_code: allowed ? null : 30303,
      block_reason: allowed ? null : 'account_frozen',
    });
  },
);

it.each(['banned', 'frozen'] as const)(
  '[AC-B2-05c#35] appealing 使用 prev=%s，不把申诉当正常',
  async (prev) => {
    const f = applicationFixture();
    vi.mocked(f.options.risk.read).mockResolvedValue(
      new Map([[actor.userId, { state: 'appealing', frozen_until: null }]]),
    );
    vi.mocked(f.options.appeal.read).mockResolvedValue(prev);
    expect(await createWithdrawRules(f.options).getRules(f.handle, actor)).toMatchObject({
      can_withdraw: false,
      block_code: prev === 'banned' ? 10006 : 30303,
      block_reason: prev === 'banned' ? null : 'account_frozen',
    });
    expect(f.options.appeal.read).toHaveBeenCalledWith(
      f.handle,
      expect.objectContaining({ appId: actor.appId, userId: actor.userId }),
    );
  },
);

it.each([
  { released: null, until: null, active: true },
  { released: null, until: '2026-10-01T16:00:00.001Z', active: true },
  { released: null, until: '2026-10-01T16:00:00.000Z', active: false },
  { released: null, until: '2026-10-01T15:59:59.999Z', active: false },
  { released: '2026-10-01T15:00:00Z', until: null, active: false },
  { released: '2026-10-01T15:00:00Z', until: '2026-10-02T00:00:00Z', active: false },
])('[AC-B2-05c#36] hold released=$released until=$until 生效=$active', async (row) => {
  const f = applicationFixture();
  vi.mocked(f.options.holds.read).mockResolvedValue([
    {
      reason: 'ledger_mismatch',
      released_at: row.released === null ? null : new Date(row.released),
      hold_until: row.until === null ? null : new Date(row.until),
    },
  ]);
  expect(await createWithdrawRules(f.options).getRules(f.handle, actor)).toMatchObject({
    can_withdraw: !row.active,
    block_code: row.active ? 30303 : null,
    block_reason: row.active ? 'account_frozen' : null,
  });
});

it.each(['manual', 'recon_diff', 'ledger_mismatch', 'manual_failed_watch'] as const)(
  '[AC-B2-05c#37] 多个冻结叠加，有效 %s 不被已解除记录覆盖',
  async (reason) => {
    const f = applicationFixture();
    const active: WithdrawHold = { reason, released_at: null, hold_until: null };
    vi.mocked(f.options.holds.read).mockResolvedValue([
      { ...active, released_at: new Date('2026-09-30T00:00:00Z') },
      active,
      { ...active, hold_until: new Date('2026-09-30T00:00:00Z') },
    ]);
    expect(await createWithdrawRules(f.options).getRules(f.handle, actor)).toMatchObject({
      block_code: 30303,
      block_reason: 'account_frozen',
    });
  },
);

it.each([
  { field: 'realname', code: 30304 },
  { field: 'subject', code: 30305 },
  { field: 'name', code: 30307 },
  { field: 'labor', code: 10004 },
  { field: 'negative', code: 30302 },
] as const)('[AC-B2-05c#38] 端口输入 $field 映射为 $code', async ({ field, code }) => {
  const f = applicationFixture();
  if (field === 'realname') {
    vi.mocked(f.options.realname.read).mockResolvedValue('none');
    vi.mocked(f.options.realname.verified).mockResolvedValue(null);
  }
  if (field === 'subject') vi.mocked(f.options.subject.read).mockResolvedValue(null);
  if (field === 'name')
    vi.mocked(f.options.subject.read).mockResolvedValue({
      payout_method: 'alipay',
      payee_name: '另一个人',
      payee_hmac: 'a'.repeat(64),
    });
  if (field === 'labor') vi.mocked(f.options.laborAgreementSigned).mockResolvedValue(false);
  if (field === 'negative')
    vi.mocked(f.options.ledger.getBalances).mockResolvedValue([
      {
        app_id: actor.appId,
        user_id: actor.userId,
        account_id: actor.userId,
        available_fen: -1n,
        frozen_fen: 0n,
        version: 1n,
        negative_since: '2026-10-02',
      },
    ]);
  const service = createWithdrawRules(f.options);
  expect(await service.getRules(f.handle, actor)).toMatchObject({
    can_withdraw: false,
    block_code: code,
    block_reason: null,
    max_withdrawable_fen: 0,
    est_fee_fen: null,
    est_tax_fen: null,
    est_net_fen: null,
  });
  if (field === 'labor')
    expect(await service.validate(f.handle, actor, 100n, true)).toEqual({
      code: 10004,
      data: { consent_type: 'labor_agreement' },
    });
});

it.each(['　阿．甲\u00a0', '阿•甲', '阿.甲', '阿・甲'])(
  '[AC-B2-05c#39] 实名与收款名规范化比较：%s',
  async (name) => {
    const f = applicationFixture();
    vi.mocked(f.options.subject.read).mockResolvedValue({
      payout_method: 'alipay',
      payee_name: name,
      payee_hmac: 'a'.repeat(64),
    });
    expect(await createWithdrawRules(f.options).getRules(f.handle, actor)).toMatchObject({
      can_withdraw: true,
    });
  },
);

it('[AC-B2-05c#40] 无余额账户按 0，GET below_min、不创建账户', async () => {
  const f = applicationFixture();
  vi.mocked(f.options.ledger.getBalances).mockResolvedValue([]);
  expect(await createWithdrawRules(f.options).getRules(f.handle, actor)).toMatchObject({
    withdrawable_fen: 0,
    can_withdraw: false,
    block_code: 30303,
    block_reason: 'below_min',
    max_withdrawable_fen: 0,
  });
});

it.each([null, { code: 10010, data: { method: 'sms' } }])(
  '[AC-B2-05c#41] ③b 透传 %j，位于 banned 之后、实名之前',
  async (gate) => {
    const f = applicationFixture();
    vi.mocked(f.options.reverify.check).mockResolvedValue(gate);
    const service = createWithdrawRules(f.options);
    expect(await service.getRules(f.handle, actor)).toMatchObject({
      can_withdraw: gate === null,
      block_code: gate?.code ?? null,
      block_reason: null,
    });
    expect(f.options.reverify.check).toHaveBeenCalledWith(f.handle, actor);
    vi.mocked(f.options.realname.read).mockResolvedValue('none');
    vi.mocked(f.options.realname.verified).mockResolvedValue(null);
    expect(await service.getRules(f.handle, actor)).toMatchObject({
      block_code: gate?.code ?? 30304,
    });
    if (gate !== null) expect(await service.validate(f.handle, actor, 100n, true)).toEqual(gate);
    vi.mocked(f.options.risk.read).mockResolvedValue(
      new Map([[actor.userId, { state: 'banned', frozen_until: null }]]),
    );
    expect(await service.getRules(f.handle, actor)).toMatchObject({ block_code: 10006 });
  },
);

it('[AC-B2-05c#42] 黑名单端口附加文案码透传，接收当前收款账号和设备身份', async () => {
  const f = applicationFixture();
  vi.mocked(f.options.blocklist.read).mockResolvedValue({ risk_msg_code: 'synthetic_blacklist' });
  const service = createWithdrawRules(f.options);
  expect(await service.validate(f.handle, actor, 100n, true)).toEqual({
    code: 44001,
    data: { risk_msg_code: 'synthetic_blacklist' },
  });
  expect(await service.getRules(f.handle, actor)).toMatchObject({
    can_withdraw: false,
    block_code: 44001,
    block_reason: null,
  });
  expect(f.options.blocklist.read).toHaveBeenCalledWith(f.handle, {
    ...actor,
    payeeHmac: 'a'.repeat(64),
    payoutMethod: 'alipay',
    now: f.clock.now(),
  });
});

it.each([
  ['2026-10-02T15:59:59.999Z', false],
  ['2026-10-02T16:00:00.000Z', true],
] as const)('[AC-B2-05c#43] 18 岁 +08:00 生日边界 %s 自动失效 cap=0', async (now, adult) => {
  const f = applicationFixture();
  f.clock.set(now);
  f.values.set('withdraw.minor_monthly_cap_fen', 0);
  vi.mocked(f.options.realname.verified).mockResolvedValue({
    name: '阿·甲',
    birth_date: '2008-10-02',
    provider: 'synthetic',
    verified_at: new Date('2026-09-01T00:00:00Z'),
  });
  expect(await createWithdrawRules(f.options).getRules(f.handle, actor)).toMatchObject({
    can_withdraw: adult,
    block_code: adult ? null : 30309,
  });
});

it.each([undefined, 50n, 125n, 500100n])(
  '[AC-B2-05c#44] 估算金额 %s 不做 ⑨⑩⑫ 比较；未带金额按 max',
  async (amount) => {
    const f = applicationFixture();
    vi.mocked(f.options.realname.verified).mockResolvedValue({
      name: '阿·甲',
      birth_date: '2010-10-02',
      provider: 'synthetic',
      verified_at: f.clock.now(),
    });
    vi.mocked(f.options.usage.read).mockResolvedValue({
      ...input().usage,
      monthly_amount_fen: 10000n,
    });
    vi.mocked(f.options.feeTax.calculate).mockResolvedValue({
      fee_fen: 1n,
      tax_fen: 2n,
      net_fen: 47n,
    });
    const result = await createWithdrawRules(f.options).getRules(f.handle, actor, amount);
    expect(result).toMatchObject({
      can_withdraw: true,
      max_withdrawable_fen: 10000,
      est_fee_fen: 1,
      est_tax_fen: 2,
      est_net_fen: 47,
      quick_amounts_fen: [],
    });
    expect(f.options.feeTax.calculate).toHaveBeenCalledWith(f.handle, {
      ...actor,
      amountFen: amount ?? 10000n,
      now: f.clock.now(),
    });
  },
);

it('[AC-B2-05c#45] 默认估算器 fee=0 tax=0 net=amount；不擅自展开 BR-WDR-19/20', async () => {
  const f = applicationFixture();
  expect(
    await createDefaultFeeTaxCalculator().calculate(f.handle, {
      ...actor,
      amountFen: 12345n,
      now: f.clock.now(),
    }),
  ).toEqual({ fee_fen: 0n, tax_fen: 0n, net_fen: 12345n });
});

it('[AC-B2-05c#46] 全部读取在调用方句柄，身份、app_id、时钟由服务端传递', async () => {
  const f = applicationFixture();
  await createWithdrawRules(f.options).getRules(f.handle, actor);
  expect(f.options.risk.read).toHaveBeenCalledWith(f.handle, {
    appId: actor.appId,
    userIds: [actor.userId],
  });
  expect(f.options.realname.verified).toHaveBeenCalledWith(f.handle, {
    app_id: actor.appId,
    user_id: actor.userId,
  });
  expect(f.options.laborAgreementSigned).toHaveBeenCalledWith(f.handle, {
    app_id: actor.appId,
    user_id: actor.userId,
  });
  expect(f.options.ledger.getBalances).toHaveBeenCalledWith(f.handle, {
    appId: actor.appId,
    userIds: [actor.userId],
  });
  expect(f.options.usage.read).toHaveBeenCalledWith(f.handle, {
    ...actor,
    now: f.clock.now(),
    payeeHmac: 'a'.repeat(64),
  });
  expect(f.options.holds.read).toHaveBeenCalledWith(f.handle, actor);
});

it('[AC-B2-05c#47] getRules 真实输出在可提现与劳务协议阻断时均符合契约', async () => {
  const schema = (await contract()).components.schemas['WithdrawRules'];
  expect(schema).toBeDefined();
  const validate = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  const f = applicationFixture();
  const service = createWithdrawRules(f.options);
  const allowed = await service.getRules(f.handle, actor);
  expect(allowed).toMatchObject({ can_withdraw: true, block_code: null });
  expect(validate(allowed), JSON.stringify(validate.errors)).toBe(true);
  vi.mocked(f.options.laborAgreementSigned).mockResolvedValue(false);
  const blocked = await service.getRules(f.handle, actor);
  expect(blocked).toMatchObject({ can_withdraw: false, block_code: 10004 });
  expect(validate(blocked), JSON.stringify(validate.errors)).toBe(true);
});
