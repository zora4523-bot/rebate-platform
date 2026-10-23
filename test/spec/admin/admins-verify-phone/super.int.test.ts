import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { admin_permission } from '../../../../packages/contracts-ts/src/index.ts';
import { grant, seed } from '../accounts/kit.ts';
import {
  alive,
  error,
  expectAccount,
  expectNoPlain,
  harness,
  LIMITS,
  mask,
  ok,
  SEND,
  setup,
  signInAgain,
  smsTo,
  STEP,
  stepOk,
  testPhone,
  text,
  typed,
  wrong,
  type Account,
  type Grant,
  type Operation,
  type Sent,
  type Setup,
  type VerifyPhone,
} from './kit.ts';

// A super admin registering or changing another account's verify phone on its holder's behalf
// (BR-ID-45 ③; contract adminSendAdminVerifyPhoneCode, adminChangeAdminVerifyPhone). Before the
// implementation the routes are not registered: every request to them fails its first status
// assertion.
const h = harness(createTestDatabase, acquireTestRedis);

const REASON = '本人委托代改，已视频核对本人身份';

/** The super admin sends a code for `id` to `phone` with a fresh totp-tier step-up. */
async function sendFor(f: Setup, id: string, phone: string) {
  return f.call('sendFor', { token: f.token, id, body: { phone }, step: await f.issue() });
}

function changeFor(f: Setup, id: string, body: object) {
  return f.call('changeFor', { token: f.token, id, body });
}

it('[AC-B1-34i#20] 超管代改：动态码档发码到新号并写审计，本人提供的码与原因提交后才生效，短信档改发新号，会话不作废', async () => {
  const f = await setup(h);
  const old = testPhone();
  const fresh = testPhone(old);
  const a = await f.target({ phone: old });
  const own = await signInAgain(f, a);

  const sent = await sendFor(f, a.id, fresh);
  expect(await ok<Sent>(sent, 'sendFor')).toEqual(LIMITS);
  expect(f.outbox()).toEqual([smsTo(f.appId, fresh)]);
  const code = f.lastCodeTo(fresh);
  expect(JSON.stringify(sent.json())).not.toContain(code);
  const sendAudit = await f.audits('admin_verify_phone_code_send');
  expect(sendAudit).toHaveLength(1);
  expect(sendAudit[0]).toMatchObject({ app_id: f.appId, admin_id: f.actor.id });
  expect(text(sendAudit[0])).toContain(a.id);
  expect(text(sendAudit[0])).toContain(mask(fresh));

  const before = await f.row(a.id);
  expect(f.storedPhone(before)).toBe(old);
  const changed = await changeFor(f, a.id, { phone: fresh, code, reason: REASON });
  const result = await ok<Account>(changed, 'changeFor');
  expectAccount(result, {
    ...a.expected,
    verify_phone_masked: mask(fresh),
    row_version: before.row_version + 1,
  });
  expect(JSON.stringify(changed.json())).not.toContain(fresh);
  const after = await f.row(a.id);
  expect(after).toEqual({
    ...before,
    verify_phone_cipher: expect.anything(),
    verify_phone_hmac: expect.any(String),
    verify_phone_set_at: expect.anything(),
    row_version: before.row_version + 1,
    updated_at: expect.anything(),
  });
  expect(f.storedPhone(after)).toBe(fresh);
  expect(after.verify_phone_hmac).not.toBe(before.verify_phone_hmac);
  expect(after.verify_phone_hmac).not.toContain(fresh);
  expect(new Date(after.verify_phone_set_at!).toISOString()).toBe(f.clock.now().toISOString());
  expect(await f.detail(a.id)).toMatchObject({ verify_phone_masked: mask(fresh) });

  // Sessions are not revoked; the holder's sms tier now goes to the new phone.
  await alive(f, own.admin_token);
  await alive(f, f.token);
  f.clock.advanceMs(60_000);
  await stepOk(await f.smsCode(own.admin_token), SEND);
  expect(f.outbox().at(-1)).toEqual(smsTo(f.appId, fresh));
  expect(f.sentTo(old)).toEqual([]);

  const audit = await f.audits('admin_verify_phone_change');
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ app_id: f.appId, admin_id: f.actor.id });
  expect(text(audit[0])).toContain(a.id);
  expect(text(audit[0])).toContain(REASON);
  expect(text(audit[0])).toContain(mask(old));
  expect(text(audit[0])).toContain(mask(fresh));
  expectNoPlain(text(await f.audits()), [old, fresh], [code]);
  expectNoPlain(f.lines.join('\n'), [old, fresh], [code]);
});

