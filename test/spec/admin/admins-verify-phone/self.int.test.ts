import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  error,
  expectNoPlain,
  harness,
  LIMITS,
  mask,
  ok,
  redisText,
  SEND,
  setup,
  smsTo,
  STEP,
  stepError,
  stepOk,
  stepValidate,
  testPhone,
  text,
  typed,
  wrong,
  type Grant,
  type Sent,
  type VerifyPhone,
} from './kit.ts';

// The holder's own registration or change on 「我的账号」 (BR-ID-45 ① ② ④; contract
// adminSendMyVerifyPhoneCode, adminChangeMyVerifyPhone). Before the implementation the routes are
// not registered: every request to them fails its first status assertion.
const h = harness(createTestDatabase, acquireTestRedis);

it.each([
  ['普通账号（未勾选任何权限点）', false],
  ['超管', true],
] as const)(
  '[AC-B1-34i#2] %s 本人登记验证手机号：动态码档发码到新号，核验后才生效，短信档改发新号，写审计，会话不作废',
  async (_label, isSuper) => {
    const f = await setup(h);
    const s = await f.holder({ isSuper });
    const fresh = testPhone();
    // Before: no verify phone, so the sms tier answers verify_phone_missing.
    await stepError(await f.smsCode(s.token), SEND, 10003, {
      tier: 'sms',
      reason: 'verify_phone_missing',
    });
    expect((await f.me(s.token)).verify_phone_masked).toBeNull();

    const sent = await f.call('sendMine', {
      token: s.token,
      body: { phone: fresh },
      step: await s.issue(),
    });
    expect(await ok<Sent>(sent, 'sendMine')).toEqual(LIMITS);
    expect(f.outbox()).toEqual([smsTo(f.appId, fresh)]);
    const code = f.lastCodeTo(fresh);
    expect(JSON.stringify(sent.json())).not.toContain(code);

    // Sent but not verified: nothing registered yet.
    const before = await f.row(s.account.id);
    expect(f.storedPhone(before)).toBeNull();
    expect((await f.me(s.token)).verify_phone_masked).toBeNull();

    const changed = await f.call('changeMine', {
      token: s.token,
      body: { phone: fresh, code },
    });
    const result = await ok<VerifyPhone>(changed, 'changeMine');
    expect(result.verify_phone_masked).toBe(mask(fresh));
    expect(new Date(result.verify_phone_set_at).toISOString()).toBe(f.clock.now().toISOString());
    expect(JSON.stringify(changed.json())).not.toContain(fresh);

    const after = await f.row(s.account.id);
    expect(f.storedPhone(after)).toBe(fresh);
    expect(after.verify_phone_hmac).toEqual(expect.any(String));
    expect(after.verify_phone_hmac).not.toContain(fresh);
    expect(new Date(after.verify_phone_set_at!).toISOString()).toBe(f.clock.now().toISOString());
    // Only the verify phone (and the row's bookkeeping) changed.
    expect(after).toEqual({
      ...before,
      verify_phone_cipher: after.verify_phone_cipher,
      verify_phone_hmac: after.verify_phone_hmac,
      verify_phone_set_at: after.verify_phone_set_at,
      row_version: after.row_version,
      updated_at: after.updated_at,
    });
    // The session is not revoked; the sms tier is available and goes to the new phone.
    expect((await f.me(s.token)).verify_phone_masked).toBe(mask(fresh));
    f.clock.advanceMs(60_000);
    await stepOk(await f.smsCode(s.token), SEND);
    expect(f.outbox().at(-1)).toEqual(smsTo(f.appId, fresh));
    const stepCode = f.lastCodeTo(fresh);
    const granted = await stepOk<Grant>(await f.stepUp(s.token, 'sms', stepCode), STEP);
    expect(granted.tier).toBe('sms');

    const audit = await f.audits('admin_verify_phone_change');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ app_id: f.appId, admin_id: s.account.id });
    expect(text(audit[0])).toContain(mask(fresh));
    expectNoPlain(text(await f.audits()), [fresh], [code, stepCode]);
    expectNoPlain(f.lines.join('\n'), [fresh], [code, stepCode]);
  },
);

