import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  account,
  apiRequire,
  fixture,
  login,
  row,
  signedIn,
  totp,
  useHarness,
  wrongCode,
} from '../auth/kit.ts';
import { wrong } from '../../identity/sms-codes/kit.ts';
import { error, lastCode, ME, ok, SEND, sender, setup, STEP, type Grant, type Me } from './kit.ts';

const h = useHarness();

it('[AC-F1-06l#14] 动态码档无需验证手机号，令牌不透明、随机、记档位且由 Clock 决定五分钟期限', async () => {
  const s = await setup(h, false);
  s.f.clock.advanceMs(30_000);
  const first = await ok<Grant>(await s.step('totp', totp(s.a.secret, s.f.clock)), STEP);
  expect(first).toEqual({
    tier: 'totp',
    step_up_token: expect.any(String),
    expire_at: new Date(s.f.clock.now().getTime() + 300_000).toISOString(),
  });
  expect(first.step_up_token.length).toBeGreaterThanOrEqual(22);
  expect(first.step_up_token).not.toContain('.');
  expect(first.step_up_token).not.toContain(s.a.id);
  s.f.clock.advanceMs(30_000);
  const second = await ok<Grant>(await s.step('totp', totp(s.a.secret, s.f.clock)), STEP);
  expect(second.step_up_token).not.toBe(first.step_up_token);
  expect(second.expire_at).toBe(new Date(s.f.clock.now().getTime() + 300_000).toISOString());
}, 30_000);

it('[AC-F1-06l#15] 登录用过的 TOTP 不能用于 step-up，step-up 的 PG 防重放跨入口实例共享', async () => {
  const s = await setup(h, false);
  await error(await s.step('totp', totp(s.a.secret, s.f.clock)), STEP, 20002);
  s.f.clock.advanceMs(30_000);
  const code = totp(s.a.secret, s.f.clock);
  await ok(await s.step('totp', code), STEP);
  expect((await row(h, s.a)).totp_last_step).toBe(
    BigInt(Math.floor(s.f.clock.now().getTime() / 30_000)),
  );
  const next = await fixture(h, { probes: true });
  next.clock.advanceMs(30_000);
  await error(await next.post('/step-up', { tier: 'totp', code }, s.headers), STEP, 20002);
}, 30_000);

it('[AC-F1-06l#16] 同一动态码并发只签发一枚令牌，另一请求为 20002 无 reason', async () => {
  const s = await setup(h, false);
  s.f.clock.advanceMs(30_000);
  const code = totp(s.a.secret, s.f.clock);
  const responses = await Promise.all([s.step('totp', code), s.step('totp', code)]);
  expect(responses.map((r) => r.json().code).sort((a, b) => a - b)).toEqual([0, 20002]);
  for (const response of responses)
    await (response.json().code === 0 ? ok(response, STEP) : error(response, STEP, 20002));
}, 30_000);

it('[AC-F1-06l#17] 两档错码与登录共用失败计数，第五次锁定后同账号全部会话为 10001', async () => {
  const s = await setup(h);
  s.f.clock.advanceMs(30_000);
  const secondSession = await signedIn(s.f, s.a);
  await ok(await s.send(), SEND);
  const smsWrong = wrong(lastCode(s.f));
  const passwordFailure = await s.f.post('/login', {
    username: s.a.username,
    password: randomBytes(24).toString('base64url'),
  });
  expect(passwordFailure.json().code).toBe(10008);
  expect((await row(h, s.a)).failed_login_count).toBe(1);
  for (const [index, tier] of (['totp', 'sms', 'totp'] as const).entries()) {
    await error(
      await s.step(tier, tier === 'sms' ? smsWrong : wrongCode(s.a.secret, s.f.clock)),
      STEP,
      20002,
    );
    expect((await row(h, s.a)).failed_login_count).toBe(index + 2);
    expect((await row(h, s.a)).locked_until).toBeNull();
  }
  // The fifth wrong code still returns 20002; subsequent requests see the account lock.
  await error(await s.step('sms', smsWrong), STEP, 20002);
  expect((await row(h, s.a)).failed_login_count).toBe(5);
  for (const token of [s.session.admin_token, secondSession.admin_token]) {
    await error(await s.f.read(token), ME, 10001);
    await error(
      await s.f.post(
        '/step-up',
        { tier: 'totp', code: totp(s.a.secret, s.f.clock) },
        { authorization: `Bearer ${token}` },
      ),
      STEP,
      10001,
    );
    await error(
      await s.f.post('/step-up/sms-codes', {}, { authorization: `Bearer ${token}` }),
      SEND,
      10001,
    );
  }
}, 30_000);

