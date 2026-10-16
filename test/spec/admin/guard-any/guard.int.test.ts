// F1-10c rule tests: AdminOperationGuard with a list of permission points ("any one of") and
// read-only operations (04 §11.2: only a modification needs step-up; orchestrator ruling
// §9.2 #1–#5). Single-point writes keep the F1-06u behaviour (test/spec/admin/guard-mount/**).
import { expect, it } from 'vitest';
import { useHarness } from '../auth/kit.ts';
import { actorOf, allowed, rejected, scenario, select, watchStepUpRedis } from './kit.ts';

const h = useHarness();
const DENIED = { reason: 'admin_permission_denied' };

it('[AC-F1-10c#1] 只读 + 数组：持有其中任一即放行，不要求令牌，无效令牌也被忽略', async () => {
  const s = await scenario(h, {
    selection: { permission: ['switch.all', 'switch.payout'], readOnly: true },
    grants: ['switch.payout'],
  });
  allowed(await s.read(), actorOf(s));
  allowed(await s.read('invalid-step-up-token'), actorOf(s));
  select(s, { permission: ['switch.payout', 'switch.all'], readOnly: true });
  allowed(await s.read(), actorOf(s));
  expect(s.business).toHaveBeenCalledTimes(3);
});

it('[AC-F1-10c#2] 只读不读也不核销所带令牌，之后令牌仍可用于一次写操作', async () => {
  const watch = watchStepUpRedis();
  try {
    const s = await scenario(h, {
      selection: { permission: ['pii.reveal_phone', 'content.agreement'], readOnly: true },
      grants: ['pii.reveal_phone'],
    });
    const token = (await s.issue()).step_up_token;
    watch.touched.mockClear();
    allowed(await s.read(token), actorOf(s));
    select(s, { permission: 'pii.reveal_phone', readOnly: true });
    allowed(await s.read(token), actorOf(s));
    allowed(await s.read(), actorOf(s));
    expect(watch.touched).not.toHaveBeenCalled();
    select(s, { permission: 'pii.reveal_phone' });
    allowed(await s.read(token), actorOf(s));
    expect(watch.touched).toHaveBeenCalled();
    await rejected(await s.read(token), 10003, { tier: 'totp' });
    expect(s.business).toHaveBeenCalledTimes(4);
  } finally {
    watch.restore();
  }
});

it('[AC-F1-10c#3] 只读不判二次验证：短信档权限点未登记验证手机号也放行，写操作仍要求', async () => {
  const s = await scenario(h, {
    selection: { permission: 'fund.adjust', readOnly: true },
    grants: ['fund.adjust'],
  });
  allowed(await s.read(), actorOf(s));
  select(s, { permission: ['fund.writeoff', 'fund.adjust'], readOnly: true });
  allowed(await s.read(), actorOf(s));
  expect(s.business).toHaveBeenCalledTimes(2);
  select(s, { permission: 'fund.adjust' });
  await rejected(await s.read(), 10003, { tier: 'sms', reason: 'verify_phone_missing' });
  expect(s.business).toHaveBeenCalledTimes(2);
});

it('[AC-F1-10c#4] 只读 + 数组都不持有返回 10403，不执行业务也不核销令牌；勾选后即放行', async () => {
  const s = await scenario(h, {
    selection: { permission: ['switch.all', 'switch.payout'], readOnly: true },
    grants: ['config.general'],
  });
  const token = (await s.issue()).step_up_token;
  for (const value of [undefined, token]) await rejected(await s.read(value), 10403, DENIED);
  expect(s.business).not.toHaveBeenCalled();
  await s.grant('switch.all');
  allowed(await s.read(), actorOf(s));
  select(s, { permission: 'switch.all' });
  allowed(await s.read(token), actorOf(s));
  await rejected(await s.read(token), 10003, { tier: 'totp' });
  expect(s.business).toHaveBeenCalledTimes(2);
});

