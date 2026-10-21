// F1-02zp §9: HTTP assembly tests run only by the orchestrator. No database or socket is opened.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  AMOUNT,
  ENABLED,
  harness,
  read,
  success,
  warnings,
  type Harness,
  type Values,
} from './kit.ts';

// F1-02zzd: F1-02zze adds invite.eligibility_days (BR-INV-18 / BR-INV-24 细则: missing row reads
// as 30). No case here writes growth.invite_reward.eligibility_days, so it must be exactly 30; the
// rest is returned for the original exact comparison. F1-02zzf：过渡已收紧, the key must be delivered.
function withoutEligibilityDays(invite: object): Record<string, unknown> {
  const all = invite as Record<string, unknown>;
  expect(Object.hasOwn(all, 'eligibility_days'), 'invite.eligibility_days delivered').toBe(true);
  const { eligibility_days, ...rest } = all;
  expect(eligibility_days, 'invite.eligibility_days').toBe(30);
  return rest;
}

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.close();
});

it.each([
  ['缺失', {}, false],
  ['false', { [ENABLED]: false }, false],
  ['字符串 true', { [ENABLED]: 'true' }, true],
  ['数字 1', { [ENABLED]: 1 }, true],
  ['字符串 on', { [ENABLED]: 'on' }, true],
  ['null', { [ENABLED]: null }, true],
] satisfies [string, Values, boolean][])(
  '[AC-F1-02zp#6] HTTP 开关%s总下发两字段、保留金额、不调用预算端口',
  async (_label, values, invalid) => {
    const id = h.configured({ ...values, [AMOUNT]: 500 });
    const calls = h.available.mock.calls.length;
    const start = h.lines.length;
    const { data } = await success(h, id);
    expect(data.invite).toMatchObject({ reward_enabled: false, reward_amount_fen: 500 });
    expect(h.available.mock.calls).toHaveLength(calls);
    const logs = warnings(h, start, id);
    expect(logs).toHaveLength(invalid ? 1 : 0);
    if (invalid) {
      expect(logs[0]).toMatchObject({
        event: 'content_config_value_invalid',
        config_key: ENABLED,
        app_id: id,
      });
    }
  },
);

it.each([
  [1000, 1999, false],
  [1000, 2000, true],
  [500, 999, false],
  [500, 1000, true],
  [0, -1, false],
  [0, 0, true],
  [2147483647, 4294967293, false],
  [2147483647, 4294967294, true],
] as const)(
  '[AC-F1-02zp#7] HTTP 每方 %s 分、总预算可用额 %s 分，活动有效为 %s',
  async (amount, available, enabled) => {
    const id = h.configured({ [ENABLED]: true, [AMOUNT]: amount }, available);
    const calls = h.available.mock.calls.length;
    const queryStart = h.queries.length;
    const { data } = await success(h, id);
    expect(data.invite).toMatchObject({ reward_enabled: enabled, reward_amount_fen: amount });
    expect(h.available.mock.calls.slice(calls)).toEqual([[id]]);
    expect(h.queries.slice(queryStart).join('\n')).not.toContain('invite_reward_budgets');
    expect(h.reads.filter((entry) => entry.appId === id).map((entry) => entry.key)).toEqual(
      expect.arrayContaining([ENABLED, AMOUNT]),
    );
  },
);

it.each([
  ['缺失', {}, false],
  ['负数', { [AMOUNT]: -1 }, true],
  ['超过 int32', { [AMOUNT]: 2147483648 }, true],
  ['字符串', { [AMOUNT]: '1000' }, true],
  ['小数', { [AMOUNT]: 10.5 }, true],
  ['null', { [AMOUNT]: null }, true],
] satisfies [string, Values, boolean][])(
  '[AC-F1-02zp#8] HTTP 金额%s回退 1000 并按双方面额判断，缺失不记 warn',
  async (_label, values, invalid) => {
    for (const [available, enabled] of [
      [1999, false],
      [2000, true],
    ] as const) {
      const id = h.configured({ ...values, [ENABLED]: true }, available);
      const start = h.lines.length;
      const { data } = await success(h, id);
      expect(data.invite).toMatchObject({ reward_enabled: enabled, reward_amount_fen: 1000 });
      const logs = warnings(h, start, id);
      expect(logs).toHaveLength(invalid ? 1 : 0);
      if (invalid) {
        expect(logs[0]).toMatchObject({
          event: 'content_config_value_invalid',
          app_id: id,
          config_key: AMOUNT,
        });
      }
    }
  },
);

it.each(['omitted', 'null'] as const)(
  '[AC-F1-02zp#9] HTTP 预算端口%s时开关 true 也禁用奖励，仍下发配置金额',
  async (port) => {
    const isolated = await harness(port);
    try {
      for (const amount of [0, 500, 1000]) {
        const id = isolated.configured({ [ENABLED]: true, [AMOUNT]: amount });
        const { data } = await success(isolated, id);
        expect(data.invite).toMatchObject({ reward_enabled: false, reward_amount_fen: amount });
        expect(isolated.available).not.toHaveBeenCalled();
      }
    } finally {
      await isolated.close();
    }
  },
);

it('[AC-F1-02zp#10] HTTP 全部缺失时仍下发 false 与 1000，且不查预算、不记配置 warn', async () => {
  const id = h.configured();
  const calls = h.available.mock.calls.length;
  const start = h.lines.length;
  const { data } = await success(h, id);
  expect(data.invite).toMatchObject({ reward_enabled: false, reward_amount_fen: 1000 });
  expect(h.available.mock.calls).toHaveLength(calls);
  expect(warnings(h, start, id)).toEqual([]);
});

