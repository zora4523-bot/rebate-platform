import { expect, it, vi } from 'vitest';
import * as smsAdapter from '../../../../apps/api/src/modules/identity/infra/fake-sms.ts';
import type { SmsMessage } from '../../../../apps/api/src/modules/identity/application/sms-codes.ts';
import { signedIn, useHarness } from '../auth/kit.ts';
import { wrong } from '../../identity/sms-codes/kit.ts';
import { error, lastCode, ok, registered, SEND, sender, setup, STEP, type Grant } from './kit.ts';

const h = useHarness();

it('[AC-F1-06l#6] 未登记验证手机号的发送与验证均提示 sms/verify_phone_missing，绝不发短信', async () => {
  const s = await setup(h, false);
  await error(await s.send(), SEND, 10003, { tier: 'sms', reason: 'verify_phone_missing' });
  expect(sender(s.f).outbox()).toEqual([]);
  await error(await s.step('sms', '000000'), STEP, 10003, {
    tier: 'sms',
    reason: 'verify_phone_missing',
  });
  expect(sender(s.f).outbox()).toEqual([]);
}, 30_000);

it('[AC-F1-06l#7] 六位短信仅发往账号登记手机号，用途 step_up，响应声明 60/300 秒', async () => {
  const messages: SmsMessage[] = [];
  const factory = vi.spyOn(smsAdapter, 'createSmsSender').mockImplementation(() => {
    const fake = smsAdapter.createFakeSmsSender('test');
    return {
      ...fake,
      async send(message: SmsMessage) {
        messages.push(message);
        return fake.send(message);
      },
    };
  });
  try {
    const s = await setup(h);
    const response = await s.send();
    expect(await ok(response, SEND)).toEqual({ resend_after_sec: 60, expires_in_sec: 300 });
    const code = lastCode(s.f);
    const current = await h.db
      .selectFrom('admin_users')
      .select('verify_phone_cipher')
      .where('id', '=', s.a.id)
      .executeTakeFirstOrThrow();
    const registeredPhone = h.fields.decrypt(
      current.verify_phone_cipher!.toString(),
      `admin_users.verify_phone:couli:${s.a.id}`,
    );
    expect(messages).toEqual([
      expect.objectContaining({
        app_id: 'couli',
        phone: registeredPhone,
        code,
        purpose: 'step_up',
      }),
    ]);
    expect(messages[0]!.code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(response.json())).not.toContain(code);
    expect(s.f.lines.join('')).not.toContain(registeredPhone);
    expect(s.f.lines.join('')).not.toContain(code);
  } finally {
    factory.mockRestore();
  }
}, 30_000);

it('[AC-F1-06l#8] 同账号 60 秒内限频，Retry-After 向上取整，恰满 60 秒可再发', async () => {
  const s = await setup(h);
  await ok(await s.send(), SEND);
  const firstLimit = await s.send();
  await error(firstLimit, SEND, 42901);
  expect(String(firstLimit.headers['retry-after'])).toBe('60');
  s.f.clock.advanceMs(59_999);
  const lastLimit = await s.send();
  await error(lastLimit, SEND, 42901);
  expect(String(lastLimit.headers['retry-after'])).toBe('1');
  expect(sender(s.f).outbox()).toHaveLength(1);
  s.f.clock.advanceMs(1);
  await ok(await s.send(), SEND);
  expect(sender(s.f).outbox()).toHaveLength(2);
}, 30_000);

it('[AC-F1-06l#9] 明确发送失败不占频率；结果未知按已发送处理且不重发', async () => {
  const s = await setup(h);
  sender(s.f).enqueueResult('rejected');
  await error(await s.send(), SEND, 50001);
  expect(sender(s.f).outbox()).toHaveLength(0);
  sender(s.f).enqueueResult('unknown');
  await ok(await s.send(), SEND);
  expect(sender(s.f).outbox()).toHaveLength(1);
  const limited = await s.send();
  await error(limited, SEND, 42901);
  expect(String(limited.headers['retry-after'])).toBe('60');
  expect(sender(s.f).outbox()).toHaveLength(1);
  const grant = await ok<Grant>(await s.step('sms', lastCode(s.f)), STEP);
  expect(grant.tier).toBe('sms');
}, 30_000);

