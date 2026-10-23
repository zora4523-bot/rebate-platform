// B1-27b · the audit record of a save (BR-ID-44 细则「编辑范围」: operator, reason, the fields changed
// with before / after values, phone numbers masked; contract adminEditUserProfile: one record
// user_profile_edit per successful save, no changed field → empty changes). The record's layout is
// the implementation's: these cases read the whole row as text. admin's audit writer replaces the
// value of any key naming a phone unless the key ends with `masked` (audit-redaction.ts), so the
// masked numbers must survive under such a key.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACTION,
  REASON,
  added,
  auditText,
  audits,
  edit,
  hmacOf,
  masked,
  member,
  noPlaintext,
  ok,
  setup,
  testPhone,
  user,
  type AuditRow,
  type Setup,
} from './kit.ts';

const h = useHarness();

function common(entry: AuditRow, s: Setup, adminId: string, userId: string) {
  expect(entry).toMatchObject({ app_id: s.appId, admin_id: adminId, action: ACTION });
  expect(entry.at).toEqual(s.clock.now());
  const text = auditText(entry);
  expect(text).toContain(REASON);
  expect(entry.target === userId || text.includes(userId)).toBe(true);
  return text;
}

it.each([true, false])(
  '[AC-B1-27b#33] 改手机号（超管=%s）写一条 user_profile_edit：操作人、原因、新旧号码只以 3+4 脱敏出现',
  async (isSuper) => {
    const s = await setup(h);
    const admin = isSuper ? undefined : await member(s, ['user.phone_change']);
    const target = await user(h, s.appId);
    const next = testPhone();
    const before = await audits(h, s.appId);
    const response = await edit(
      s,
      target.id,
      { phone: next, reason: REASON },
      admin === undefined ? {} : { as: admin },
    );
    await ok(response);
    const rows = added(before, await audits(h, s.appId));
    expect(rows).toHaveLength(1);
    const text = common(rows[0]!, s, admin?.who.id ?? s.actor.id, target.id);
    expect(text).toContain(masked(target.phone!));
    expect(text).toContain(masked(next));
    for (const secret of [target.phone!, next, target.hmac!, hmacOf(h, next)]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain(target.cipher!.toString('utf8'));
    noPlaintext(s, [target.phone, next], response);
  },
);

it('[AC-B1-27b#34] 改昵称的审计带新旧昵称与原因；没改的手机号不进审计', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const before = await audits(h, s.appId);
  await ok(await edit(s, target.id, { nickname: '小狸', reason: REASON }));
  const rows = added(before, await audits(h, s.appId));
  expect(rows).toHaveLength(1);
  const text = common(rows[0]!, s, s.actor.id, target.id);
  expect(text).toContain(target.nickname);
  expect(text).toContain('小狸');
  expect(text).not.toContain(masked(target.phone!));
  expect(text).not.toContain(target.phone!);
});

it('[AC-B1-27b#35] 什么都没改的保存也记一条审计，改动字段为空：不含现号码与现昵称', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const before = await audits(h, s.appId);
  const body = { phone: target.phone, nickname: ` ${target.nickname} `, reason: REASON };
  await ok(await edit(s, target.id, body));
  const rows = added(before, await audits(h, s.appId));
  expect(rows).toHaveLength(1);
  const text = common(rows[0]!, s, s.actor.id, target.id);
  expect(text).not.toContain(masked(target.phone!));
  expect(text).not.toContain(target.phone!);
  expect(text).not.toContain(target.nickname);
});

it('[AC-B1-27b#36] 每次成功保存各记一条审计：同一管理员两次改同一用户得到两条', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const before = await audits(h, s.appId);
  await ok(await edit(s, target.id, { nickname: '小狸', reason: REASON }));
  await ok(await edit(s, target.id, { nickname: '狸花', reason: `${REASON}（二次核对）` }));
  const rows = added(before, await audits(h, s.appId));
  expect(rows).toHaveLength(2);
  expect(auditText(rows[0]!)).toContain('小狸');
  expect(auditText(rows[1]!)).toContain('狸花');
  expect(auditText(rows[1]!)).toContain('（二次核对）');
});
