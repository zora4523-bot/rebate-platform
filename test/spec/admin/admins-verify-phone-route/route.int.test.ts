import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  harness,
  mask,
  ok,
  REASON,
  refused,
  setup,
  testPhone,
  text,
  type Account,
  type Setup,
  type VerifyPhone,
} from './kit.ts';

// A pending verify-phone code belongs to the route that sent it (BR-ID-45 ① ③; B1-34i r1 S2): a
// code the holder sent on 「我的账号」 is submitted only by the holder there, a code a super admin
// sent on the holder's behalf only by that super admin on the change route, so the change's audit
// row names the account that started the change. Before the fix the pending record does not know
// its sender: every cross-route submission succeeds and fails its first status assertion.
const h = harness(createTestDatabase, acquireTestRedis);

/** `id`'s verify phone is changed by the super admin `token` with the code `code`. */
function changeFor(f: Setup, token: string, id: string, phone: string, code: string) {
  return f.call('changeFor', { token, id, body: { phone, code, reason: REASON } });
}

it('[AC-B1-34o#1] 本人在「我的账号」发的码，超管经代改接口提交被拒（20002/20003），什么都不变；本人随后提交生效，审计记本人、无原因', async () => {
  const f = await setup(h);
  const old = testPhone();
  const fresh = testPhone(old);
  const s = await f.holder({ phone: old });
  await ok(
    await f.call('sendMine', { token: s.token, body: { phone: fresh }, step: await s.issue() }),
    'sendMine',
  );
  const code = f.lastCodeTo(fresh);
  const before = await f.snapshot();

  await refused(await changeFor(f, f.token, s.account.id, fresh, code), 'changeFor');
  expect(await f.snapshot()).toEqual(before);
  expect(f.storedPhone(await f.row(s.account.id))).toBe(old);
  expect(await f.audits('admin_verify_phone_change')).toEqual([]);

  // The holder's own pending change is not used up by the refused submission.
  const result = await ok<VerifyPhone>(
    await f.call('changeMine', { token: s.token, body: { phone: fresh, code } }),
    'changeMine',
  );
  expect(result.verify_phone_masked).toBe(mask(fresh));
  expect(f.storedPhone(await f.row(s.account.id))).toBe(fresh);
  const audit = await f.audits('admin_verify_phone_change');
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ app_id: f.appId, admin_id: s.account.id });
  expect(text(audit[0])).not.toContain(REASON);
});

it('[AC-B1-34o#2] 超管代发的码，本人经「我的账号」提交被拒（20002/20003），什么都不变；超管随后代改提交生效，审计记该超管与原因', async () => {
  const f = await setup(h);
  const old = testPhone();
  const fresh = testPhone(old);
  const s = await f.holder({ phone: old });
  await ok(
    await f.call('sendFor', {
      token: f.token,
      id: s.account.id,
      body: { phone: fresh },
      step: await f.issue(),
    }),
    'sendFor',
  );
  const code = f.lastCodeTo(fresh);
  const before = await f.snapshot();

  await refused(
    await f.call('changeMine', { token: s.token, body: { phone: fresh, code } }),
    'changeMine',
  );
  expect(await f.snapshot()).toEqual(before);
  expect(f.storedPhone(await f.row(s.account.id))).toBe(old);
  expect((await f.me(s.token)).verify_phone_masked).toBe(mask(old));
  expect(await f.audits('admin_verify_phone_change')).toEqual([]);

  // The super admin's pending change is not used up by the refused submission.
  const result = await ok<Account>(
    await changeFor(f, f.token, s.account.id, fresh, code),
    'changeFor',
  );
  expect(result.verify_phone_masked).toBe(mask(fresh));
  expect(f.storedPhone(await f.row(s.account.id))).toBe(fresh);
  const audit = await f.audits('admin_verify_phone_change');
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ app_id: f.appId, admin_id: f.actor.id });
  expect(text(audit[0])).toContain(s.account.id);
  expect(text(audit[0])).toContain(REASON);
});

it('[AC-B1-34o#3] 超管甲代发的码，另一位超管乙经代改接口提交被拒（20002/20003），什么都不变；甲随后提交生效，发码与改号审计都记甲', async () => {
  const f = await setup(h);
  const old = testPhone();
  const fresh = testPhone(old);
  const a = await f.target({ phone: old });
  const other = await f.holder({ isSuper: true });
  await ok(
    await f.call('sendFor', {
      token: f.token,
      id: a.id,
      body: { phone: fresh },
      step: await f.issue(),
    }),
    'sendFor',
  );
  const code = f.lastCodeTo(fresh);
  const before = await f.snapshot();

  await refused(await changeFor(f, other.token, a.id, fresh, code), 'changeFor');
  expect(await f.snapshot()).toEqual(before);
  expect(f.storedPhone(await f.row(a.id))).toBe(old);
  expect(await f.audits('admin_verify_phone_change')).toEqual([]);

  await ok<Account>(await changeFor(f, f.token, a.id, fresh, code), 'changeFor');
  expect(f.storedPhone(await f.row(a.id))).toBe(fresh);
  const sendAudit = await f.audits('admin_verify_phone_code_send');
  const changeAudit = await f.audits('admin_verify_phone_change');
  expect(sendAudit).toHaveLength(1);
  expect(changeAudit).toHaveLength(1);
  expect(sendAudit[0]).toMatchObject({ app_id: f.appId, admin_id: f.actor.id });
  expect(changeAudit[0]).toMatchObject({ app_id: f.appId, admin_id: f.actor.id });
  expect(changeAudit[0]!.admin_id).not.toBe(other.account.id);
});
