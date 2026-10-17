// B1-02d ruling §9.3 #6 (D6): the fake third-party identity adapter, local / test only, and the
// entry's choice of port. The fake reads only its own convention and imitates no provider's
// messages: `fake:<provider>:<identity>` logs in as <identity>; the reserved identities
// `invalid`, `unavailable` and `no-union` answer invalid, unavailable and an answer without a
// union_id; anything else is unavailable (no identity is ever invented).
import { expect, it, vi } from 'vitest';
import { ROOT } from '../../risk/signature/kit.ts';

type Answer = Record<string, unknown>;
type Port = { exchange(input: object): Promise<Answer> };
interface FakeModule {
  createFakeThirdPartyIdentity(appEnv: string): Port;
  createThirdPartyIdentity(appEnv: string, logger: { warn(...args: unknown[]): void }): Port | null;
}
async function load(): Promise<FakeModule> {
  return (await import(
    new URL('apps/api/src/modules/identity/infra/fake-third-party-identity.ts', ROOT).href
  )) as unknown as FakeModule;
}
const NONCE = 'ab'.repeat(32);
function wechat(code: string) {
  return { provider: 'wechat', code, nonce: NONCE };
}
function apple(identityToken: string, authorizationCode = identityToken) {
  return {
    provider: 'apple',
    identity_token: identityToken,
    authorization_code: authorizationCode,
    nonce: NONCE,
  };
}

it.each(['local', 'test'])(
  '[AC-B1-02d#28][BR-ID-04] %s 假适配器按约定凭证返回身份；微信不带 Apple refresh_token',
  async (appEnv) => {
    const { createFakeThirdPartyIdentity } = await load();
    const port = createFakeThirdPartyIdentity(appEnv);
    const answer = await port.exchange(wechat('fake:wechat:u123'));
    expect(answer).toMatchObject({ union_id: 'u123' });
    expect(answer).not.toHaveProperty('apple_refresh_token');
    expect(answer['open_id']).not.toBe('u123');
  },
);

it('[AC-B1-02d#29][BR-ID-04] 假适配器 Apple：两个凭证主体一致才返回身份与 refresh_token，不一致 invalid', async () => {
  const { createFakeThirdPartyIdentity } = await load();
  const port = createFakeThirdPartyIdentity('test');
  const answer = await port.exchange(apple('fake:apple:s456'));
  expect(answer).toMatchObject({ union_id: 's456', apple_refresh_token: expect.any(String) });
  expect(answer['apple_refresh_token']).not.toBe('');
  expect(await port.exchange(apple('fake:apple:s456', 'fake:apple:other'))).toEqual({
    invalid: true,
  });
});

it.each([
  { provider: 'wechat', input: wechat('fake:wechat:invalid'), expected: { invalid: true } },
  { provider: 'wechat', input: wechat('fake:wechat:unavailable'), expected: { unavailable: true } },
  { provider: 'apple', input: apple('fake:apple:invalid'), expected: { invalid: true } },
  { provider: 'apple', input: apple('fake:apple:unavailable'), expected: { unavailable: true } },
  { provider: 'wechat', input: wechat('fake:apple:u1'), expected: { invalid: true } },
  { provider: 'wechat', input: wechat('test-wechat-credential'), expected: { unavailable: true } },
  { provider: 'apple', input: apple('fixture-token'), expected: { unavailable: true } },
])(
  '[AC-B1-02d#30][BR-ID-04] 假适配器 $provider 约定值与非约定凭证：%#',
  async ({ input, expected }) => {
    const { createFakeThirdPartyIdentity } = await load();
    expect(await createFakeThirdPartyIdentity('test').exchange(input)).toEqual(expected);
  },
);

it.each([{ input: wechat('fake:wechat:no-union') }, { input: apple('fake:apple:no-union') }])(
  '[AC-B1-02d#31][BR-ID-04] 假适配器 no-union 返回不带 union_id 的成功形状：%#',
  async ({ input }) => {
    const { createFakeThirdPartyIdentity } = await load();
    const answer = await createFakeThirdPartyIdentity('test').exchange(input);
    expect(answer).not.toHaveProperty('invalid');
    expect(answer).not.toHaveProperty('unavailable');
    expect(answer['union_id'] ?? '').toBe('');
  },
);

it.each(['staging', 'prod'])(
  '[AC-B1-02d#32][BR-ID-04] %s 不能构造假适配器；入口不注入端口并告警一次',
  async (appEnv) => {
    const { createFakeThirdPartyIdentity, createThirdPartyIdentity } = await load();
    expect(() => createFakeThirdPartyIdentity(appEnv)).toThrow(Error);
    expect(() => createFakeThirdPartyIdentity(appEnv)).not.toThrow(/NotImplemented/);
    const warn = vi.fn();
    expect(createThirdPartyIdentity(appEnv, { warn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat()).toContain('third_party_identity_unconfigured');
  },
);

it.each(['local', 'test'])(
  '[AC-B1-02d#33][BR-ID-04] %s 入口注入假适配器且不告警',
  async (appEnv) => {
    const { createThirdPartyIdentity } = await load();
    const warn = vi.fn();
    const port = createThirdPartyIdentity(appEnv, { warn });
    expect(port).not.toBeNull();
    expect(await port!.exchange(wechat('fake:wechat:u789'))).toMatchObject({ union_id: 'u789' });
    expect(warn).not.toHaveBeenCalled();
  },
);
