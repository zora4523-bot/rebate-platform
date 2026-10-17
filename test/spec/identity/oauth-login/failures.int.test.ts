// B1-02d: request, attempt and exchange failures of the third-party logins (BR-ID-04 细则「提交时先校验、
// 后消费」「失败处理」「微信」「Apple」; AC-S1-67 ②③⑦⑧).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  LOGIN,
  accepted,
  client,
  fixture,
  loginBody,
  openOauthKit,
  closeOauthKit,
  rejected,
  rows,
  warnings,
  type OauthKit,
} from './kit.ts';

let kit: OauthKit;
beforeAll(async () => {
  kit = await openOauthKit();
}, 180_000);
afterAll(async () => {
  await closeOauthKit(kit);
});

const PROVIDERS = ['wechat', 'apple'] as const;

it.each(
  PROVIDERS.flatMap((provider) =>
    ['union_id', 'open_id', 'nickname', 'avatar', 'phone', 'nonce', 'uid', 'device_id'].map(
      (field) => ({ provider, field }),
    ),
  ),
)(
  '[AC-B1-02d#5][AC-S1-67#3][BR-ID-04] $provider 多带 $field 返回 20001，不建号、不消费尝试',
  async ({ provider, field }) => {
    const f = await fixture(kit);
    kit.exchange.mockResolvedValue({ union_id: `union-${randomUUID()}` });
    const attempt = await f.device.attempt(provider);
    const body = loginBody(provider, attempt.attempt_id);
    const before = await rows(f);
    const response = await f.device.post(LOGIN[provider], { ...body, [field]: 'client-value' });
    rejected(kit, LOGIN[provider], response, 20001);
    expect(kit.exchange).not.toHaveBeenCalled();
    expect(await rows(f)).toEqual(before);
    // Validation runs before the attempt is consumed: the same attempt still logs in.
    expect(
      accepted(kit, LOGIN[provider], await f.device.post(LOGIN[provider], body)).is_new_user,
    ).toBe(true);
  },
);

it.each(
  PROVIDERS.flatMap((provider) =>
    (provider === 'wechat'
      ? ['attempt_id', 'code', 'legal_versions', 'consent_at']
      : ['attempt_id', 'identity_token', 'authorization_code', 'legal_versions', 'consent_at']
    ).map((field) => ({ provider, field })),
  ),
)(
  '[AC-B1-02d#6][BR-ID-04] $provider 缺 $field 返回 20001 data.fields，不调换取',
  async ({ provider, field }) => {
    const f = await fixture(kit);
    const attempt = await f.device.attempt(provider);
    const body: Record<string, unknown> = { ...loginBody(provider, attempt.attempt_id) };
    delete body[field];
    const before = await rows(f);
    const response = await f.device.post(LOGIN[provider], body);
    rejected(kit, LOGIN[provider], response, 20001, {
      fields: expect.arrayContaining([field]) as unknown,
    });
    expect(kit.exchange).not.toHaveBeenCalled();
    expect(await rows(f)).toEqual(before);
  },
);

it.each(PROVIDERS)(
  '[AC-B1-02d#7][AC-S1-67#2][BR-ID-04] %s 尝试已用：第二次提交 20004，不再换取、不写任何行',
  async (provider) => {
    const f = await fixture(kit);
    kit.exchange.mockResolvedValue({ union_id: `union-${randomUUID()}` });
    const attempt = await f.device.attempt(provider);
    const body = loginBody(provider, attempt.attempt_id);
    accepted(kit, LOGIN[provider], await f.device.post(LOGIN[provider], body));
    const before = await rows(f);
    rejected(kit, LOGIN[provider], await f.device.post(LOGIN[provider], body), 20004);
    expect(kit.exchange).toHaveBeenCalledTimes(1);
    expect(await rows(f)).toEqual(before);
  },
);

it.each(PROVIDERS)(
  '[AC-B1-02d#8][AC-S1-67#7][BR-ID-04] %s 尝试过期 20004，不向第三方换取',
  async (provider) => {
    const f = await fixture(kit);
    kit.exchange.mockResolvedValue({ union_id: `union-${randomUUID()}` });
    const attempt = await f.device.attempt(provider);
    kit.clock.advanceMs(600_000);
    const before = await rows(f);
    rejected(
      kit,
      LOGIN[provider],
      await f.device.post(LOGIN[provider], loginBody(provider, attempt.attempt_id)),
      20004,
    );
    expect(kit.exchange).not.toHaveBeenCalled();
    expect(await rows(f)).toEqual(before);
  },
);

it.each(PROVIDERS)(
  '[AC-B1-02d#9][BR-ID-04] %s 尝试不存在 20004，不向第三方换取',
  async (provider) => {
    const f = await fixture(kit);
    rejected(
      kit,
      LOGIN[provider],
      await f.device.post(LOGIN[provider], loginBody(provider, randomUUID())),
      20004,
    );
    expect(kit.exchange).not.toHaveBeenCalled();
  },
);