it.each(['没有提交新号的验证码', '提交了错误的验证码'] as const)(
  '[AC-B1-34i#21] 超管代改%s：不生效，登记的仍是旧号，短信档仍发旧号，发起已写审计',
  async (kind) => {
    const f = await setup(h);
    const old = testPhone();
    const fresh = testPhone(old);
    const a = await f.target({ phone: old });
    const own = await signInAgain(f, a);
    await ok(await sendFor(f, a.id, fresh), 'sendFor');
    const code = f.lastCodeTo(fresh);
    const before = await f.row(a.id);
    if (kind === '提交了错误的验证码') {
      await error(
        await changeFor(f, a.id, { phone: fresh, code: wrong(code), reason: REASON }),
        'changeFor',
        20002,
      );
    }
    // AC-S2-59 ⑬.
    expect(await f.row(a.id)).toEqual(before);
    expect(f.storedPhone(before)).toBe(old);
    expect(await f.detail(a.id)).toMatchObject({ verify_phone_masked: mask(old) });
    f.clock.advanceMs(60_000);
    await stepOk(await f.smsCode(own.admin_token), SEND);
    expect(f.outbox().at(-1)).toEqual(smsTo(f.appId, old));
    const oldCode = f.lastCodeTo(old);
    const granted = await stepOk<Grant>(await f.stepUp(own.admin_token, 'sms', oldCode), STEP);
    expect(granted.tier).toBe('sms');
    expect(await f.audits('admin_verify_phone_code_send')).toHaveLength(1);
    expect(await f.audits('admin_verify_phone_change')).toEqual([]);
  },
);

it('[AC-B1-34i#22] 不核验新号的代改不允许：未发码或拿别的账号的码提交返回 20003，什么都不变', async () => {
  const f = await setup(h);
  const old = testPhone();
  const fresh = testPhone(old);
  const a = await f.target({ phone: old });
  const b = await f.target({ phone: testPhone(fresh) });
  const before = await f.row(a.id);
  await error(
    await changeFor(f, a.id, { phone: fresh, code: '000000', reason: REASON }),
    'changeFor',
    20003,
  );
  // A code sent for another account to the same new phone does not change this one.
  await ok(await sendFor(f, b.id, fresh), 'sendFor');
  await error(
    await changeFor(f, a.id, { phone: fresh, code: f.lastCodeTo(fresh), reason: REASON }),
    'changeFor',
    20003,
  );
  expect(await f.row(a.id)).toEqual(before);
  expect(await f.audits('admin_verify_phone_change')).toEqual([]);
});

const BOTH: readonly Operation[] = ['sendFor', 'changeFor'];

/** A body each operation accepts. */
function bodyOf(operation: Operation, phone: string): object {
  return operation === 'sendFor' ? { phone } : { phone, code: '000000', reason: REASON };
}

it.each(BOTH)(
  '[AC-B1-34i#23] 普通账号即使勾选全部权限并持有效 step-up 令牌，%s 也返回 10403 且不发短信、什么都不变',
  async (operation) => {
    const f = await setup(h);
    const ordinary = await f.target();
    await grant(h, ordinary, f.actor, [...admin_permission]);
    const session = await signInAgain(f, ordinary);
    const step = await f.issue(ordinary, session.admin_token);
    const old = testPhone();
    const victim = await f.target({ phone: old });
    const before = await f.snapshot();
    await error(
      await f.call(operation, {
        token: session.admin_token,
        id: victim.id,
        body: bodyOf(operation, testPhone(old)),
        step,
      }),
      operation,
      10403,
      { reason: 'admin_permission_denied' },
    );
    expect(f.outbox()).toEqual([]);
    expect(await f.snapshot()).toEqual(before);
  },
);