it.each([
  ['null', null, false],
  ['小数', 1.5, true],
  ['超过门槛的小数', 2000.5, true],
  ['NaN', Number.NaN, true],
  ['无限大', Number.POSITIVE_INFINITY, true],
  ['抛错', new Error('synthetic budget unavailable'), true],
] as const)(
  '[AC-F1-02zp#11] HTTP 预算端口返回%s，仍为 200、奖励禁用，非法结果或异常 warn 一条',
  async (_label, available, mustWarn) => {
    const id = h.configured({ [ENABLED]: true }, available);
    const start = h.lines.length;
    const calls = h.available.mock.calls.length;
    const { data } = await success(h, id);
    expect(data.invite).toMatchObject({ reward_enabled: false, reward_amount_fen: 1000 });
    expect(h.available.mock.calls.slice(calls)).toEqual([[id]]);
    if (mustWarn) {
      const logs = warnings(h, start, id);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ app_id: id, event: expect.any(String) });
    }
  },
);

it('[AC-F1-02zp#12] 总预算跨过阈值改变 config_version，未变化的 If-None-Match 仍返回 304', async () => {
  const id = h.configured({ [ENABLED]: true }, 2000);
  const first = await success(h, id);
  expect(first.data.invite).toMatchObject({ reward_enabled: true, reward_amount_fen: 1000 });
  const firstTag = `"${first.data.config_version}"`;
  let calls = h.available.mock.calls.length;
  const same = await read(h, id, { 'if-none-match': firstTag });
  expect(same.statusCode).toBe(304);
  expect(same.body).toBe('');
  expect(same.headers['etag']).toBe(firstTag);
  expect(h.available.mock.calls.length - calls).toBeLessThanOrEqual(1);

  h.balances.set(id, 1999);
  // §9.2 permits a short cache up to ContentReader's existing 60-second lifetime.
  h.clock.advanceMs(60_000);
  calls = h.available.mock.calls.length;
  const depleted = await success(h, id, { 'if-none-match': firstTag });
  expect(depleted.data.invite).toMatchObject({ reward_enabled: false, reward_amount_fen: 1000 });
  expect(depleted.data.config_version).not.toBe(first.data.config_version);
  expect(h.available.mock.calls.slice(calls)).toEqual([[id]]);
  expect({
    ...depleted.data,
    config_version: first.data.config_version,
    invite: { ...depleted.data.invite, reward_enabled: true },
  }).toEqual(first.data);
  const depletedTag = `"${depleted.data.config_version}"`;
  const stillDepleted = await read(h, id, { 'if-none-match': depletedTag });
  expect(stillDepleted.statusCode).toBe(304);
  expect(stillDepleted.body).toBe('');
  expect(stillDepleted.headers['etag']).toBe(depletedTag);

  h.balances.set(id, 2000);
  h.clock.advanceMs(60_000);
  const restored = await success(h, id, { 'if-none-match': depletedTag });
  expect(restored.data.invite.reward_enabled).toBe(true);
  expect(restored.data.config_version).toBe(first.data.config_version);
});

it('[AC-F1-02zp#13] 同名键和预算配置不能覆盖派生值，既有 invite 字段仍保持原值', async () => {
  const poison: Values = {
    'invite.reward_enabled': true,
    'invite.reward_amount_fen': 1,
    'growth.invite_reward.total_budget_fen': 999999,
    'growth.invite_reward.daily_budget_fen': 999999,
    'invite.backfill_hours': 72,
    'invite.bind_phone_guide': false,
    'invite.before_buy_tip': false,
    texts: { preserved: 'fixture' },
  };
  const id = h.configured({ ...poison, [ENABLED]: true, [AMOUNT]: 500 }, 999);
  const { data } = await success(h, id);
  // F1-02zzd: the third key is checked and set aside (F1-02zzf：过渡已收紧).
  expect(withoutEligibilityDays(data.invite)).toEqual({
    required: false,
    backfill_hours: 72,
    bind_phone_guide: false,
    before_buy_tip: false,
    reward_enabled: false,
    reward_amount_fen: 500,
  });
  expect(data.texts).toEqual({ preserved: 'fixture' });
  const keys = h.reads.filter((entry) => entry.appId === id).map((entry) => entry.key);
  expect(keys).not.toContain('invite.reward_enabled');
  expect(keys).not.toContain('invite.reward_amount_fen');

  const enabled = h.configured(
    {
      [ENABLED]: true,
      [AMOUNT]: 500,
      'invite.reward_enabled': false,
      'invite.reward_amount_fen': 0,
      'growth.invite_reward.daily_budget_fen': 0,
      'growth.invite_reward.total_budget_fen': 0,
    },
    1000,
  );
  expect((await success(h, enabled)).data.invite).toMatchObject({
    reward_enabled: true,
    reward_amount_fen: 500,
  });
});

it('[AC-F1-02zp#14] 交替请求 app_id 时预算与金额各自隔离，每请求最多一次端口调用', async () => {
  const a = h.configured({ [ENABLED]: true, [AMOUNT]: 500 }, 1000);
  const b = h.configured({ [ENABLED]: true, [AMOUNT]: 1000 }, 1999);
  for (const [id, enabled, amount] of [
    [a, true, 500],
    [b, false, 1000],
    [a, true, 500],
    [b, false, 1000],
  ] as const) {
    const calls = h.available.mock.calls.length;
    const { data } = await success(h, id);
    expect(data.invite).toMatchObject({ reward_enabled: enabled, reward_amount_fen: amount });
    const newCalls = h.available.mock.calls.slice(calls);
    expect(newCalls.length).toBeLessThanOrEqual(1);
    for (const call of newCalls) expect(call).toEqual([id]);
  }
  expect(h.available.mock.calls).toEqual(expect.arrayContaining([[a], [b]]));
});