it('[AC-F1-06l#18] 短信码按账号隔离，账号甲的码不能替账号乙签发令牌', async () => {
  const first = await setup(h);
  const second = await setup(h);
  await ok(await first.send(), SEND);
  const code = lastCode(first.f);
  await error(await second.step('sms', code), STEP, 20003);
  expect((await ok<Grant>(await first.step('sms', code), STEP)).tier).toBe('sms');
  expect(sender(first.f).outbox()).toHaveLength(1);
}, 30_000);

it('[AC-F1-06l#19] 三个真实接口均要求后台会话；login_ticket 不能代替 admin_token', async () => {
  const s = await setup(h);
  // Establish real routes first; a fixture probe or missing route cannot make this test pass.
  expect((await ok<Me>(await s.f.read(s.session.admin_token), ME)).admin_id).toBe(s.a.id);
  await ok(await s.send(), SEND);
  expect((await ok<Grant>(await s.step('sms', lastCode(s.f)), STEP)).tier).toBe('sms');
  const pending = await login(s.f, await account(h));
  for (const token of ['', pending.login_ticket]) {
    const headers = token === '' ? {} : { authorization: `Bearer ${token}` };
    await error(await s.f.app.inject({ method: 'GET', url: ME, headers }), ME, 10001);
    await error(await s.f.post('/step-up/sms-codes', {}, headers), SEND, 10001);
    await error(await s.f.post('/step-up', { tier: 'sms', code: '000000' }, headers), STEP, 10001);
  }
}, 30_000);

it('[AC-F1-06l#20] Redis 不保存明文短信码，新入口实例仍能验证已发送的码', async () => {
  const s = await setup(h);
  // Container-only read of the disposable Redis. No production credentials or network.
  interface Reader {
    scan(cursor: string): Promise<[string, string[]]>;
    type(key: string): Promise<string>;
    get(key: string): Promise<string | null>;
    quit(): Promise<unknown>;
  }
  const Redis = apiRequire('ioredis') as new (url: string, options: object) => Reader;
  const redis = new Redis(h.redis.url, { maxRetriesPerRequest: 0, connectTimeout: 1000 });
  const snapshot = async () => {
    const values = new Map<string, string>();
    let cursor = '0';
    do {
      const page = await redis.scan(cursor);
      cursor = page[0];
      for (const key of page[1]) {
        if ((await redis.type(key)) === 'string') values.set(key, (await redis.get(key)) ?? '');
      }
    } while (cursor !== '0');
    return values;
  };
  try {
    const before = await snapshot();
    await ok(await s.send(), SEND);
    const code = lastCode(s.f);
    const after = await snapshot();
    const changed = [...after].filter(([key, value]) => before.get(key) !== value);
    expect(changed.length).toBeGreaterThan(0);
    const containsPlainCode = (value: unknown): boolean => {
      if (value === code || (typeof value === 'number' && String(value) === code)) return true;
      return (
        value !== null && typeof value === 'object' && Object.values(value).some(containsPlainCode)
      );
    };
    for (const [, value] of changed) {
      let decoded: unknown = value;
      try {
        decoded = JSON.parse(value) as unknown;
      } catch {
        // Raw Redis strings are compared as whole values, never as substrings of hashes.
      }
      expect(containsPlainCode(decoded)).toBe(false);
    }
    const restarted = await fixture(h, { probes: true });
    const response = await restarted.post('/step-up', { tier: 'sms', code }, s.headers);
    expect((await ok<Grant>(response, STEP)).tier).toBe('sms');
  } finally {
    await redis.quit();
  }
}, 30_000);

it.each(['sms', 'totp'] as const)(
  '[AC-F1-06l#33] %s 档提交另一档的有效码返回 20002、不签令牌且计入失败',
  async (tier) => {
    const s = await setup(h);
    s.f.clock.advanceMs(30_000);
    await ok(await s.send(), SEND);
    const sentAt = s.f.clock.now().getTime();
    const smsCode = lastCode(s.f);
    // Avoid accidental equality with any accepted TOTP window, including the login step.
    while ([-1, 0, 1].some((delta) => totp(s.a.secret, s.f.clock, delta) === smsCode)) {
      s.f.clock.advanceMs(30_000);
      expect(s.f.clock.now().getTime() - sentAt).toBeLessThan(300_000);
    }
    const totpCode = totp(s.a.secret, s.f.clock);
    const response = await s.step(tier, tier === 'sms' ? totpCode : smsCode);
    await error(response, STEP, 20002);
    expect(response.json()).not.toHaveProperty('step_up_token');
    expect(response.json()).not.toHaveProperty('data.step_up_token');
    expect((await row(h, s.a)).failed_login_count).toBe(1);
    expect((await row(h, s.a)).locked_until).toBeNull();
    // Both original codes remain valid in their own tiers after the rejected submission.
    expect((await ok<Grant>(await s.step('totp', totpCode), STEP)).tier).toBe('totp');
    expect((await ok<Grant>(await s.step('sms', smsCode), STEP)).tier).toBe('sms');
  },
  30_000,
);
