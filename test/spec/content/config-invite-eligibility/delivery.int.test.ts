// F1-02zze: container-only Fastify inject, real content assembly and in-memory ContentStore.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  AMOUNT,
  DAYS,
  ENABLED,
  harness,
  read,
  success,
  warnings,
  type Harness,
  type Values,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.close();
});

it.each([
  ['开关缺失', {}, 2000, false],
  ['开关 off', { [ENABLED]: false }, 2000, false],
  ['开关 on 且预算足', { [ENABLED]: true }, 1000, true],
  ['开关 on 但预算不足', { [ENABLED]: true }, 999, false],
] satisfies [string, Values, number, boolean][])(
  '[AC-F1-02zze#5] %s，资格缺行仍下发 30 且不记配置 warn',
  async (_label, values, budget, enabled) => {
    const id = h.configured({ ...values, [AMOUNT]: 500 }, budget);
    const start = h.lines.length;
    const { data } = await success(h, id);
    expect(data.invite).toMatchObject({
      eligibility_days: 30,
      reward_enabled: enabled,
      reward_amount_fen: 500,
    });
    expect(
      warnings(h, start, id).filter((entry) => entry['event'] === 'content_config_value_invalid'),
    ).toEqual([]);
  },
);

it.each(['omitted', 'null'] as const)(
  '[AC-F1-02zze#6] 预算端口%s，开关 on 仍下发配置的 45 天',
  async (port) => {
    const isolated = await harness(port);
    try {
      const id = isolated.configured({ [ENABLED]: true, [AMOUNT]: 500, [DAYS]: 45 });
      const { data } = await success(isolated, id);
      expect(data.invite).toMatchObject({
        eligibility_days: 45,
        reward_enabled: false,
        reward_amount_fen: 500,
      });
      expect(isolated.available).not.toHaveBeenCalled();
    } finally {
      await isolated.close();
    }
  },
);

it.each([false, true])(
  '[AC-F1-02zze#7] 开关 %s 时读配置 45，忽略同名键，保留其他 invite 字段和奖励两键',
  async (enabled) => {
    const values: Values = {
      [ENABLED]: enabled,
      [AMOUNT]: 500,
      'invite.backfill_hours': 72,
      'invite.bind_phone_guide': false,
      'invite.before_buy_tip': false,
      'invite.eligibility_days': 7,
      texts: { preserved: 'fixture' },
    };
    const id = h.configured(values, 1000);
    const baseline = await success(h, id);
    expect(baseline.data.invite).toEqual({
      required: false,
      backfill_hours: 72,
      bind_phone_guide: false,
      before_buy_tip: false,
      reward_enabled: enabled,
      reward_amount_fen: 500,
      eligibility_days: 30,
    });
    h.update(id, { [DAYS]: 45 });
    h.clock.advanceMs(60_001);
    const changed = await success(h, id);
    expect(changed.data.invite.eligibility_days).toBe(45);
    expect({
      ...changed.data,
      config_version: baseline.data.config_version,
      invite: { ...changed.data.invite, eligibility_days: 30 },
    }).toEqual(baseline.data);
    const keys = h.reads.filter((entry) => entry.appId === id).map((entry) => entry.key);
    expect(keys.filter((key) => key === DAYS)).toHaveLength(2);
    expect(keys).not.toContain('invite.eligibility_days');
    expect(h.queries.join('\n')).not.toContain('invite_rewards');
  },
);

