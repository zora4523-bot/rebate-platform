// B1-27a · after the not-accepted cases, the checks of the user's own real-name verification in
// order (08 BR-ID-25 细则「实名更正」校验, D10-165; D10-185 / D10-192 for 44001; task §9 ①):
// 20001 format of id_no → 44001 new number blacklisted (no risk_hits) → 30407 age (BR-ID-26) →
// 30405 verified on another account of this app (the user's own current value does not count) →
// vendor (30406 mismatch; 50401 / 50301 save nothing). A refusal leaves the stored real name as it
// was; none is counted against the user's 3 attempts a day (no 30410 here).
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  MINOR,
  NEW,
  OLD,
  OTHER,
  PROVIDER,
  body,
  blacklisted,
  correct,
  decrypted,
  identity,
  ok,
  priorWritten,
  REALNAME,
  realnameOf,
  rejected,
  setup,
  snapshot,
  user,
  verified,
  wrongCheckDigit,
  type Setup,
} from './kit.ts';

const h = useHarness();

async function verifiedTarget(s: Setup) {
  const target = await user(h, s.appId);
  const before = await verified(h, target);
  return { target, before };
}

it.each([
  { case: '校验位错', idNo: wrongCheckDigit(NEW.idNo) },
  { case: '17 位', idNo: NEW.idNo.slice(0, 17) },
  { case: '出生日期不存在', idNo: '44030519960231028X' },
  { case: '空串', idNo: '' },
])(
  '[AC-B1-27a#13] 新身份证号格式不对（$case）→ 20001 data.fields=[id_no]，不调供应商、原实名不动',
  async ({ idNo }) => {
    const s = await setup(h);
    const { target } = await verifiedTarget(s);
    const before = await snapshot(h, s.appId);
    await rejected(await correct(s, target.id, body(NEW, { id_no: idNo })), 20001, {
      fields: ['id_no'],
    });
    expect(s.vendor).not.toHaveBeenCalled();
    expect(await snapshot(h, s.appId)).toEqual(before);
  },
);

it('[AC-B1-27a#14] 新身份证号在黑名单 → 44001：不调供应商、不记 risk_hits、原实名不动', async () => {
  const s = await setup(h);
  const { target } = await verifiedTarget(s);
  await blacklisted(h, s.appId, NEW.idNo);
  const before = await snapshot(h, s.appId);
  await rejected(await correct(s, target.id, body(NEW)), 44001);
  expect(s.vendor).not.toHaveBeenCalled();
  // riskHits included: the console-side 44001 is no blocked request (BR-ID-36).
  expect(await snapshot(h, s.appId)).toEqual(before);
});

it('[AC-B1-27a#15] 44001 在 30407 与 30405 之前：未成年且在黑名单、他人已实名且在黑名单都回 44001', async () => {
  const s = await setup(h);
  const { target } = await verifiedTarget(s);
  const occupant = await user(h, s.appId);
  await verified(h, occupant, OTHER);
  await blacklisted(h, s.appId, MINOR.idNo);
  await blacklisted(h, s.appId, OTHER.idNo);
  await rejected(await correct(s, target.id, body(MINOR)), 44001);
  await rejected(await correct(s, target.id, body(OTHER)), 44001);
  expect(s.vendor).not.toHaveBeenCalled();
});

it('[AC-B1-27a#16] 新身份证号未满 14 周岁 → 30407（在 30405 之前），不调供应商、原实名不动', async () => {
  const s = await setup(h);
  const { target } = await verifiedTarget(s);
  const before = await snapshot(h, s.appId);
  await rejected(await correct(s, target.id, body(MINOR)), 30407);
  expect(await snapshot(h, s.appId)).toEqual(before);
  // A verified minor number of another account still answers 30407, not 30405.
  const other = await user(h, s.appId);
  await verified(h, other, MINOR);
  await rejected(await correct(s, target.id, body(MINOR)), 30407);
  expect(s.vendor).not.toHaveBeenCalled();
});

it('[AC-B1-27a#17] BR-ID-26 口径：生日当天未满、次日 00:00（+08:00）起满 14 周岁', async () => {
  const s = await setup(h);
  const { target } = await verifiedTarget(s);
  // NOW is 2026-10-09T10:00+08:00: born 2012-10-09 turns 14 at 2026-10-10T00:00+08:00.
  const turning = identity('林小芽', '440305', '2012-10-09', '057');
  const turned = identity('林小苗', '440305', '2012-10-08', '068');
  await rejected(await correct(s, target.id, body(turning)), 30407);
  expect(s.vendor).not.toHaveBeenCalled();
  await ok(await correct(s, target.id, body(turned)));
  expect(s.vendor).toHaveBeenCalledTimes(1);
});

