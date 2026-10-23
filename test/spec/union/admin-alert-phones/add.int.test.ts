// B1-22g / BR-ID-24 ② 细则「后台告警手机号与重新授权会话」(D10-152 ④: one encrypted group, an
// item identified by the HMAC of the BR-ID-05-normalized number, CAS on the item version, at most
// 10, the same number again succeeds without adding), BR-ID-33 (masked 3 + 4), SPEC_REF 3a301d1.
import { expect, it } from 'vitest';
import { alertPhoneId } from '../../../../apps/api/src/modules/union/auth-expiry/service.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACTIONS,
  KEY,
  MAX_PHONES,
  accepted,
  audits,
  configRow,
  history,
  maskedOf,
  masked,
  mobiles,
  ms,
  phonesOf,
  rejected,
  seedPhones,
  serialized,
  setup,
  snapshot,
  stored,
} from './kit.ts';

const h = useHarness();
const REASON = '新增值班运营手机号';

/** Ways of entering the same number that BR-ID-05 细则 normalizes to it. */
function variants(phone: string): string[] {
  const [a, b, c] = [phone.slice(0, 3), phone.slice(3, 7), phone.slice(7)];
  const fullWidth = [...phone].map((d) => String.fromCharCode(0xff10 + Number(d))).join('');
  return [
    `+86 ${a} ${b} ${c}`,
    `+86${phone}`,
    `0086${phone}`,
    `86${phone}`,
    `${a}-${b}-${c}`,
    ` ${a} ${b} ${c} `,
    `${a}–${b}–${c}`,
    `${a}​${b}${c}`,
    fullWidth,
    phone,
  ];
}

it('[B1-22g][D10-152] 首次添加（无行，版本 0）：整组加密写入 union.auth_alert_phones、版本 1、历史一行、审计一条，响应只给脱敏号与 phone_id', async () => {
  const s = await setup(h);
  const [phone] = mobiles(1);
  expect(await phonesOf(s)).toEqual({ version: 0, items: [] });
  const response = await s.add({ phone, expected_version: 0, reason: REASON });
  const now = s.f.clock.now().getTime();
  const data = await accepted(response, 'add');
  expect(data).toEqual({
    version: 1,
    items: [{ phone_id: alertPhoneId(s.h.fields, phone!), phone_masked: masked(phone!) }],
  });
  expect(await phonesOf(s)).toEqual(data);

  const row = await configRow(s);
  expect(row).toMatchObject({ app_id: s.appId, key: KEY, version: 1 });
  expect(await stored(s)).toEqual([phone]);
  const versions = await history(s);
  expect(versions).toHaveLength(1);
  expect(versions[0]).toMatchObject({ version: 1, updated_by_admin_id: s.a.id });
  expect(versions[0]!.value).toEqual(row!.value);

  const audit = await audits(s);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ app_id: s.appId, admin_id: s.a.id, action: ACTIONS.add });
  expect(ms(audit[0]!.at)).toBe(now);
  const text = serialized(audit[0]);
  expect(text).toContain(masked(phone!));
  expect(text).toContain(REASON);
  expect(text).not.toContain(phone);
});

it('[B1-22g][D10-152] 再添加一个号码：版本 +1，组里两个号码，各自的 phone_id 不同；不给原因也行', async () => {
  const s = await setup(h);
  const [first, second] = mobiles(2);
  await seedPhones(s, [first!], 3);
  const data = await accepted(await s.add({ phone: second, expected_version: 3 }), 'add');
  expect(data.version).toBe(4);
  expect(maskedOf(data)).toEqual([masked(first!), masked(second!)].sort());
  expect(new Set(data.items.map((item) => item.phone_id)).size).toBe(2);
  expect((await stored(s))!.sort()).toEqual([first, second].sort());
  expect((await configRow(s))!.version).toBe(4);
  expect((await history(s)).map((row) => row.version)).toEqual([4]);
  expect(await phonesOf(s)).toEqual(data);
  const audit = await audits(s);
  expect(audit.map((row) => row.action)).toEqual([ACTIONS.add]);
  expect(serialized(audit[0])).toContain(masked(second!));
});

it('[B1-22g][BR-ID-05 细则] 号码先规范化：+86 / 0086 / 86 前缀、空白、连字符、全角数字都按同一号码存规范化后的 11 位', async () => {
  const s = await setup(h);
  const [phone] = mobiles(1);
  const [first, ...rest] = variants(phone!);
  const added = await accepted(await s.add({ phone: first, expected_version: 0 }), 'add');
  expect(added).toEqual({
    version: 1,
    items: [{ phone_id: alertPhoneId(s.h.fields, phone!), phone_masked: masked(phone!) }],
  });
  expect(await stored(s)).toEqual([phone]);
  for (const variant of rest) {
    const again = await accepted(await s.add({ phone: variant, expected_version: 1 }), 'add');
    expect(again, JSON.stringify(variant)).toEqual(added);
  }
  expect(await stored(s)).toEqual([phone]);
  expect((await configRow(s))!.version).toBe(1);
  expect(await history(s)).toHaveLength(1);
});