it('[AC-B1-34i#24] 超管代改发码不带 step-up 令牌返回 10003 tier=totp，不发短信、什么都不变', async () => {
  const f = await setup(h);
  const old = testPhone();
  const a = await f.target({ phone: old });
  const before = await f.snapshot();
  await error(
    await f.call('sendFor', { token: f.token, id: a.id, body: { phone: testPhone(old) } }),
    'sendFor',
    10003,
    { tier: 'totp' },
  );
  expect(f.outbox()).toEqual([]);
  expect(await f.snapshot()).toEqual(before);
});

const SELF_OR_SUPER = BOTH.flatMap((operation) =>
  (['调用者本人', '另一位超管'] as const).map((kind) => [operation, kind] as const),
);
it.each(SELF_OR_SUPER)(
  '[AC-B1-34i#25] %s 的目标是%s时返回 10403，不发短信、什么都不变',
  async (operation, kind) => {
    const f = await setup(h);
    const old = testPhone();
    const target = kind === '调用者本人' ? f.actor : await f.target({ isSuper: true, phone: old });
    const step = operation === 'sendFor' ? await f.issue() : undefined;
    const before = await f.snapshot();
    await error(
      await f.call(operation, {
        token: f.token,
        id: target.id,
        body: bodyOf(operation, testPhone(old)),
        ...(step === undefined ? {} : { step }),
      }),
      operation,
      10403,
      { reason: 'admin_permission_denied' },
    );
    expect(f.outbox()).toEqual([]);
    expect(await f.snapshot()).toEqual(before);
  },
);

const UNKNOWN = BOTH.flatMap((operation) =>
  (['unknown', 'malformed', 'other-app'] as const).map((kind) => [operation, kind] as const),
);
it.each(UNKNOWN)(
  '[AC-B1-34i#26] %s 的 admin_id 不存在、不合法或属于其他 app（%s）返回 20001 admin_id',
  async (operation, kind) => {
    const f = await setup(h);
    const foreign =
      kind === 'other-app'
        ? await seed(h, `v_${randomUUID().replaceAll('-', '').slice(0, 24)}`, {
            phone: testPhone(),
          })
        : undefined;
    const id = foreign?.id ?? (kind === 'unknown' ? randomUUID() : 'not-a-uuid');
    const step = operation === 'sendFor' ? await f.issue() : undefined;
    const foreignBefore = foreign === undefined ? undefined : await f.row(foreign.id);
    const before = await f.snapshot();
    await error(
      await f.call(operation, {
        token: f.token,
        id,
        body: bodyOf(operation, testPhone()),
        ...(step === undefined ? {} : { step }),
      }),
      operation,
      20001,
      { fields: ['admin_id'] },
    );
    expect(f.outbox()).toEqual([]);
    expect(await f.snapshot()).toEqual(before);
    if (foreign !== undefined) expect(await f.row(foreign.id)).toEqual(foreignBefore);
  },
);

const REASONS: readonly (readonly [string, object])[] = [
  ['缺失', {}],
  ['为空', { reason: '' }],
  ['超过 200 字', { reason: '由'.repeat(201) }],
];
it.each(REASONS)(
  '[AC-B1-34i#27] 代改提交的原因%s返回 20001 reason，什么都不变',
  async (_label, patch) => {
    const f = await setup(h);
    const old = testPhone();
    const fresh = testPhone(old);
    const a = await f.target({ phone: old });
    await ok(await sendFor(f, a.id, fresh), 'sendFor');
    const before = await f.row(a.id);
    await error(
      await changeFor(f, a.id, { phone: fresh, code: f.lastCodeTo(fresh), ...patch }),
      'changeFor',
      20001,
      { fields: ['reason'] },
    );
    expect(await f.row(a.id)).toEqual(before);
    expect(await f.audits('admin_verify_phone_change')).toEqual([]);
  },
);

