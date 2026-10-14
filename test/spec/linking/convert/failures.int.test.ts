import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { databaseFixture, failure, fixture, service } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each([
  ['absent', 30101],
  ['invalid', 30102],
] as const)(
  '[AC-B1-06i#7] 淘宝 %s → %i，返回完整授权数据，失败只写 convert 日志',
  async (binding, code) => {
    const f = await fixture(database(), 'taobao', binding);
    const convert = service(f);
    const result = await convert.convert(f.request());
    await failure(result, f, code, 422);
    expect(result.envelope.data).toMatchObject({
      auth_url: expect.stringMatching(/^https:\/\//),
      state: expect.any(String),
      auth_methods: ['web_code'],
    });
    const data = result.envelope.data as { state: string; auth_url: string };
    expect(new URL(data.auth_url).searchParams.get('state')).toBe(data.state);
    const rows = await f.links();
    expect(rows).toHaveLength(1);
    expect(await f.sessions()).toEqual([
      expect.objectContaining({
        state: data.state,
        app_id: f.appId,
        user_id: f.a,
        device_id: f.device,
        link_id: rows[0]!.link_id,
      }),
    ]);
    expect(f.f.fetch).not.toHaveBeenCalled();
  },
  60_000,
);

it('[AC-B1-06i#8] 拼多多未备案 → 30111，携带 auth_jump，不转链且不创建 attempt', async () => {
  const f = await fixture(database(), 'pdd', 'absent');
  const adapter = f.options.registry.get('pdd');
  const query = vi.spyOn(adapter, 'queryPddAuthority').mockResolvedValue({ authorized: false });
  const convert = service(f);
  const result = await convert.convert(f.request());
  await failure(result, f, 30111, 422);
  expect(result.envelope.data).toMatchObject({
    auth_jump: expect.objectContaining({ primary: expect.any(Object) }),
  });
  expect(query).toHaveBeenCalledTimes(1);
  expect(f.f.fetch).not.toHaveBeenCalled();
}, 60_000);

it.each(['taobao', 'pdd'] as const)(
  '[AC-B1-06i#9] %s blocked → 30153，不能通过 convert 绕过 open 的停用判定',
  async (platform) => {
    const f = await fixture(database(), platform, 'blocked');
    const convert = service(f);
    await failure(await convert.convert(f.request()), f, 30153, 422);
    expect(f.f.fetch).not.toHaveBeenCalled();
    expect(await f.sessions()).toEqual([]);
  },
  60_000,
);

it('[AC-B1-06i#10] 复核依赖失败 → 50303，不能把刚登记的价格当作成功', async () => {
  const f = await fixture(database());
  f.f.fetch.mockRejectedValue(new Error('synthetic recheck unavailable'));
  const convert = service(f);
  await failure(await convert.convert(f.request()), f, 50303, 503);
  expect(f.f.fetch).toHaveBeenCalled();
}, 60_000);

it('[AC-B1-06i#11] 平台转链开关关闭 → 50301，同 open 拒绝并记录 convert 失败', async () => {
  const f = await fixture(database());
  f.f.config.set('convert.enabled.jd', false);
  const convert = service(f);
  await failure(await convert.convert(f.request()), f, 50301, 503);
  expect(f.f.fetch).not.toHaveBeenCalled();
}, 60_000);

it('[AC-B1-06i#12] 游客 → 10001，不登记、不解析、不转链', async () => {
  const f = await fixture(database());
  f.opener(null);
  const convert = service(f);
  expect(await convert.convert(f.request())).toMatchObject({
    status: 401,
    envelope: { code: 10001 },
  });
  expect(await f.links()).toEqual([]);
  expect(await f.logs()).toEqual([]);
  expect(await f.attempts()).toEqual([]);
  expect(f.urlParser.parseUrl).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
}, 60_000);