it('[AC-B1-34i#3] 换号期间旧号一直有效：短信档仍发旧号并可用旧号的码完成，登记的仍是旧号；核验后才改发新号', async () => {
  const f = await setup(h);
  const old = testPhone();
  const fresh = testPhone(old);
  const s = await f.holder({ phone: old });
  await ok(
    await f.call('sendMine', { token: s.token, body: { phone: fresh }, step: await s.issue() }),
    'sendMine',
  );
  const pending = f.lastCodeTo(fresh);
  const before = await f.row(s.account.id);
  expect(f.storedPhone(before)).toBe(old);
  expect((await f.me(s.token)).verify_phone_masked).toBe(mask(old));

  // AC-S2-59 ⑫: an sms-tier step-up during the change uses the old phone.
  f.clock.advanceMs(60_000);
  await stepOk(await f.smsCode(s.token), SEND);
  expect(f.outbox().at(-1)).toEqual(smsTo(f.appId, old));
  const granted = await stepOk<Grant>(await f.stepUp(s.token, 'sms', f.lastCodeTo(old)), STEP);
  expect(granted.tier).toBe('sms');
  expect(f.sentTo(fresh)).toHaveLength(1);
  expect(await f.row(s.account.id)).toEqual(before);
  expect((await f.me(s.token)).verify_phone_masked).toBe(mask(old));

  // The pending change still completes; from then on the new phone gets the codes.
  await ok<VerifyPhone>(
    await f.call('changeMine', { token: s.token, body: { phone: fresh, code: pending } }),
    'changeMine',
  );
  expect(f.storedPhone(await f.row(s.account.id))).toBe(fresh);
  f.clock.advanceMs(60_000);
  await stepOk(await f.smsCode(s.token), SEND);
  expect(f.outbox().at(-1)).toEqual(smsTo(f.appId, fresh));
  expect(f.sentTo(old)).toHaveLength(1);
});

it('[AC-B1-34i#4] 发码须动态码档 step-up：不带令牌或只带短信档令牌返回 10003 tier=totp，不发短信、什么都不变', async () => {
  const f = await setup(h);
  const old = testPhone();
  const fresh = testPhone(old);
  const s = await f.holder({ phone: old });
  const before = await f.row(s.account.id);
  await error(
    await f.call('sendMine', { token: s.token, body: { phone: fresh } }),
    'sendMine',
    10003,
    { tier: 'totp' },
  );
  await stepOk(await f.smsCode(s.token), SEND);
  const sms = await stepOk<Grant>(await f.stepUp(s.token, 'sms', f.lastCodeTo(old)), STEP);
  expect(sms.tier).toBe('sms');
  await error(
    await f.call('sendMine', { token: s.token, body: { phone: fresh }, step: sms.step_up_token }),
    'sendMine',
    10003,
    { tier: 'totp' },
  );
  expect(f.sentTo(fresh)).toEqual([]);
  expect(await f.row(s.account.id)).toEqual(before);
  expect(await f.audits('admin_verify_phone_change')).toEqual([]);
});

const REFUSED: readonly (readonly [string, (old: string) => string, object])[] = [
  ['与当前登记的号相同', (old) => old, { fields: ['phone'] }],
  ['规范化后与当前登记的号相同', (old) => typed(old), { fields: ['phone'] }],
  ['不是大陆手机号', () => '12345', { fields: ['phone'], reason: 'phone_invalid' }],
  ['为空串', () => '', { fields: ['phone'], reason: 'phone_invalid' }],
];
it.each(REFUSED)(
  '[AC-B1-34i#5] 新号%s时返回 20001，不发短信、什么都不变',
  async (_label, phoneOf, data) => {
    const f = await setup(h);
    const old = testPhone();
    const s = await f.holder({ phone: old });
    const step = await s.issue();
    const before = await f.row(s.account.id);
    await error(
      await f.call('sendMine', { token: s.token, body: { phone: phoneOf(old) }, step }),
      'sendMine',
      20001,
      data,
    );
    expect(f.outbox()).toEqual([]);
    expect(await f.row(s.account.id)).toEqual(before);
  },
);