it('[AC-F1-10c#5] 只读 + 混档数组不是编程错误：持有任一即放行且不要求令牌', async () => {
  const s = await scenario(h, {
    selection: { permission: ['config.general', 'config.business'], readOnly: true },
    grants: ['config.business'],
  });
  allowed(await s.read(), actorOf(s));
  select(s, { permission: ['switch.all', 'fund.adjust'], readOnly: true });
  await s.grant('fund.adjust');
  allowed(await s.read(), actorOf(s));
  expect(s.business).toHaveBeenCalledTimes(2);
});

it.each([[['switch.all']], [['switch.payout']], [['switch.all', 'switch.payout']]] as const)(
  '[AC-F1-10c#6] 写 + 同档（totp）数组，持有 %j：缺令牌 10003，带有效令牌执行一次并核销',
  async (held) => {
    const s = await scenario(h, {
      selection: { permission: ['switch.all', 'switch.payout'] },
      grants: held,
    });
    await rejected(await s.read(), 10003, { tier: 'totp' });
    await rejected(await s.read('invalid-step-up-token'), 10003, { tier: 'totp' });
    expect(s.business).not.toHaveBeenCalled();
    const token = (await s.issue()).step_up_token;
    allowed(await s.read(token), actorOf(s));
    await rejected(await s.read(token), 10003, { tier: 'totp' });
    expect(s.business).toHaveBeenCalledTimes(1);
  },
);

it('[AC-F1-10c#7] 写 + 同档数组都不持有返回 10403 且不核销令牌；勾选其一后同一令牌可用一次', async () => {
  const s = await scenario(h, {
    selection: { permission: ['switch.all', 'switch.payout'] },
    grants: ['switch.pay'],
  });
  const token = (await s.issue()).step_up_token;
  for (const value of [undefined, token]) await rejected(await s.read(value), 10403, DENIED);
  expect(s.business).not.toHaveBeenCalled();
  await s.grant('switch.payout');
  allowed(await s.read(token), actorOf(s));
  await rejected(await s.read(token), 10003, { tier: 'totp' });
  expect(s.business).toHaveBeenCalledTimes(1);
});

it('[AC-F1-10c#8] 写 + 同档（无需二次验证）数组：持有任一即执行，不要求也不读令牌', async () => {
  const watch = watchStepUpRedis();
  try {
    const s = await scenario(h, {
      selection: { permission: ['content.platform_icon', 'config.general'] },
      grants: ['config.general'],
    });
    watch.touched.mockClear();
    allowed(await s.read(), actorOf(s));
    allowed(await s.read('invalid-step-up-token'), actorOf(s));
    expect(watch.touched).not.toHaveBeenCalled();
    expect(s.business).toHaveBeenCalledTimes(2);
  } finally {
    watch.restore();
  }
});

it.each([false, true])(
  '[AC-F1-10c#9] 写 + 同档（短信）数组按短信档要令牌，已登记验证手机号=%s',
  async (phone) => {
    const s = await scenario(h, {
      selection: { permission: ['fund.adjust', 'fund.writeoff'] },
      grants: ['fund.writeoff'],
      phone,
    });
    if (!phone) {
      await rejected(await s.read(), 10003, { tier: 'sms', reason: 'verify_phone_missing' });
      expect(s.business).not.toHaveBeenCalled();
      return;
    }
    await rejected(await s.read(), 10003, { tier: 'sms' });
    const totpToken = (await s.issue('totp')).step_up_token;
    await rejected(await s.read(totpToken), 10003, { tier: 'sms' });
    expect(s.business).not.toHaveBeenCalled();
    const token = (await s.issue('sms')).step_up_token;
    allowed(await s.read(token), actorOf(s));
    await rejected(await s.read(token), 10003, { tier: 'sms' });
    expect(s.business).toHaveBeenCalledTimes(1);
  },
);