it('[B1-22g][BR-ID-24 细则] 同号重复添加照常成功：不新增、版本不变、不写配置历史，仍写一条审计', async () => {
  const s = await setup(h);
  const [kept, other] = mobiles(2);
  await seedPhones(s, [kept!, other!], 5);
  const row = await configRow(s);
  const data = await accepted(
    await s.add({ phone: `+86 ${kept!}`, expected_version: 5, reason: REASON }),
    'add',
  );
  expect(data.version).toBe(5);
  expect(maskedOf(data)).toEqual([masked(kept!), masked(other!)].sort());
  expect(await configRow(s)).toEqual(row);
  expect(await history(s)).toEqual([]);
  const audit = await audits(s);
  expect(audit.map((a) => a.action)).toEqual([ACTIONS.add]);
  expect(serialized(audit[0])).toContain(masked(kept!));
  expect(serialized(audit[0])).not.toContain(kept);
});

it('[B1-22g][BR-ID-05 细则] 规范化后不是大陆 11 位手机号 → 20001 [phone] + reason=phone_invalid，什么都不写', async () => {
  const s = await setup(h);
  const [kept] = mobiles(1);
  await seedPhones(s, [kept!], 2);
  const before = await snapshot(s);
  for (const phone of [
    '12800138000',
    '10800138000',
    '1380013800',
    '138001380001',
    '01380013800',
    '+85213800138000',
    '+1 415 555 0123',
    '008613800138',
    '138 0013 800a',
    'not-a-phone',
    '+86',
  ]) {
    await rejected(await s.add({ phone, expected_version: 2 }), 'add', 20001, {
      fields: ['phone'],
      reason: 'phone_invalid',
    });
    expect(await snapshot(s), JSON.stringify(phone)).toEqual(before);
  }
});

it('[B1-22g][契约] 请求体校验：phone 1–32 字的字符串、expected_version 非负整数、reason 1–200 字；20001 指明字段', async () => {
  const s = await setup(h);
  const [phone] = mobiles(1);
  const before = await snapshot(s);
  const cases: [Record<string, unknown>, string][] = [
    [{ expected_version: 0 }, 'phone'],
    [{ phone: '', expected_version: 0 }, 'phone'],
    [{ phone: '1'.repeat(33), expected_version: 0 }, 'phone'],
    [{ phone: Number(phone), expected_version: 0 }, 'phone'],
    [{ phone }, 'expected_version'],
    [{ phone, expected_version: -1 }, 'expected_version'],
    [{ phone, expected_version: 1.5 }, 'expected_version'],
    [{ phone, expected_version: 0, reason: '' }, 'reason'],
    [{ phone, expected_version: 0, reason: 'x'.repeat(201) }, 'reason'],
  ];
  for (const [body, field] of cases) {
    await rejected(await s.add(body), 'add', 20001, { fields: [field] });
    expect(await snapshot(s), JSON.stringify(Object.keys(body))).toEqual(before);
  }
  const data = await accepted(
    await s.add({ phone, expected_version: 0, reason: '换'.repeat(200) }),
    'add',
  );
  expect(data.version).toBe(1);
});

it(`[B1-22g][BR-ID-24 细则] 上限 ${MAX_PHONES} 个：第 ${MAX_PHONES} 个可加，再加新号 → 20001 [phone]（不带 reason），已有号码照常成功`, async () => {
  const s = await setup(h);
  const numbers = mobiles(MAX_PHONES + 1);
  const extra = numbers.pop()!;
  const last = numbers.pop()!;
  await seedPhones(s, numbers, 7);
  const full = await accepted(await s.add({ phone: last, expected_version: 7 }), 'add');
  expect(full.version).toBe(8);
  expect(full.items).toHaveLength(MAX_PHONES);

  const before = await snapshot(s);
  await rejected(await s.add({ phone: extra, expected_version: 8 }), 'add', 20001, {
    fields: ['phone'],
  });
  expect(await snapshot(s)).toEqual(before);

  // The same number when full: success, nothing added (checked before the limit).
  const same = await accepted(await s.add({ phone: `+86${last}`, expected_version: 8 }), 'add');
  expect(same.version).toBe(8);
  expect(same.items).toHaveLength(MAX_PHONES);
  expect((await stored(s))!.sort()).toEqual([...numbers, last].sort());
});

it('[B1-22g][契约] 检查顺序：号码不合格先于版本冲突；版本冲突先于同号与上限', async () => {
  const s = await setup(h);
  const numbers = mobiles(MAX_PHONES + 1);
  const extra = numbers.pop()!;
  await seedPhones(s, numbers, 6);
  const before = await snapshot(s);
  // phone_invalid before CAS.
  await rejected(await s.add({ phone: '12800138000', expected_version: 5 }), 'add', 20001, {
    fields: ['phone'],
    reason: 'phone_invalid',
  });
  // CAS before "already present".
  await rejected(await s.add({ phone: numbers[0], expected_version: 5 }), 'add', 20902, {
    resource: 'config_item',
  });
  // CAS before "already 10".
  await rejected(await s.add({ phone: extra, expected_version: 7 }), 'add', 20902, {
    resource: 'config_item',
  });
  expect(await snapshot(s)).toEqual(before);
});