it('[AC-B1-34i#6] 新号按规范化处理：带 +86 与分隔符发码，短信发到 11 位号，按 11 位号提交生效', async () => {
  const f = await setup(h);
  const old = testPhone();
  const fresh = testPhone(old);
  const s = await f.holder({ phone: old });
  await ok(
    await f.call('sendMine', {
      token: s.token,
      body: { phone: typed(fresh) },
      step: await s.issue(),
    }),
    'sendMine',
  );
  expect(f.outbox()).toEqual([smsTo(f.appId, fresh)]);
  const result = await ok<VerifyPhone>(
    await f.call('changeMine', {
      token: s.token,
      body: { phone: fresh, code: f.lastCodeTo(fresh) },
    }),
    'changeMine',
  );
  expect(result.verify_phone_masked).toBe(mask(fresh));
  expect(f.storedPhone(await f.row(s.account.id))).toBe(fresh);
});

it('[AC-B1-34i#7] 错码返回 20002（无 data）且不生效，随后正确码生效；用过的码再交返回 20003', async () => {
  const f = await setup(h);
  const old = testPhone();
  const fresh = testPhone(old);
  const s = await f.holder({ phone: old });
  await ok(
    await f.call('sendMine', { token: s.token, body: { phone: fresh }, step: await s.issue() }),
    'sendMine',
  );
  const code = f.lastCodeTo(fresh);
  const before = await f.row(s.account.id);
  await error(
    await f.call('changeMine', { token: s.token, body: { phone: fresh, code: wrong(code) } }),
    'changeMine',
    20002,
  );
  expect(await f.row(s.account.id)).toEqual(before);
  await ok<VerifyPhone>(
    await f.call('changeMine', { token: s.token, body: { phone: fresh, code } }),
    'changeMine',
  );
  expect(f.storedPhone(await f.row(s.account.id))).toBe(fresh);
  await error(
    await f.call('changeMine', { token: s.token, body: { phone: fresh, code } }),
    'changeMine',
    20003,
  );
  expect(f.storedPhone(await f.row(s.account.id))).toBe(fresh);
  expect(await f.audits('admin_verify_phone_change')).toHaveLength(1);
});

it.each(['从未发码', '码发给了另一个号'] as const)(
  '[AC-B1-34i#8] %s时提交返回 20003，什么都不变',
  async (kind) => {
    const f = await setup(h);
    const old = testPhone();
    const fresh = testPhone(old);
    const other = testPhone(old, fresh);
    const s = await f.holder({ phone: old });
    let code = '000000';
    if (kind === '码发给了另一个号') {
      const step = await s.issue();
      await ok(
        await f.call('sendMine', { token: s.token, body: { phone: other }, step }),
        'sendMine',
      );
      code = f.lastCodeTo(other);
    }
    const before = await f.row(s.account.id);
    await error(
      await f.call('changeMine', { token: s.token, body: { phone: fresh, code } }),
      'changeMine',
      20003,
    );
    expect(await f.row(s.account.id)).toEqual(before);
    expect(await f.audits('admin_verify_phone_change')).toEqual([]);
  },
);

