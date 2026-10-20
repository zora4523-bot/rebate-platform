// F1-10d: PUT /admin/v1/kill-switches/{key} (adminUpdateKillSwitch) — permission point by key,
// totp step-up, key and value checks (brief §9.2 #2, #7; §9.3 「切换」). Readings in ./kit.ts.
import { expect, it, vi } from 'vitest';
import { factory, useHarness } from '../../admin/auth/kit.ts';
import { guardOf } from '../../admin/guard-mount/kit.ts';
import {
  DENIED,
  EDITABLE_SAMPLES,
  ITEM,
  LIST,
  POINTS,
  changedValue,
  hasRoute,
  item,
  member,
  owner,
  put,
  rejected,
  seedSwitch,
  setup,
  snapshot,
  staticFields,
  stepUp,
  updated,
  type Json,
} from './kit.ts';

const h = useHarness();
const INVITE_BUDGET_KEYS = [
  'growth.invite_reward.daily_budget_fen',
  'growth.invite_reward.total_budget_fen',
] as const;

it.each(EDITABLE_SAMPLES)(
  '[AC-F1-10d#9] §9.2 #2 按键的权限点：%s 只有登记的权限点之一可改（withdraw.* / payout.* 认 switch.payout、pay.* 认 switch.pay、其余只认 switch.all），无权限 10403 且不写库',
  async (key) => {
    const f = await setup(h);
    // F1-02zm (test-change, transitional; F1-02zt tightens): BR-INV-24 ④ and 04 §10.2 l.956 refuse
    // turning growth.invite_reward.enabled on while the daily or the total budget is 0 (their
    // default), so this app first gets two non-zero budgets; every step below is unchanged.
    if (key === 'growth.invite_reward.enabled') {
      for (const budget of INVITE_BUDGET_KEYS) await seedSwitch(h, f.appId, budget, 100_000, 1);
      // F1-02zz (test-change, transitional; F1-02zt tightens): F1-02zn's rule tests also refuse
      // turning it on while the per-side amount is below 1, a missing row counting as 0, so the
      // same app also gets the 08 default amount of 1000 fen.
      await seedSwitch(h, f.appId, 'growth.invite_reward.amount_fen', 1000, 1);
    }
    const allowed = staticFields(key).permissions;
    let current: Json | null = null;
    let version = 0;
    for (const point of POINTS) {
      const caller = await member(h, f, [point]);
      const token = await stepUp(f, caller);
      const before = await snapshot(h, f.appId);
      const value = changedValue(key, current);
      const sent = await put(f.app, caller, key, { value, expected_version: version }, token);
      if (!allowed.includes(point)) {
        await rejected(sent, 'update', 10403, DENIED);
        expect(await snapshot(h, f.appId), `${point} must not write`).toEqual(before);
        continue;
      }
      const row = await updated(sent);
      version += 1;
      current = value;
      expect(row).toMatchObject({
        key,
        value,
        version,
        updated_by: caller.account.username,
      });
      expect(await item(h, f.appId, key)).toMatchObject({ value, version });
    }
    expect(version).toBe(allowed.length);
  },
);

it.each([
  ['withdraw.enabled', ['switch.all', 'switch.payout']],
  ['payout.channel_paused.bank_card', ['switch.all', 'switch.payout']],
  ['pay.enabled', ['switch.all', 'switch.pay']],
  ['pay.channel_enabled.wechat_pay', ['switch.all', 'switch.pay']],
  ['withdraw.auto_payout.enabled', ['switch.all']],
  ['growth.invite_bind.enabled', ['switch.all']],
] as const)(
  '[AC-F1-10d#10] §9.2 #2 写操作经守卫写模式：%s 传该键登记的权限点 %j（非只读）',
  async (key, points) => {
    const f = await setup(h);
    const token = await stepUp(f, owner(f));
    const guard = await guardOf(f.app);
    const run = vi.spyOn(guard, 'run');
    try {
      await updated(await put(f.app, owner(f), key, { value: false, expected_version: 0 }, token));
      expect(run).toHaveBeenCalledTimes(1);
      const input = run.mock.calls[0]![0];
      expect(input.readOnly ?? false).toBe(false);
      const selected =
        typeof input.permission === 'string' ? [input.permission] : [...input.permission];
      expect(selected.sort()).toEqual([...points].sort());
    } finally {
      run.mockRestore();
    }
  },
);