it.each([
  [['config.general', 'config.business'], ['config.general']],
  [['config.general', 'config.business'], ['config.business']],
  [
    ['config.general', 'config.business'],
    ['config.general', 'config.business'],
  ],
  [['switch.all', 'fund.adjust'], ['switch.all']],
  [['switch.all', 'fund.adjust'], ['fund.adjust']],
  [
    ['switch.all', 'fund.adjust'],
    ['switch.all', 'fund.adjust'],
  ],
] as const)(
  '[AC-F1-10c#10] 写 + 混档数组 %j（持有 %j）是编程错误 50001：不执行业务、不核销令牌',
  async (permission, held) => {
    const s = await scenario(h, {
      selection: { permission },
      grants: [...held, 'pii.reveal_phone'],
      phone: true,
    });
    const token = (await s.issue()).step_up_token;
    await rejected(await s.read(), 50001);
    await rejected(await s.read(token), 50001);
    expect(s.business).not.toHaveBeenCalled();
    select(s, { permission: 'pii.reveal_phone' });
    allowed(await s.read(token), actorOf(s));
    expect(s.business).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])(
  '[AC-F1-10c#11] 空数组是编程错误 50001（只读=%s），不执行业务',
  async (readOnly) => {
    const s = await scenario(h, {
      selection: { permission: [], readOnly },
      grants: ['config.general', 'content.platform_icon', 'pii.reveal_phone'],
    });
    const token = (await s.issue()).step_up_token;
    await rejected(await s.read(), 50001);
    await rejected(await s.read(token), 50001);
    expect(s.business).not.toHaveBeenCalled();
  },
);

it('[AC-F1-10c#12] 超管未勾任何点：只读数组直接放行；写数组仍按共同档位要令牌；混档与空数组仍是 50001', async () => {
  const s = await scenario(h, {
    selection: { permission: ['switch.all', 'switch.payout'], readOnly: true },
    grants: [],
    isSuper: true,
  });
  const actor = actorOf(s, true);
  allowed(await s.read(), actor);
  select(s, { permission: 'pii.reveal_phone', readOnly: true });
  allowed(await s.read(), actor);
  expect(s.business).toHaveBeenCalledTimes(2);

  select(s, { permission: ['switch.all', 'switch.payout'] });
  await rejected(await s.read(), 10003, { tier: 'totp' });
  const token = (await s.issue()).step_up_token;
  allowed(await s.read(token), actor);
  await rejected(await s.read(token), 10003, { tier: 'totp' });
  expect(s.business).toHaveBeenCalledTimes(3);

  const fresh = (await s.issue()).step_up_token;
  for (const selection of [
    { permission: ['config.general', 'config.business'] },
    { permission: [] },
    { permission: [], readOnly: true },
  ]) {
    select(s, selection);
    await rejected(await s.read(fresh), 50001);
  }
  expect(s.business).toHaveBeenCalledTimes(3);
  select(s, { permission: 'config.business' });
  allowed(await s.read(fresh), actor);
  expect(s.business).toHaveBeenCalledTimes(4);
});

it('[AC-F1-10c#13] 单个权限点：非只读（缺省或 readOnly=false）与单元素数组同 F1-06u，只读则不要求令牌', async () => {
  const s = await scenario(h, {
    selection: { permission: 'pii.reveal_phone', readOnly: true },
    grants: ['pii.reveal_phone'],
  });
  allowed(await s.read(), actorOf(s));
  expect(s.business).toHaveBeenCalledTimes(1);
  for (const selection of [
    { permission: 'pii.reveal_phone' },
    { permission: 'pii.reveal_phone', readOnly: false },
    { permission: ['pii.reveal_phone'] },
    { permission: ['pii.reveal_phone'], readOnly: false },
  ]) {
    select(s, selection);
    await rejected(await s.read(), 10003, { tier: 'totp' });
    const token = (await s.issue()).step_up_token;
    allowed(await s.read(token), actorOf(s));
    await rejected(await s.read(token), 10003, { tier: 'totp' });
  }
  expect(s.business).toHaveBeenCalledTimes(5);
  select(s, { permission: ['switch.all'], readOnly: false });
  await rejected(await s.read(), 10403, DENIED);
  expect(s.business).toHaveBeenCalledTimes(5);
});
