// B1-27a · a correction the vendor confirms (08 BR-ID-25 细则「实名更正」覆盖、旧身份留存、收款账号、个税;
// D10-185, D10-192, D10-181 ②; contract adminCorrectUserRealname; task §9 ②③⑤): in one transaction
// the realname row (same row, same id) gets the new ciphertexts, blind index, birth date, provider
// and verified_at; every bound payout account of the user stops being current; user.realname_corrected
// is published with the old and the new id_no_hmac (never plaintext); when the user has a paid-out
// withdrawal (PAID_API / PAID_MANUAL) the old name, ID number, id_no_hmac and verified_at go to the
// isolated store first, encrypted with its own keys. The answer is the corrected real name, masked.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  NEW,
  OLD,
  OTHER,
  PRIOR,
  PROVIDER,
  REALNAME,
  accountsOf,
  body,
  cipherText,
  correct,
  decrypted,
  eventsOf,
  hmacOf,
  instant,
  maskIdNo,
  maskName,
  noPlaintext,
  ok,
  payoutAccount,
  plaintexts,
  priorValues,
  priorWritten,
  realnameOf,
  rowText,
  setup,
  user,
  verified,
  withdrawal,
} from './kit.ts';

const h = useHarness();

it('[AC-B1-27a#24] 一致即覆盖：同一行改为新姓名、身份证号、id_no_hmac、出生日期、供应商与核验时间，回脱敏后的新实名', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const before = await verified(h, target);
  const stored = await realnameOf(h, target);
  // Typed as the console agent might: blanks around, lower-case check letter.
  const typed = { name: ` ${NEW.name} `, id_no: ` ${NEW.idNo.toLowerCase()} ` };
  const response = await correct(s, target.id, body(NEW, typed));
  const data = await ok(response);
  const now = s.clock.now();
  expect(data).toEqual({
    user_id: target.id,
    realname_status: 'verified',
    masked_name: maskName(NEW.name),
    masked_id_no: maskIdNo(NEW.idNo),
    verified_at: expect.any(String),
  });
  expect(new Date(data.verified_at).getTime()).toBe(now.getTime());
  expect(s.vendor).toHaveBeenCalledTimes(1);
  expect(s.vendor).toHaveBeenCalledWith({
    app_id: s.appId,
    user_id: target.id,
    name: NEW.name,
    id_no: NEW.idNo,
  });
  const row = await realnameOf(h, target);
  expect(row).toMatchObject({
    id: before.id,
    status: 'verified',
    id_no_hmac: hmacOf(h, NEW.idNo),
    provider: PROVIDER,
    verified_at: now,
  });
  expect(row!.row_version).toBeGreaterThan(stored!.row_version);
  expect(decrypted(h, row!.name_cipher, REALNAME.name)).toBe(NEW.name);
  expect(decrypted(h, row!.id_no_cipher, REALNAME.idNo)).toBe(NEW.idNo);
  expect(decrypted(h, row!.birth_date_cipher, REALNAME.birthDate)).toBe(NEW.birth);
  noPlaintext(s, plaintexts(OLD, NEW), [response]);
});

it('[AC-B1-27a#25] 更正成功时该用户已绑定的收款账号全部失效；别的用户的账号不动', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  await payoutAccount(h, target, 'bank_card', false);
  const current = await payoutAccount(h, target, 'alipay', true);
  const neighbour = await user(h, s.appId);
  await verified(h, neighbour, OTHER);
  await payoutAccount(h, neighbour, 'alipay', true, OTHER.name);
  const mine = await accountsOf(h, target);
  const theirs = await accountsOf(h, neighbour);
  await ok(await correct(s, target.id, body()));
  const after = await accountsOf(h, target);
  expect(after.map((account) => account.id)).toEqual(mine.map((account) => account.id));
  expect(after.every((account) => !account.is_current)).toBe(true);
  const was = mine.find((account) => account.id === current)!;
  const now = after.find((account) => account.id === current)!;
  expect(now.row_version).toBeGreaterThan(was.row_version);
  expect(await accountsOf(h, neighbour)).toEqual(theirs);
});

it('[AC-B1-27a#26] 同一事务发一条 user.realname_corrected：载荷含用户与新旧 id_no_hmac，不含姓名与身份证号明文', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const before = await verified(h, target);
  await ok(await correct(s, target.id, body()));
  const events = await eventsOf(h, s.appId);
  expect(events).toHaveLength(1);
  expect(events[0]!.occurred_at).toEqual(s.clock.now());
  const payload = events[0]!.payload as unknown as { v: number; data: Record<string, unknown> };
  expect(payload.v).toBe(1);
  expect(Object.values(payload.data)).toEqual(
    expect.arrayContaining([target.id, before.hmac, hmacOf(h, NEW.idNo)]),
  );
  const text = rowText(events[0]!);
  for (const secret of plaintexts(OLD, NEW)) expect(text).not.toContain(secret);
});

it.each(['PAID_API', 'PAID_MANUAL'] as const)(
  '[AC-B1-27a#27] 旧身份名下有 %s 提现：覆盖前把旧姓名、身份证号（隔离存储独立密钥）、id_no_hmac、verified_at 迁入隔离存储',
  async (status) => {
    const s = await setup(h);
    const target = await user(h, s.appId);
    const before = await verified(h, target);
    await withdrawal(h.db, s.clock, target, 'REJECTED');
    await withdrawal(h.db, s.clock, target, status);
    await ok(await correct(s, target.id, body()));
    const written = priorWritten(s);
    expect(written).toHaveLength(1);
    const values = priorValues(written[0]!);
    expect(values['app_id']).toBe(s.appId);
    expect(values['user_id']).toBe(target.id);
    expect(values['id_no_hmac']).toBe(before.hmac);
    expect(instant(values['verified_at'])).toBe(before.verifiedAt.getTime());
    expect(instant(values['corrected_at'])).toBe(s.clock.now().getTime());
    const name = cipherText(values['name_cipher']);
    const idNo = cipherText(values['id_no_cipher']);
    expect(s.priorCrypto.decrypt(name, PRIOR.name)).toBe(OLD.name);
    expect(s.priorCrypto.decrypt(idNo, PRIOR.idNo)).toBe(OLD.idNo);
    // Not the realname ciphertexts copied over, and nothing the field keys can open.
    const stored = [name, idNo];
    for (const text of stored) {
      for (const context of [PRIOR.name, PRIOR.idNo, REALNAME.name, REALNAME.idNo]) {
        expect(() => h.fields.decrypt(text, context)).toThrow();
      }
    }
    const row = await realnameOf(h, target);
    expect(decrypted(h, row!.id_no_cipher, REALNAME.idNo)).toBe(NEW.idNo);
  },
);

it.each([
  { case: '没有任何提现', statuses: [] },
  { case: '只有驳回与失败', statuses: ['REJECTED', 'FAILED'] as const },
])('[AC-B1-27a#28] 旧身份没有到账提现（$case）不迁入隔离存储，照常更正', async ({ statuses }) => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  for (const status of statuses) await withdrawal(h.db, s.clock, target, status);
  await ok(await correct(s, target.id, body()));
  expect(s.prior).toEqual([]);
  const row = await realnameOf(h, target);
  expect(decrypted(h, row!.id_no_cipher, REALNAME.idNo)).toBe(NEW.idNo);
});