it.each([
  ['零', 0],
  ['负数', -1],
  ['超上限', 3651],
  ['int32 上限', 2147483647],
  ['小数', 30.5],
  ['NaN', Number.NaN],
  ['正无穷', Number.POSITIVE_INFINITY],
  ['负无穷', Number.NEGATIVE_INFINITY],
  ['字符串', '30'],
  ['null', null],
  ['布尔', true],
  ['数组', []],
  ['对象', {}],
] satisfies [string, Values[string]][])(
  '[AC-F1-02zze#8] HTTP 非法值%s仍为 200、30 天，warn 恰一条且指明 app_id 和键',
  async (_label, value) => {
    const id = h.configured({ [DAYS]: value, [ENABLED]: true, [AMOUNT]: 500 }, 1000);
    const start = h.lines.length;
    const { data } = await success(h, id);
    expect(data.invite).toMatchObject({
      eligibility_days: 30,
      reward_enabled: true,
      reward_amount_fen: 500,
    });
    const logs = warnings(h, start, id).filter(
      (entry) => entry['event'] === 'content_config_value_invalid',
    );
    expect(logs).toEqual([
      expect.objectContaining({
        level: 40,
        event: 'content_config_value_invalid',
        config_key: DAYS,
        app_id: id,
      }),
    ]);
  },
);

it('[AC-F1-02zze#9] 45 改 60：60 秒内缓存不变，过期后旧 ETag 得 200，新 ETag 得 304', async () => {
  const id = h.configured({ [DAYS]: 45, [ENABLED]: true, [AMOUNT]: 500 }, 1000);
  const first = await success(h, id);
  expect(first.data.invite.eligibility_days).toBe(45);
  const firstTag = `"${first.data.config_version}"`;
  h.update(id, { [DAYS]: 60 });
  h.clock.advanceMs(59_999);
  const cached = await success(h, id);
  expect(cached.data).toEqual(first.data);
  const same = await read(h, id, { 'if-none-match': firstTag });
  expect(same.statusCode).toBe(304);
  expect(same.body).toBe('');
  expect(same.headers['etag']).toBe(firstTag);
  expect(h.reads.filter((entry) => entry.appId === id && entry.key === DAYS)).toHaveLength(1);

  h.clock.advanceMs(2);
  const changed = await success(h, id, { 'if-none-match': firstTag });
  expect(changed.data.invite.eligibility_days).toBe(60);
  expect(changed.data.config_version).not.toBe(first.data.config_version);
  expect({
    ...changed.data,
    config_version: first.data.config_version,
    invite: { ...changed.data.invite, eligibility_days: 45 },
  }).toEqual(first.data);
  expect(h.reads.filter((entry) => entry.appId === id && entry.key === DAYS)).toHaveLength(2);
  const nextTag = `"${changed.data.config_version}"`;
  // Even after a fresh read, the unchanged final data has the same version.
  h.clock.advanceMs(60_001);
  const unchanged = await read(h, id, { 'if-none-match': nextTag });
  expect(unchanged.statusCode).toBe(304);
  expect(unchanged.body).toBe('');
  expect(unchanged.headers['etag']).toBe(nextTag);
});

it('[AC-F1-02zze#10] 两个 app 交替读取资格、金额、开关与 ETag 各自隔离', async () => {
  const a = h.configured({ [DAYS]: 45, [AMOUNT]: 500, [ENABLED]: true }, 1000);
  const b = h.configured({ [DAYS]: 60, [AMOUNT]: 750, [ENABLED]: false }, 2000);
  const versions = new Map<string, string | undefined>();
  for (const [id, days, amount, enabled] of [
    [a, 45, 500, true],
    [b, 60, 750, false],
    [a, 45, 500, true],
    [b, 60, 750, false],
  ] as const) {
    const { data } = await success(h, id);
    expect(data.invite).toMatchObject({
      eligibility_days: days,
      reward_amount_fen: amount,
      reward_enabled: enabled,
    });
    if (versions.has(id)) expect(data.config_version).toBe(versions.get(id));
    versions.set(id, data.config_version);
  }
  expect(versions.get(a)).not.toBe(versions.get(b));
  expect(h.reads.filter((entry) => entry.key === DAYS && [a, b].includes(entry.appId))).toEqual([
    { appId: a, key: DAYS },
    { appId: b, key: DAYS },
  ]);
});