it('[AC-F1-06l#10] 错码 20002 无 reason，可重试正确码；成功签发 sms 令牌后短信码作废', async () => {
  const s = await setup(h);
  await ok(await s.send(), SEND);
  const code = lastCode(s.f);
  await error(await s.step('sms', wrong(code)), STEP, 20002);
  const grant = await ok<Grant>(await s.step('sms', code), STEP);
  expect(grant).toEqual({
    tier: 'sms',
    step_up_token: expect.any(String),
    expire_at: new Date(s.f.clock.now().getTime() + 300_000).toISOString(),
  });
  expect(grant.step_up_token.length).toBeGreaterThanOrEqual(22);
  expect(grant.step_up_token).not.toContain('.');
  await error(await s.step('sms', code), STEP, 20003);
}, 30_000);

it('[AC-F1-06l#34] 同账号重新登录仍共享短信限频，不同账号互不影响', async () => {
  const s = await setup(h);
  await ok(await s.send(), SEND);
  s.f.clock.advanceMs(30_000);
  const anotherSession = await signedIn(s.f, s.a);
  expect(anotherSession.admin_token).not.toBe(s.session.admin_token);
  const limited = await s.f.post(
    '/step-up/sms-codes',
    {},
    { authorization: `Bearer ${anotherSession.admin_token}` },
  );
  await error(limited, SEND, 42901);
  expect(String(limited.headers['retry-after'])).toBe('30');
  expect(sender(s.f).outbox()).toHaveLength(1);

  const other = await registered(h);
  const otherSession = await signedIn(s.f, other);
  expect(other.id).not.toBe(s.a.id);
  const otherSent = await s.f.post(
    '/step-up/sms-codes',
    {},
    { authorization: `Bearer ${otherSession.admin_token}` },
  );
  expect(await ok(otherSent, SEND)).toEqual({
    resend_after_sec: 60,
    expires_in_sec: 300,
  });
  expect(sender(s.f).outbox()).toHaveLength(2);
}, 30_000);

it('[AC-F1-06l#11] 短信码在 300 秒前仍有效，恰满 300 秒过期且不签发令牌', async () => {
  const first = await setup(h);
  await ok(await first.send(), SEND);
  const firstCode = lastCode(first.f);
  first.f.clock.advanceMs(299_999);
  expect((await ok<Grant>(await first.step('sms', firstCode), STEP)).tier).toBe('sms');
  const second = await setup(h);
  await ok(await second.send(), SEND);
  const secondCode = lastCode(second.f);
  second.f.clock.advanceMs(300_000);
  await error(await second.step('sms', secondCode), STEP, 20003);
}, 30_000);

it('[AC-F1-06l#12] 重发使旧码作废，只接受最近一次发出的短信码', async () => {
  const s = await setup(h);
  await ok(await s.send(), SEND);
  const old = lastCode(s.f);
  s.f.clock.advanceMs(60_000);
  await ok(await s.send(), SEND);
  const current = lastCode(s.f);
  expect(current).not.toBe(old);
  await error(await s.step('sms', old), STEP, 20003);
  expect((await ok<Grant>(await s.step('sms', current), STEP)).tier).toBe('sms');
}, 30_000);

it('[AC-F1-06l#13] 并发发码只发送一次，同一短信码并发验证最多签发一枚令牌', async () => {
  const s = await setup(h);
  const sends = await Promise.all([s.send(), s.send()]);
  expect(sends.map((r) => r.json().code).sort((a, b) => a - b)).toEqual([0, 42901]);
  expect(sender(s.f).outbox()).toHaveLength(1);
  const code = lastCode(s.f);
  const verifies = await Promise.all([s.step('sms', code), s.step('sms', code)]);
  expect(verifies.map((r) => r.json().code).sort((a, b) => a - b)).toEqual([0, 20003]);
  for (const response of sends)
    await (response.json().code === 0 ? ok(response, SEND) : error(response, SEND, 42901));
  for (const response of verifies)
    await (response.json().code === 0 ? ok(response, STEP) : error(response, STEP, 20003));
}, 30_000);
