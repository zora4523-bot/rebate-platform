// F1-02zzq §9.3: GET /v1/config always sends nickname {min_len 1, max_len 16, monthly_limit 3}
// (BR-ID-39 / 05 B1-20), from server constants only, never from config_items. Container-only
// Fastify inject over an in-memory ContentStore; no database.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  NICKNAME_LOOKALIKES,
  expectNickname,
  harness,
  nicknameReads,
  success,
  warnings,
  type Harness,
  type Values,
} from './nickname-kit.ts';

function namesKey(entry: Record<string, unknown>, part: string): boolean {
  const key = entry['config_key'];
  return typeof key === 'string' && key.includes(part);
}

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.close();
});

it.each([
  ['最小有效配置', {}],
  [
    '非缺省可选键',
    {
      texts: { 'settings.nickname.hint': '运营文案' },
      'invite.backfill_hours': 0,
      'agent.enabled': true,
      'agent.whitelist_only': false,
      'claim.window_hours': 240,
      'config.lkg_max_age_sec': 60,
      'growth.invite_reward.eligibility_days': 45,
    },
  ],
  [
    '形状非法的可选键',
    {
      texts: { bad: 1 },
      'invite.backfill_hours': -1,
      'agent.guest_daily_quota': '3',
      'h5_release.canary': { version: '' },
      display: [],
    },
  ],
] satisfies [string, Values][])(
  '[AC-F1-02zzq#1] %s下 nickname 总是下发 {1, 16, 3} 整数且整体过契约',
  async (_label, values) => {
    const id = h.configured(values);
    const start = h.lines.length;
    const { data } = await success(h, id);
    expectNickname(data);
    expect(warnings(h, start, id).filter((entry) => namesKey(entry, 'nickname'))).toEqual([]);
  },
);

it.each(Object.entries(NICKNAME_LOOKALIKES))(
  '[AC-F1-02zzq#2] config_items 存在同名或近似键 %s=%j 时下发值不变，且不读该键',
  async (key, value) => {
    const id = h.configured({ [key]: value });
    const start = h.lines.length;
    const { data } = await success(h, id);
    expectNickname(data);
    expect(nicknameReads(h, id)).toEqual([]);
    expect(warnings(h, start, id).filter((entry) => namesKey(entry, key))).toEqual([]);
  },
);

it.each([
  ['null', null],
  ['字符串', '16'],
  ['数组', [1, 16, 3]],
  ['多余字段', { min_len: 1, max_len: 16, monthly_limit: 3, extra: true }],
  ['零与负数', { min_len: 0, max_len: -1, monthly_limit: 0 }],
] satisfies [string, Values[string]][])(
  '[AC-F1-02zzq#2] 同名键 nickname 为%s时仍 200、下发常量，不 warn 也不 50001',
  async (_label, value) => {
    const id = h.configured({ nickname: value });
    const start = h.lines.length;
    const { data } = await success(h, id);
    expectNickname(data);
    expect(nicknameReads(h, id)).toEqual([]);
    expect(
      warnings(h, start, id).filter((entry) => entry['event'] === 'content_config_value_invalid'),
    ).toEqual([]);
  },
);

it('[AC-F1-02zzq#3] 缓存过期后新增全部近似键：响应与 config_version 都不变', async () => {
  const id = h.configured({ texts: { preserved: 'fixture' } });
  const baseline = await success(h, id);
  expectNickname(baseline.data);
  h.update(id, NICKNAME_LOOKALIKES);
  h.clock.advanceMs(60_001);
  const after = await success(h, id);
  expectNickname(after.data);
  expect(after.data).toEqual(baseline.data);
  expect(after.response.headers['etag']).toBe(baseline.response.headers['etag']);
  expect(nicknameReads(h, id)).toEqual([]);
});

it('[AC-F1-02zzq#4] 两个 app 交替读取：nickname 相同，各自其余配置不受影响', async () => {
  const a = h.configured({ texts: { owner: 'a' }, ...NICKNAME_LOOKALIKES });
  const b = h.configured({ texts: { owner: 'b' }, nickname: { min_len: 4 } });
  for (const [id, owner] of [
    [a, 'a'],
    [b, 'b'],
    [a, 'a'],
  ] as const) {
    const { data } = await success(h, id);
    expectNickname(data);
    expect(data.texts).toEqual({ owner });
  }
  expect([...nicknameReads(h, a), ...nicknameReads(h, b)]).toEqual([]);
});
