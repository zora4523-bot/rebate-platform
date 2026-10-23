// B1-22g / BR-ID-24 ② 细则「后台告警手机号与重新授权会话」(D10-152 ④: removal by phone_id, the
// HMAC of the normalized number; CAS on the item version), 04 §6.6 (query holds only identifiers),
// SPEC_REF 3a301d1.
import { expect, it } from 'vitest';
import { alertPhoneId } from '../../../../apps/api/src/modules/union/auth-expiry/service.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import { listed, seedAccount } from '../admin-accounts/kit.ts';
import {
  ACTIONS,
  accepted,
  audits,
  configRow,
  history,
  idOf,
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

it('[B1-22g][D10-152] 按列表里的 phone_id 删除：版本 +1、组里少这一个、历史一行、审计一条（脱敏号，无明文）', async () => {
  const s = await setup(h);
  const [gone, kept] = mobiles(2);
  await seedPhones(s, [gone!, kept!], 4);
  const list = await phonesOf(s);
  expect(list.version).toBe(4);
  const response = await s.remove({ phone_id: idOf(list, gone!), expected_version: 4 });
  const now = s.f.clock.now().getTime();
  const data = await accepted(response, 'remove');
  expect(data).toEqual({
    version: 5,
    items: [{ phone_id: alertPhoneId(s.h.fields, kept!), phone_masked: masked(kept!) }],
  });
  expect(await phonesOf(s)).toEqual(data);
  expect(await stored(s)).toEqual([kept]);
  const row = await configRow(s);
  expect(row!.version).toBe(5);
  const versions = await history(s);
  expect(versions).toHaveLength(1);
  expect(versions[0]).toMatchObject({ version: 5, updated_by_admin_id: s.a.id });
  expect(versions[0]!.value).toEqual(row!.value);

  const audit = await audits(s);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ app_id: s.appId, admin_id: s.a.id, action: ACTIONS.remove });
  expect(ms(audit[0]!.at)).toBe(now);
  expect(serialized(audit[0])).toContain(masked(gone!));
  expect(serialized(audit[0])).not.toContain(gone);
  expect(serialized(audit[0])).not.toContain(kept);
});

it('[B1-22g][BR-ID-24 ②] 删掉最后一个号码：组变空（仍是加密组）、版本 +1；联盟账号列表变为未配置告警手机号', async () => {
  const s = await setup(h);
  const account = await seedAccount(s, { platform: 'taobao' });
  const configured = async () =>
    (await listed(s)).find((item) => item.union_account_id === account.id)?.alert_phones_configured;
  expect(await configured()).toBe(false);
  const [phone] = mobiles(1);
  const added = await accepted(await s.add({ phone, expected_version: 0 }), 'add');
  expect(await phonesOf(s)).toEqual(added);
  expect(await configured()).toBe(true);
  const data = await accepted(
    await s.remove({ phone_id: idOf(added, phone!), expected_version: added.version }),
    'remove',
  );
  expect(data).toEqual({ version: 2, items: [] });
  expect(await stored(s)).toEqual([]);
  expect((await configRow(s))!.version).toBe(2);
  expect((await history(s)).map((row) => row.version)).toEqual([1, 2]);
  expect((await audits(s)).map((row) => row.action)).toEqual([ACTIONS.add, ACTIONS.remove]);
  expect(await configured()).toBe(false);
});

it('[B1-22g][D10-152] 掩码相同的两个号码各有自己的 phone_id，只删指定的那一个', async () => {
  const s = await setup(h);
  const first = '13912340001';
  const second = '13987650001';
  expect(masked(first)).toBe(masked(second));
  await seedPhones(s, [first, second], 1);
  const list = await phonesOf(s);
  expect(maskedOf(list)).toEqual([masked(first), masked(first)]);
  const firstId = alertPhoneId(s.h.fields, first);
  expect(list.items.map((item) => item.phone_id).sort()).toEqual(
    [firstId, alertPhoneId(s.h.fields, second)].sort(),
  );
  const data = await accepted(await s.remove({ phone_id: firstId, expected_version: 1 }), 'remove');
  expect(data.items).toEqual([
    { phone_id: alertPhoneId(s.h.fields, second), phone_masked: masked(second) },
  ]);
  expect(await stored(s)).toEqual([second]);
});

it('[B1-22g][契约] phone_id 不在组里 → 20001 [phone_id]；组从未写过（版本 0）也一样，且不建行', async () => {
  const s = await setup(h);
  const [unknown, kept] = mobiles(2);
  const unknownId = alertPhoneId(s.h.fields, unknown!);
  await rejected(await s.remove({ phone_id: unknownId, expected_version: 0 }), 'remove', 20001, {
    fields: ['phone_id'],
  });
  expect(await snapshot(s)).toEqual({ config: undefined, history: [], audits: [] });

  await seedPhones(s, [kept!], 2);
  const before = await snapshot(s);
  await rejected(await s.remove({ phone_id: unknownId, expected_version: 2 }), 'remove', 20001, {
    fields: ['phone_id'],
  });
  expect(await snapshot(s)).toEqual(before);
});

it('[B1-22g][契约] query 缺失或格式不对 → 20001 指明 phone_id / expected_version，什么都不写', async () => {
  const s = await setup(h);
  const [kept] = mobiles(1);
  await seedPhones(s, [kept!], 2);
  const id = alertPhoneId(s.h.fields, kept!);
  const before = await snapshot(s);
  const cases: [Record<string, string | number>, string][] = [
    [{ expected_version: 2 }, 'phone_id'],
    [{ phone_id: '', expected_version: 2 }, 'phone_id'],
    [{ phone_id: 'not an id!', expected_version: 2 }, 'phone_id'],
    [{ phone_id: 'a'.repeat(129), expected_version: 2 }, 'phone_id'],
    [{ phone_id: id }, 'expected_version'],
    [{ phone_id: id, expected_version: 'abc' }, 'expected_version'],
    [{ phone_id: id, expected_version: -1 }, 'expected_version'],
    [{ phone_id: id, expected_version: '1.5' }, 'expected_version'],
  ];
  for (const [values, field] of cases) {
    await rejected(await s.remove(values), 'remove', 20001, { fields: [field] });
    expect(await snapshot(s), JSON.stringify(values)).toEqual(before);
  }
  expect(await stored(s)).toEqual([kept]);
});

it('[B1-22g][契约] 检查顺序：版本冲突先于 phone_id 不在组里', async () => {
  const s = await setup(h);
  const [kept, unknown] = mobiles(2);
  await seedPhones(s, [kept!], 3);
  const before = await snapshot(s);
  await rejected(
    await s.remove({ phone_id: alertPhoneId(s.h.fields, unknown!), expected_version: 2 }),
    'remove',
    20902,
    { resource: 'config_item' },
  );
  expect(await snapshot(s)).toEqual(before);
});