it('[AC-B1-34i#9] 验证码有效期 300 秒：差 1 毫秒仍可提交，恰满 300 秒返回 20003 且不生效', async () => {
  const f = await setup(h);
  const firstOld = testPhone();
  const first = await f.holder({ phone: firstOld });
  const firstPhone = testPhone(firstOld);
  await ok(
    await f.call('sendMine', {
      token: first.token,
      body: { phone: firstPhone },
      step: await first.issue(),
    }),
    'sendMine',
  );
  const firstCode = f.lastCodeTo(firstPhone);
  f.clock.advanceMs(299_999);
  await ok<VerifyPhone>(
    await f.call('changeMine', {
      token: first.token,
      body: { phone: firstPhone, code: firstCode },
    }),
    'changeMine',
  );

  const old = testPhone();
  const second = await f.holder({ phone: old });
  const secondPhone = testPhone(old);
  await ok(
    await f.call('sendMine', {
      token: second.token,
      body: { phone: secondPhone },
      step: await second.issue(),
    }),
    'sendMine',
  );
  const secondCode = f.lastCodeTo(secondPhone);
  const before = await f.row(second.account.id);
  f.clock.advanceMs(300_000);
  await error(
    await f.call('changeMine', {
      token: second.token,
      body: { phone: secondPhone, code: secondCode },
    }),
    'changeMine',
    20003,
  );
  expect(await f.row(second.account.id)).toEqual(before);
  expect(f.storedPhone(before)).toBe(old);
});

it.each(['另一个新号', '同一个新号'] as const)(
  '[AC-B1-34i#10] 再次发码（%s）覆盖前一次：前一个码返回 20003，只认最近一次的码',
  async (kind) => {
    const f = await setup(h);
    const old = testPhone();
    const first = testPhone(old);
    const second = kind === '同一个新号' ? first : testPhone(old, first);
    const s = await f.holder({ phone: old });
    const steps = [await s.issue(), await s.issue()];
    await ok(
      await f.call('sendMine', { token: s.token, body: { phone: first }, step: steps[0]! }),
      'sendMine',
    );
    const earlier = f.lastCodeTo(first);
    f.clock.advanceMs(60_000);
    await ok(
      await f.call('sendMine', { token: s.token, body: { phone: second }, step: steps[1]! }),
      'sendMine',
    );
    const latest = f.lastCodeTo(second);
    expect(latest).not.toBe(earlier);
    await error(
      await f.call('changeMine', { token: s.token, body: { phone: first, code: earlier } }),
      'changeMine',
      20003,
    );
    expect(f.storedPhone(await f.row(s.account.id))).toBe(old);
    await ok<VerifyPhone>(
      await f.call('changeMine', { token: s.token, body: { phone: second, code: latest } }),
      'changeMine',
    );
    expect(f.storedPhone(await f.row(s.account.id))).toBe(second);
  },
);

it('[AC-B1-34i#11] 发码限频沿用后台短信档口径：60 秒内 42901 带 Retry-After，恰满 60 秒可再发', async () => {
  const f = await setup(h);
  const old = testPhone();
  const fresh = testPhone(old);
  const s = await f.holder({ phone: old });
  // Each send gets its own token, issued up front (every issue moves the clock 30 s).
  const steps = [await s.issue(), await s.issue(), await s.issue(), await s.issue()];
  const send = (step: string) =>
    f.call('sendMine', { token: s.token, body: { phone: fresh }, step });
  expect(await ok<Sent>(await send(steps[0]!), 'sendMine')).toEqual(LIMITS);
  const firstLimit = await send(steps[1]!);
  await error(firstLimit, 'sendMine', 42901);
  expect(String(firstLimit.headers['retry-after'])).toBe('60');
  f.clock.advanceMs(59_999);
  const lastLimit = await send(steps[2]!);
  await error(lastLimit, 'sendMine', 42901);
  expect(String(lastLimit.headers['retry-after'])).toBe('1');
  expect(f.outbox()).toHaveLength(1);
  f.clock.advanceMs(1);
  expect(await ok<Sent>(await send(steps[3]!), 'sendMine')).toEqual(LIMITS);
  expect(f.sentTo(fresh)).toHaveLength(2);
});

