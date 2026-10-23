// B1-22g / BR-ID-33 (encrypted storage, masked display), BR-ID-24 细则「后台联盟账号列表」「后台告警手机号
// 与重新授权会话」(D10-152 ④: one encrypted group in union.auth_alert_phones; the full number is never
// returned), SPEC_REF 3a301d1: no plaintext number in the database, responses, audit rows or logs.
import { expect, it } from 'vitest';
import {
  alertPhoneId,
  decodeAlertPhones,
} from '../../../../apps/api/src/modules/union/auth-expiry/service.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import { expectNoSecrets } from '../admin-accounts/kit.ts';
import {
  accepted,
  audits,
  configRow,
  history,
  idOf,
  masked,
  mobiles,
  phonesOf,
  rejected,
  serialized,
  setup,
} from './kit.ts';

const h = useHarness();

it('[B1-22g][BR-ID-33] 库里只有整组密文，可用同一 FieldCrypto 解回规范化号码；历史版本同样是密文', async () => {
  const s = await setup(h);
  const [a, b] = mobiles(2);
  const first = await accepted(await s.add({ phone: `+86 ${a!}`, expected_version: 0 }), 'add');
  await accepted(await s.add({ phone: b, expected_version: first.version }), 'add');
  const row = await configRow(s);
  expect(row).toBeDefined();
  expect(typeof row!.value === 'object' && !Array.isArray(row!.value)).toBe(true);
  expect(decodeAlertPhones(s.h.fields, row!.value).sort()).toEqual([a, b].sort());
  const versions = await history(s);
  expect(versions.map((v) => v.version)).toEqual([1, 2]);
  expect(decodeAlertPhones(s.h.fields, versions[0]!.value)).toEqual([a]);
  expect(decodeAlertPhones(s.h.fields, versions[1]!.value).sort()).toEqual([a, b].sort());
  // B1-22b's monitor finds each number under the same phone_id the console shows.
  const list = await phonesOf(s);
  for (const phone of [a!, b!]) expect(idOf(list, phone)).toBe(alertPhoneId(s.h.fields, phone));
  expectNoSecrets([row, versions], [a!, b!]);
});

it('[B1-22g][BR-ID-33] 明文号码不出现在响应、错误、审计与日志里；响应也不带密文', async () => {
  const s = await setup(h);
  const [a, b, c] = mobiles(3);
  const responses: unknown[] = [];
  const keep = async (response: Awaited<ReturnType<typeof s.listPhones>>) => {
    responses.push(response.json());
    return response;
  };
  const one = await accepted(
    await keep(await s.add({ phone: `+86 ${a!}`, expected_version: 0, reason: '值班' })),
    'add',
  );
  const two = await accepted(await keep(await s.add({ phone: b, expected_version: 1 })), 'add');
  await accepted(await keep(await s.add({ phone: `0086${b!}`, expected_version: 2 })), 'add');
  await rejected(await keep(await s.add({ phone: c, expected_version: 1 })), 'add', 20902, {
    resource: 'config_item',
  });
  await accepted(await keep(await s.listPhones()), 'list');
  await rejected(
    await keep(await s.remove({ phone_id: alertPhoneId(s.h.fields, c!), expected_version: 2 })),
    'remove',
    20001,
    { fields: ['phone_id'] },
  );
  await accepted(
    await keep(await s.remove({ phone_id: idOf(two, a!), expected_version: 2 })),
    'remove',
  );
  expect(one.items.map((item) => item.phone_masked)).toEqual([masked(a!)]);

  const auditRows = await audits(s);
  expect(auditRows).toHaveLength(4);
  const secrets = [a!, b!, c!, `+86 ${a!}`, `0086${b!}`];
  expectNoSecrets([responses, auditRows, s.f.lines], secrets);
  expect(s.f.lines.length).toBeGreaterThan(0);

  const cipher = serialized((await configRow(s))!.value);
  for (const response of responses) {
    for (const item of (await history(s)).map((v) => serialized(v.value))) {
      expect(serialized(response)).not.toContain(item);
    }
    expect(serialized(response)).not.toContain(cipher);
    expect(serialized(response)).not.toContain('cipher');
  }
});