it.each(PROVIDERS)(
  '[AC-B1-02d#10][BR-ID-04] %s 别的设备提交本设备的尝试 20004，不换取，原尝试仍可用',
  async (provider) => {
    const f = await fixture(kit);
    kit.exchange.mockResolvedValue({ union_id: `union-${randomUUID()}` });
    const attempt = await f.device.attempt(provider);
    const body = loginBody(provider, attempt.attempt_id);
    const other = await client(kit, f.appId);
    rejected(kit, LOGIN[provider], await other.post(LOGIN[provider], body), 20004);
    expect(kit.exchange).not.toHaveBeenCalled();
    expect(
      accepted(kit, LOGIN[provider], await f.device.post(LOGIN[provider], body)).is_new_user,
    ).toBe(true);
    expect(kit.exchange).toHaveBeenCalledTimes(1);
  },
);

it.each(PROVIDERS)(
  '[AC-B1-02d#11][BR-ID-04] %s 的尝试交给另一 provider 的登录 20004，不换取，原尝试仍可用',
  async (provider) => {
    const f = await fixture(kit);
    kit.exchange.mockResolvedValue({ union_id: `union-${randomUUID()}` });
    const attempt = await f.device.attempt(provider);
    const otherProvider = provider === 'wechat' ? 'apple' : 'wechat';
    rejected(
      kit,
      LOGIN[otherProvider],
      await f.device.post(LOGIN[otherProvider], loginBody(otherProvider, attempt.attempt_id)),
      20004,
    );
    expect(kit.exchange).not.toHaveBeenCalled();
    accepted(
      kit,
      LOGIN[provider],
      await f.device.post(LOGIN[provider], loginBody(provider, attempt.attempt_id)),
    );
  },
);

it.each(PROVIDERS)(
  '[AC-B1-02d#12][BR-ID-04] %s 签名错误在核对尝试之前拒绝，原尝试仍可用',
  async (provider) => {
    const f = await fixture(kit);
    kit.exchange.mockResolvedValue({ union_id: `union-${randomUUID()}` });
    const attempt = await f.device.attempt(provider);
    const body = loginBody(provider, attempt.attempt_id);
    // Establish the live route first: a 404 must never pass as the signature refusal.
    const probe = await f.device.post(LOGIN[provider], {});
    rejected(kit, LOGIN[provider], probe, 20001);
    const response = await f.device.post(LOGIN[provider], body, { 'x-sign': '0'.repeat(64) });
    expect(response.json()).toMatchObject({ code: 10401 });
    expect(kit.exchange).not.toHaveBeenCalled();
    accepted(kit, LOGIN[provider], await f.device.post(LOGIN[provider], body));
  },
);

it.each(PROVIDERS)(
  '[AC-B1-02d#13][AC-S1-67#2][BR-ID-04] %s 端口判凭证无效 20004：尝试已作废，不建号、不写同意、不签发',
  async (provider) => {
    const f = await fixture(kit);
    kit.exchange.mockResolvedValue({ invalid: true });
    const attempt = await f.device.attempt(provider);
    const body = loginBody(provider, attempt.attempt_id);
    const before = await rows(f);
    rejected(kit, LOGIN[provider], await f.device.post(LOGIN[provider], body), 20004);
    expect(await rows(f)).toEqual(before);
    kit.exchange.mockResolvedValue({ union_id: `union-${randomUUID()}` });
    rejected(kit, LOGIN[provider], await f.device.post(LOGIN[provider], body), 20004);
    expect(kit.exchange).toHaveBeenCalledTimes(1);
    expect(await rows(f)).toEqual(before);
  },
);

it.each(
  PROVIDERS.flatMap((provider) =>
    (['unavailable', 'throw', 'missing', 'empty'] as const).map((failure) => ({
      provider,
      failure,
    })),
  ),
)(
  '[AC-B1-02d#14][AC-S1-67#8][BR-ID-04] $provider 换取 $failure → 50305 data.provider，不建号、不写同意、尝试作废',
  async ({ provider, failure }) => {
    const f = await fixture(kit);
    const openId = `open-${randomUUID()}`;
    if (failure === 'throw') kit.exchange.mockRejectedValue(new Error('fixture provider timeout'));
    else if (failure === 'unavailable') kit.exchange.mockResolvedValue({ unavailable: true });
    else
      kit.exchange.mockResolvedValue(
        failure === 'missing' ? { open_id: openId } : { union_id: '', open_id: openId },
      );
    const attempt = await f.device.attempt(provider);
    const body = loginBody(provider, attempt.attempt_id);
    const before = await rows(f);
    const start = kit.lines.length;
    rejected(kit, LOGIN[provider], await f.device.post(LOGIN[provider], body), 50305, {
      provider,
    });
    expect(await rows(f)).toEqual(before);
    if (failure === 'missing' || failure === 'empty') {
      // AC-S1-67 ⑧: no account under the openid, one warn that names only the provider.
      const warned = warnings(kit, start).filter((line) => line['provider'] === provider);
      expect(warned.length).toBeGreaterThan(0);
      const logged = kit.lines.slice(start).join('\n');
      expect(logged).not.toContain(openId);
      const given = body as Record<string, unknown>;
      for (const key of ['code', 'identity_token', 'authorization_code']) {
        if (typeof given[key] === 'string') expect(logged).not.toContain(given[key]);
      }
      expect(logged).not.toContain(attempt.nonce);
    }
    kit.exchange.mockReset().mockResolvedValue({ union_id: `union-${randomUUID()}` });
    rejected(kit, LOGIN[provider], await f.device.post(LOGIN[provider], body), 20004);
    expect(kit.exchange).not.toHaveBeenCalled();
  },
);