it('[AC-B1-34i#12] 新号验证码与短信档验证码互不通用', async () => {
  const f = await setup(h);
  const old = testPhone();
  const fresh = testPhone(old);
  const s = await f.holder({ phone: old });
  await ok(
    await f.call('sendMine', { token: s.token, body: { phone: fresh }, step: await s.issue() }),
    'sendMine',
  );
  const pending = f.lastCodeTo(fresh);
  // The code sent to the new phone does not pass the sms tier.
  const misuse = await f.stepUp(s.token, 'sms', pending);
  expect(misuse.statusCode).toBe(400);
  expect([20002, 20003]).toContain(misuse.json().code);
  await stepValidate(misuse, STEP);

  f.clock.advanceMs(60_000);
  await stepOk(await f.smsCode(s.token), SEND);
  const stepCode = f.lastCodeTo(old);
  // The sms-tier code sent to the old phone does not verify the new phone.
  const before = await f.row(s.account.id);
  const swapped = await f.call('changeMine', {
    token: s.token,
    body: { phone: fresh, code: stepCode },
  });
  expect(swapped.statusCode).toBe(400);
  expect([20002, 20003]).toContain(swapped.json().code);
  expect(await f.row(s.account.id)).toEqual(before);
  // Neither attempt used up the other code.
  const granted = await stepOk<Grant>(await f.stepUp(s.token, 'sms', stepCode), STEP);
  expect(granted.tier).toBe('sms');
  await ok<VerifyPhone>(
    await f.call('changeMine', { token: s.token, body: { phone: fresh, code: pending } }),
    'changeMine',
  );
  expect(f.storedPhone(await f.row(s.account.id))).toBe(fresh);
});

it('[AC-B1-34i#13] 待核验的新号与验证码不以明文落 Redis、日志与响应（BR-ID-33）', async () => {
  const f = await setup(h);
  const old = testPhone();
  const fresh = testPhone(old);
  const s = await f.holder({ phone: old });
  const sent = await f.call('sendMine', {
    token: s.token,
    body: { phone: fresh },
    step: await s.issue(),
  });
  await ok(sent, 'sendMine');
  const code = f.lastCodeTo(fresh);
  expectNoPlain(JSON.stringify(sent.json()), [fresh], [code]);
  expectNoPlain(await redisText(h), [fresh], [code]);
  expectNoPlain(f.lines.join('\n'), [fresh, old], [code]);

  const changed = await f.call('changeMine', {
    token: s.token,
    body: { phone: fresh, code },
  });
  await ok(changed, 'changeMine');
  expectNoPlain(JSON.stringify(changed.json()), [fresh, old], [code]);
  expectNoPlain(await redisText(h), [fresh], [code]);
  expectNoPlain(f.lines.join('\n'), [fresh, old], [code]);
  expectNoPlain(text(await f.audits()), [fresh, old], [code]);
});

it('[AC-B1-34i#14] 同一个码并发提交两次：恰好一次生效，另一次 20003，只写一条审计', async () => {
  const f = await setup(h);
  const old = testPhone();
  const fresh = testPhone(old);
  const s = await f.holder({ phone: old });
  await ok(
    await f.call('sendMine', { token: s.token, body: { phone: fresh }, step: await s.issue() }),
    'sendMine',
  );
  const code = f.lastCodeTo(fresh);
  const submit = () => f.call('changeMine', { token: s.token, body: { phone: fresh, code } });
  const results = await Promise.all([submit(), submit()]);
  expect(results.map((item) => item.statusCode).sort((a, b) => a - b)).toEqual([200, 400]);
  for (const item of results) {
    await (item.statusCode === 200 ? ok(item, 'changeMine') : error(item, 'changeMine', 20003));
  }
  expect(f.storedPhone(await f.row(s.account.id))).toBe(fresh);
  expect(await f.audits('admin_verify_phone_change')).toHaveLength(1);
});
