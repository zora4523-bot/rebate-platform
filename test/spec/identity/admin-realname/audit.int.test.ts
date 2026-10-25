// B1-27a · the audit record of every submission (08 BR-ID-25 细则「实名更正」审计; BR-ID-33; contract
// adminCorrectUserRealname; task §9 ⑤): each submission that passes the permission, step-up and
// body checks writes one user_realname_correct record — operator, reason, result code, the new
// value masked or its id_no_hmac — refusals included (written on their own, so they stay); a
// success also records the masked before and after values. No name or ID number in plaintext in
// the record, the logs or the answers. The record's layout is the implementation's: these cases
// read the whole row as text. admin's audit writer replaces the value of any key naming an HMAC,
// cipher or ID number unless the key ends with `masked` (audit-redaction.ts).
import { expect, it } from 'vitest';
import { useHarness, type Response } from '../../admin/auth/kit.ts';
import {
  ACTION,
  MINOR,
  NEW,
  OLD,
  OTHER,
  PERMISSION,
  PROVIDER,
  REASON,
  added,
  audits,
  blacklisted,
  body,
  correct,
  hmacOf,
  identity,
  maskIdNo,
  maskName,
  member,
  noPlaintext,
  ok,
  plaintexts,
  rejected,
  rowText,
  setup,
  user,
  verified,
  withdrawal,
  wrongCheckDigit,
  type AuditRow,
  type Identity,
  type Setup,
} from './kit.ts';

const h = useHarness();

function common(entry: AuditRow, s: Setup, adminId: string, userId: string): string {
  expect(entry).toMatchObject({ app_id: s.appId, admin_id: adminId, action: ACTION });
  expect(entry.at).toEqual(s.clock.now());
  const text = rowText(entry);
  expect(text).toContain(REASON);
  expect(entry.target === userId || text.includes(userId)).toBe(true);
  return text;
}

/** The submitted new value, masked or as its id_no_hmac. */
function newValueIn(text: string, who: Identity): boolean {
  return text.includes(maskIdNo(who.idNo)) || text.includes(hmacOf(h, who.idNo));
}

it.each([true, false])(
  '[AC-B1-27a#31] 成功（超管=%s）写一条 user_realname_correct：操作人、原因、结果、前后值只以脱敏出现',
  async (isSuper) => {
    const s = await setup(h);
    const admin = isSuper ? undefined : await member(s, [PERMISSION]);
    const target = await user(h, s.appId);
    await verified(h, target);
    const before = await audits(h, s.appId);
    const response = await correct(s, target.id, body(), admin === undefined ? {} : { as: admin });
    await ok(response);
    const rows = added(before, await audits(h, s.appId));
    expect(rows).toHaveLength(1);
    const text = common(rows[0]!, s, admin?.who.id ?? s.actor.id, target.id);
    for (const masked of [
      maskIdNo(OLD.idNo),
      maskIdNo(NEW.idNo),
      maskName(OLD.name),
      maskName(NEW.name),
    ]) {
      expect(text).toContain(masked);
    }
    for (const secret of plaintexts(OLD, NEW)) expect(text).not.toContain(secret);
    noPlaintext(s, plaintexts(OLD, NEW), [response]);
  },
);

it('[AC-B1-27a#32] 每次被拒的提交各写一条审计，带结果码与新值的脱敏串（或 HMAC），不含明文', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  const occupant = await user(h, s.appId);
  await verified(h, occupant, OTHER);
  const blocked = identity('林小溪', '450103', '1991-02-14', '079');
  await blacklisted(h, s.appId, blocked.idNo);
  const responses: Response[] = [];
  const submit = async (payload: Record<string, unknown>, code: number) => {
    const before = await audits(h, s.appId);
    const response = await correct(s, target.id, payload);
    responses.push(response);
    await rejected(response, code);
    const rows = added(before, await audits(h, s.appId));
    expect(rows, `${code} 写一条审计`).toHaveLength(1);
    const text = common(rows[0]!, s, s.actor.id, target.id);
    expect(text, `${code} 结果码`).toContain(String(code));
    return text;
  };

  await submit(body(NEW, { id_no: wrongCheckDigit(NEW.idNo) }), 20001);
  expect(newValueIn(await submit(body(blocked), 44001), blocked)).toBe(true);
  expect(newValueIn(await submit(body(MINOR), 30407), MINOR)).toBe(true);
  expect(newValueIn(await submit(body(OTHER), 30405), OTHER)).toBe(true);
  s.vendor.mockResolvedValueOnce({ outcome: 'mismatch', provider: PROVIDER });
  expect(newValueIn(await submit(body(NEW), 30406), NEW)).toBe(true);
  s.vendor.mockResolvedValueOnce({ outcome: 'timeout' });
  expect(newValueIn(await submit(body(NEW), 50401), NEW)).toBe(true);
  s.vendor.mockResolvedValueOnce({ outcome: 'unavailable' });
  expect(newValueIn(await submit(body(NEW), 50301), NEW)).toBe(true);
  await withdrawal(h.db, s.clock, target, 'PAYING');
  expect(newValueIn(await submit(body(NEW), 30419), NEW)).toBe(true);

  const rows = await audits(h, s.appId);
  const text = rows.map(rowText).join('\n');
  for (const secret of plaintexts(OLD, NEW, OTHER, MINOR, blocked)) {
    expect(text).not.toContain(secret);
  }
  noPlaintext(s, plaintexts(OLD, NEW, OTHER, MINOR, blocked), responses);
});

it('[AC-B1-27a#33] 同一管理员两次成功更正同一用户得到两条审计，各带自己的原因', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  const before = await audits(h, s.appId);
  await ok(await correct(s, target.id, body(NEW)));
  const again = `${REASON}（二次核对改姓名用字）`;
  await ok(await correct(s, target.id, body({ ...NEW, name: '林小雪' }, { reason: again })));
  const rows = added(before, await audits(h, s.appId));
  expect(rows).toHaveLength(2);
  expect(rowText(rows[0]!)).not.toContain('（二次核对改姓名用字）');
  expect(rowText(rows[1]!)).toContain('（二次核对改姓名用字）');
  expect(rowText(rows[1]!)).toContain(maskName('林小雪'));
  expect(rowText(rows[0]!)).not.toContain(maskName('林小雪'));
});
