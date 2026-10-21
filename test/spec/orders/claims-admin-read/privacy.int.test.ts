import { randomInt } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import { detail, page, rejected, seed, setup } from './kit.ts';

const h = useHarness();

it('[AC-B1-10j#24] 列表和详情手机号只下发 3+4 脱敏串，没有手机号则 null，日志不含明文', async () => {
  const s = await setup(h);
  // Generate a synthetic phone in memory; no plaintext phone fixture is stored in the repository.
  const phone = `138${String(randomInt(100_000_000)).padStart(8, '0')}`;
  const masked = `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  await h.db
    .updateTable('users')
    .set({
      phone_cipher: Buffer.from(h.fields.encrypt(phone, 'users.phone')),
      phone_hmac: h.fields.blindIndex(phone, 'users.phone'),
    })
    .where('app_id', '=', s.appId)
    .where('id', '=', s.userId)
    .execute();
  const c = await seed(s);
  const withoutPhone = await seed(s, { user_id: await seedUser(h.db, s.appId) });
  const p = await page(await s.get());
  expect(p.items.find((i) => i.claim_id === c.id)?.user).toEqual({
    user_id: s.userId,
    phone_masked: masked,
  });
  expect(p.items.find((i) => i.claim_id === withoutPhone.id)?.user.phone_masked).toBeNull();
  const d = await detail(await s.get({}, c.id));
  expect(d.user).toEqual({ user_id: s.userId, phone_masked: masked });
  expect((await detail(await s.get({}, withoutPhone.id))).user.phone_masked).toBeNull();
  const exposed = JSON.stringify([p, d, s.f.lines]);
  expect(exposed.includes(phone)).toBe(false);
  expect(exposed).not.toMatch(/"(?:phone_cipher|phone_hmac|phone)"\s*:/);
});

it('[AC-B1-10j#25] 重复读列表及详情无审核、归属或审计写入，忽略无效动态码头', async () => {
  const s = await setup(h);
  const c = await seed(s, { status: 'auto_matched', evidence_level: 'strong' });
  const before = await s.snapshot();
  for (let n = 0; n < 2; n += 1) {
    expect(
      (await page(await s.get({}, undefined, { 'x-step-up-token': 'unused-invalid' }))).total,
    ).toBe(1);
    expect(
      (await detail(await s.get({}, c.id, { 'x-step-up-token': 'unused-invalid' }))).status,
    ).toBe('auto_matched');
  }
  expect(await s.snapshot()).toEqual(before);
});

it('[AC-B1-10j#26] 拒绝读取同样不新增审计记录', async () => {
  const s = await setup(h, { grants: ['user.lookup'] });
  const c = await seed(s);
  const before = await s.snapshot();
  await rejected(await s.get(), 10403, { reason: 'admin_permission_denied' });
  await rejected(await s.get({}, c.id), 10403, { reason: 'admin_permission_denied' });
  expect(await s.snapshot()).toEqual(before);
});