it('[AC-B1-27a#18] 新身份证号已在本 App 他人名下实名 → 30405：不调供应商、不透露对方、原实名不动', async () => {
  const s = await setup(h);
  const { target } = await verifiedTarget(s);
  const occupant = await user(h, s.appId);
  await verified(h, occupant, OTHER);
  const before = await snapshot(h, s.appId);
  const response = await correct(s, target.id, body(OTHER));
  await rejected(response, 30405);
  expect(JSON.stringify(response.json())).not.toContain(occupant.id);
  expect(s.vendor).not.toHaveBeenCalled();
  expect(await snapshot(h, s.appId)).toEqual(before);
});

it('[AC-B1-27a#19] 别的 App 已实名同一号码不算占用；与本人原值相同也不算：只改姓名照常核验', async () => {
  const s = await setup(h);
  const { target } = await verifiedTarget(s);
  const elsewhere = await user(h, `${s.appId}-other`);
  await verified(h, elsewhere, NEW);
  await ok(await correct(s, target.id, body(NEW)));
  const renamed = { ...NEW, name: '林晓雨' };
  await ok(await correct(s, target.id, body(renamed)));
  expect(s.vendor).toHaveBeenCalledTimes(2);
  expect(s.vendor.mock.calls[1]![0]).toEqual({
    app_id: s.appId,
    user_id: target.id,
    name: renamed.name,
    id_no: NEW.idNo,
  });
  const row = await realnameOf(h, target);
  expect(decrypted(h, row!.name_cipher, REALNAME.name)).toBe(renamed.name);
  expect(decrypted(h, row!.id_no_cipher, REALNAME.idNo)).toBe(NEW.idNo);
});

it('[AC-B1-27a#20] 供应商不一致 → 30406：原实名信息不动（仍为 verified 与旧值），不迁旧身份', async () => {
  const s = await setup(h);
  const { target } = await verifiedTarget(s);
  s.vendor.mockResolvedValue({ outcome: 'mismatch', provider: PROVIDER });
  const before = await snapshot(h, s.appId);
  await rejected(await correct(s, target.id, body(NEW)), 30406);
  expect(s.vendor).toHaveBeenCalledTimes(1);
  expect(await snapshot(h, s.appId)).toEqual(before);
  const row = await realnameOf(h, target);
  expect(row!.status).toBe('verified');
  expect(decrypted(h, row!.id_no_cipher, REALNAME.idNo)).toBe(OLD.idNo);
  expect(priorWritten(s)).toEqual([]);
});

it.each([
  { case: '超时', answer: { outcome: 'timeout' } as const, code: 50401 },
  { case: '不可用', answer: { outcome: 'unavailable' } as const, code: 50301 },
])('[AC-B1-27a#21] 供应商$case → $code，什么都不保存', async ({ answer, code }) => {
  const s = await setup(h);
  const { target } = await verifiedTarget(s);
  s.vendor.mockResolvedValue(answer);
  const before = await snapshot(h, s.appId);
  await rejected(await correct(s, target.id, body(NEW)), code);
  expect(s.vendor).toHaveBeenCalledTimes(1);
  expect(await snapshot(h, s.appId)).toEqual(before);
  expect(priorWritten(s)).toEqual([]);
});

it('[AC-B1-27a#22] 供应商抛错按不可用 50301；没有装配供应商也是 50301，什么都不保存', async () => {
  const s = await setup(h);
  const { target } = await verifiedTarget(s);
  s.vendor.mockRejectedValue(new Error(`vendor echoed ${NEW.name} ${NEW.idNo}`));
  const before = await snapshot(h, s.appId);
  const response = await correct(s, target.id, body(NEW));
  await rejected(response, 50301);
  expect(JSON.stringify(response.json())).not.toContain(NEW.idNo);
  expect(s.lines.join('\n')).not.toContain(NEW.idNo);
  expect(await snapshot(h, s.appId)).toEqual(before);

  const absent = await setup(h, { verifierAbsent: true });
  const other = await user(h, absent.appId);
  await verified(h, other);
  const untouched = await snapshot(h, absent.appId);
  await rejected(await correct(absent, other.id, body(NEW)), 50301);
  expect(await snapshot(h, absent.appId)).toEqual(untouched);
});

it('[AC-B1-27a#23] 不计每日 3 次：同一用户当天连续 4 次不一致都回 30406 并各调一次供应商，第 5 次一致即更正', async () => {
  const s = await setup(h);
  const { target } = await verifiedTarget(s);
  s.vendor.mockResolvedValue({ outcome: 'mismatch', provider: PROVIDER });
  for (let i = 0; i < 4; i += 1) {
    await rejected(await correct(s, target.id, body(NEW)), 30406);
  }
  expect(s.vendor).toHaveBeenCalledTimes(4);
  s.vendor.mockResolvedValue({ outcome: 'match', provider: PROVIDER });
  await ok(await correct(s, target.id, body(NEW)));
  expect(s.vendor).toHaveBeenCalledTimes(5);
});