const REFUSED: readonly (readonly [string, (old: string) => string, object])[] = [
  ['与当前登记的号相同', (old) => old, { fields: ['phone'] }],
  ['规范化后与当前登记的号相同', (old) => typed(old), { fields: ['phone'] }],
  ['不是大陆手机号', () => '12345', { fields: ['phone'], reason: 'phone_invalid' }],
];
it.each(REFUSED)(
  '[AC-B1-34i#28] 代改发码的新号%s时返回 20001，不发短信、什么都不变',
  async (_label, phoneOf, data) => {
    const f = await setup(h);
    const old = testPhone();
    const a = await f.target({ phone: old });
    const step = await f.issue();
    const before = await f.snapshot();
    await error(
      await f.call('sendFor', { token: f.token, id: a.id, body: { phone: phoneOf(old) }, step }),
      'sendFor',
      20001,
      data,
    );
    expect(f.outbox()).toEqual([]);
    expect(await f.snapshot()).toEqual(before);
  },
);

it('[AC-B1-34i#29] 未登记验证手机号的账号可由超管代为登记，登记后本人的短信档可用', async () => {
  const f = await setup(h);
  const a = await f.target();
  const own = await signInAgain(f, a);
  const fresh = testPhone();
  await ok(await sendFor(f, a.id, fresh), 'sendFor');
  const result = await ok<Account>(
    await changeFor(f, a.id, { phone: fresh, code: f.lastCodeTo(fresh), reason: REASON }),
    'changeFor',
  );
  expect(result.verify_phone_masked).toBe(mask(fresh));
  expect(f.storedPhone(await f.row(a.id))).toBe(fresh);
  const audit = await f.audits('admin_verify_phone_change');
  expect(audit).toHaveLength(1);
  expect(text(audit[0])).toContain(mask(fresh));
  f.clock.advanceMs(60_000);
  await stepOk(await f.smsCode(own.admin_token), SEND);
  expect(f.outbox().at(-1)).toEqual(smsTo(f.appId, fresh));
});

it('[AC-B1-34i#30] 本人发码后超管为其代改并生效：本人先前那个码作废，提交返回 20003，号码保持代改结果', async () => {
  const f = await setup(h);
  const old = testPhone();
  const mine = testPhone(old);
  const theirs = testPhone(old, mine);
  const a = await f.target({ phone: old });
  const own = await signInAgain(f, a);
  await ok(
    await f.call('sendMine', {
      token: own.admin_token,
      body: { phone: mine },
      step: await f.issue(a, own.admin_token),
    }),
    'sendMine',
  );
  const mineCode = f.lastCodeTo(mine);
  f.clock.advanceMs(60_000);
  await ok(await sendFor(f, a.id, theirs), 'sendFor');
  await ok<Account>(
    await changeFor(f, a.id, { phone: theirs, code: f.lastCodeTo(theirs), reason: REASON }),
    'changeFor',
  );
  await error(
    await f.call('changeMine', {
      token: own.admin_token,
      body: { phone: mine, code: mineCode },
    }),
    'changeMine',
    20003,
  );
  expect(f.storedPhone(await f.row(a.id))).toBe(theirs);
  expect((await f.me(own.admin_token)).verify_phone_masked).toBe(mask(theirs));
  expect(await f.audits('admin_verify_phone_change')).toHaveLength(1);
});

it('[AC-B1-34i#31] 超管代改之后，本人仍可在「我的账号」自行再换号', async () => {
  const f = await setup(h);
  const old = testPhone();
  const fresh = testPhone(old);
  const later = testPhone(old, fresh);
  const a = await f.target({ phone: old });
  const own = await signInAgain(f, a);
  await ok(await sendFor(f, a.id, fresh), 'sendFor');
  await ok<Account>(
    await changeFor(f, a.id, { phone: fresh, code: f.lastCodeTo(fresh), reason: REASON }),
    'changeFor',
  );
  f.clock.advanceMs(60_000);
  await ok(
    await f.call('sendMine', {
      token: own.admin_token,
      body: { phone: later },
      step: await f.issue(a, own.admin_token),
    }),
    'sendMine',
  );
  const result = await ok<VerifyPhone>(
    await f.call('changeMine', {
      token: own.admin_token,
      body: { phone: later, code: f.lastCodeTo(later) },
    }),
    'changeMine',
  );
  expect(result.verify_phone_masked).toBe(mask(later));
  expect(f.storedPhone(await f.row(a.id))).toBe(later);
  await alive(f, f.token);
});