it.each(['withdraw.enabled', 'payout.queue_paused', 'pay.enabled', 'growth.invite_bind.enabled'])(
  '[AC-F1-10d#11] §9.2 #2 %s 要 totp 档二次验证：缺令牌或无效令牌 10003 tier=totp 且不写库；令牌只能用一次',
  async (key) => {
    const f = await setup(h);
    const before = await snapshot(h, f.appId);
    const body = { value: false, expected_version: 0 };
    await rejected(await put(f.app, owner(f), key, body, null), 'update', 10003, { tier: 'totp' });
    await rejected(
      await put(f.app, owner(f), key, body, 'invalid-step-up-token'),
      'update',
      10003,
      {
        tier: 'totp',
      },
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
    const token = await stepUp(f, owner(f));
    expect(await updated(await put(f.app, owner(f), key, body, token))).toMatchObject({
      value: false,
      version: 1,
    });
    const after = await snapshot(h, f.appId);
    await rejected(
      await put(f.app, owner(f), key, { value: true, expected_version: 1 }, token),
      'update',
      10003,
      { tier: 'totp' },
    );
    expect(await snapshot(h, f.appId)).toEqual(after);
  },
);

it('[AC-F1-10d#12] §9.2 #2 未登记的键与后台暂不可改的键（agent.whitelist_only、agent.model_route）返回 20001 [key]，不写库、不核销令牌', async () => {
  const f = await setup(h);
  // A configuration item that is not a switch must not become writable through this route.
  await seedSwitch(h, f.appId, 'config.invite.backfill_hours', 168, 2);
  await seedSwitch(h, f.appId, 'agent.whitelist_only', true, 1);
  const token = await stepUp(f, owner(f));
  const before = await snapshot(h, f.appId);
  const cases: [string, Json, number][] = [
    ['config.invite.backfill_hours', 24, 2],
    ['payout.proven_success_writeoff.enabled', false, 0],
    ['convert.enabled', false, 0],
    ['convert.enabled.taobao.x', false, 0],
    ['convert.enabled.Taobao', false, 0],
    ['agent.tools.enabled', false, 0],
    ['withdraw', false, 0],
    ['agent.whitelist_only', false, 1],
    ['agent.model_route', { primary: 'model-a' }, 0],
  ];
  for (const [key, value, version] of cases) {
    await rejected(
      await put(f.app, owner(f), key, { value, expected_version: version }, token),
      'update',
      20001,
      { fields: ['key'] },
    );
  }
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(
    await updated(
      await put(f.app, owner(f), 'claims.enabled', { value: false, expected_version: 0 }, token),
    ),
  ).toMatchObject({ key: 'claims.enabled', value: false, version: 1 });
});

it.each([
  ['withdraw.enabled', ['false', 'true', 0, 1, null, {}, [], [false]], false],
  [
    'convert.off_reason.pdd',
    ['paused', 'MAINTENANCE', ' maintenance', '', true, null, {}],
    'maintenance',
  ],
  ['payout.channel_enabled.alipay', ['off', 0, null], false],
] as const)(
  '[AC-F1-10d#13] §9.2 #2 %s 的值不合登记类型返回 20001 [value]，不写库、不核销令牌',
  async (key, invalid, valid) => {
    const f = await setup(h);
    await seedSwitch(h, f.appId, key, staticFields(key).default ?? true, 2);
    const token = await stepUp(f, owner(f));
    const before = await snapshot(h, f.appId);
    for (const value of invalid) {
      await rejected(
        await put(f.app, owner(f), key, { value, expected_version: 2 }, token),
        'update',
        20001,
        { fields: ['value'] },
      );
    }
    expect(await snapshot(h, f.appId)).toEqual(before);
    expect(
      await updated(await put(f.app, owner(f), key, { value: valid, expected_version: 2 }, token)),
    ).toMatchObject({ key, value: valid, version: 3 });
  },
);

it.each([false, true])(
  '[AC-F1-10d#14] 裁定 12 / BR-WDR-30：withdraw.auto_payout.enabled 改为 true 返回 20001 [value]（已有行=%s），改为 false 成功',
  async (existing) => {
    const f = await setup(h);
    const key = 'withdraw.auto_payout.enabled';
    if (existing) await seedSwitch(h, f.appId, key, true, 4);
    const version = existing ? 4 : 0;
    const caller = await member(h, f, ['switch.all']);
    const token = await stepUp(f, caller);
    const before = await snapshot(h, f.appId);
    await rejected(
      await put(f.app, caller, key, { value: true, expected_version: version }, token),
      'update',
      20001,
      { fields: ['value'] },
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
    const row = await updated(
      await put(f.app, caller, key, { value: false, expected_version: version }, token),
    );
    expect(row).toMatchObject({ key, value: false, version: version + 1, default: false });
    expect(await item(h, f.appId, key)).toMatchObject({ value: false, version: version + 1 });
  },
);

it('[AC-F1-10d#15] 请求体不能注入 app_id、作者或版本，缺字段与越界取值返回 20001，不写库', async () => {
  const f = await setup(h);
  const token = await stepUp(f, owner(f));
  const before = await snapshot(h, f.appId);
  for (const body of [
    { value: false, expected_version: 0, app_id: 'other-app' },
    { value: false, expected_version: 0, updated_by: 'someone-else' },
    { value: false, expected_version: 0, version: 7 },
    { value: false },
    { expected_version: 0 },
    { value: false, expected_version: -1 },
    { value: false, expected_version: 0, reason: '' },
    { value: false, expected_version: 0, reason: 'x'.repeat(201) },
  ]) {
    await rejected(await put(f.app, owner(f), 'withdraw.enabled', body, token), 'update', 20001);
  }
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-10d#16] §9.2 #7 两个接口只挂 admin 入口，api 与 stream 入口没有这些路由', async () => {
  const f = await setup(h);
  expect(hasRoute(f.app, 'GET', LIST)).toBe(true);
  expect(hasRoute(f.app, 'PUT', ITEM)).toBe(true);
  for (const entry of ['api', 'stream'] as const) {
    const app = await (await factory())(entry, f.overrides);
    h.apps.push(app);
    await app.init();
    expect(hasRoute(app, 'GET', LIST)).toBe(false);
    expect(hasRoute(app, 'PUT', ITEM)).toBe(false);
  }
});
