// B1-02d: how the entry wires the exchange (ruling §9.3 #6): without a port (staging / prod until
// the real adapters exist) the login answers 50305; the test environment's own assembly uses the
// fake adapter; the attempt store being unavailable answers 50001 before any exchange.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ROOT } from '../../risk/signature/kit.ts';
import type { RedisHandle } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  LOGIN,
  accepted,
  fixture,
  loginBody,
  openOauthKit,
  closeOauthKit,
  rejected,
  rows,
} from './kit.ts';

const PROVIDERS = ['wechat', 'apple'] as const;

it('[AC-B1-02d#25][BR-ID-04] 未注入第三方身份端口 → 50305 data.provider，尝试作废，不建号', async () => {
  const kit = await openOauthKit('none');
  try {
    for (const provider of PROVIDERS) {
      const f = await fixture(kit);
      const attempt = await f.device.attempt(provider);
      const body = loginBody(provider, attempt.attempt_id);
      const before = await rows(f);
      rejected(kit, LOGIN[provider], await f.device.post(LOGIN[provider], body), 50305, {
        provider,
      });
      expect(await rows(f)).toEqual(before);
      rejected(kit, LOGIN[provider], await f.device.post(LOGIN[provider], body), 20004);
      expect(kit.exchange).not.toHaveBeenCalled();
    }
  } finally {
    await closeOauthKit(kit);
  }
}, 180_000);

it('[AC-B1-02d#26][BR-ID-04] 测试环境的入口装配假适配器：约定凭证登录建号，非约定凭证 50305', async () => {
  const kit = await openOauthKit('assembled');
  try {
    for (const provider of PROVIDERS) {
      const f = await fixture(kit);
      const unionId = `fixture${randomUUID().replaceAll('-', '')}`;
      const fake = `fake:${provider}:${unionId}`;
      const given =
        provider === 'wechat' ? { code: fake } : { identity_token: fake, authorization_code: fake };
      const attempt = await f.device.attempt(provider);
      const data = accepted(
        kit,
        LOGIN[provider],
        await f.device.post(LOGIN[provider], loginBody(provider, attempt.attempt_id, given)),
      );
      expect(data.is_new_user).toBe(true);
      expect((await rows(f)).oauth).toEqual([
        expect.objectContaining({ user_id: data.user_id, provider, union_id: unionId }),
      ]);
      const unknown = await f.device.attempt(provider);
      rejected(
        kit,
        LOGIN[provider],
        await f.device.post(LOGIN[provider], loginBody(provider, unknown.attempt_id)),
        50305,
        { provider },
      );
    }
    expect(kit.exchange).not.toHaveBeenCalled();
  } finally {
    await closeOauthKit(kit);
  }
}, 180_000);

it('[AC-B1-02d#27][BR-ID-04] 尝试存储不可用 → 50001，不向第三方换取、不建号', async () => {
  const kit = await openOauthKit();
  try {
    const f = await fixture(kit);
    kit.exchange.mockResolvedValue({ union_id: `union-${randomUUID()}` });
    const attempt = await f.device.attempt('wechat');
    const body = loginBody('wechat', attempt.attempt_id);
    // Establish the live route first: a 404 must never pass as the store refusal.
    rejected(kit, LOGIN.wechat, await f.device.post(LOGIN.wechat, {}), 20001);
    const { REDIS } = (await import(
      new URL('apps/api/src/modules/platform/index.ts', ROOT).href
    )) as typeof import('../../../../apps/api/src/modules/platform/index.ts');
    await kit.app.get<RedisHandle>(REDIS).close();
    const before = await rows(f);
    rejected(kit, LOGIN.wechat, await f.device.post(LOGIN.wechat, body), 50001);
    expect(kit.exchange).not.toHaveBeenCalled();
    expect(await rows(f)).toEqual(before);
  } finally {
    await closeOauthKit(kit);
  }
}, 180_000);
