// B1-22g / BR-ID-24 细则「后台告警手机号与重新授权会话」(D10-152 ④: adds and removals are CAS on
// the version of the configuration item; 0 = never written), content's dedicated write port
// (D10-281), SPEC_REF 3a301d1: 20902 with data.resource=config_item, nothing written.
import { expect, it } from 'vitest';
import { alertPhoneId } from '../../../../apps/api/src/modules/union/auth-expiry/service.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACTIONS,
  accepted,
  audits,
  configRow,
  history,
  maskedOf,
  masked,
  mobiles,
  phonesOf,
  rejected,
  seedPhones,
  setup,
  signIn,
  snapshot,
  stored,
} from './kit.ts';

const h = useHarness();
const CONFLICT = { resource: 'config_item' };

it('[B1-22g][D10-152] 组从未写过时当前版本为 0：expected_version 非 0 → 20902 且不建行；0 → 写入版本 1', async () => {
  const s = await setup(h);
  const [phone] = mobiles(1);
  for (const version of [1, 2]) {
    await rejected(await s.add({ phone, expected_version: version }), 'add', 20902, CONFLICT);
  }
  expect(await snapshot(s)).toEqual({ config: undefined, history: [], audits: [] });
  const data = await accepted(await s.add({ phone, expected_version: 0 }), 'add');
  expect(data.version).toBe(1);
});

it('[B1-22g][D10-152] 新增与删除拒绝旧版本与未来版本：20902，配置、历史与审计都不变', async () => {
  const s = await setup(h);
  const [kept, fresh] = mobiles(2);
  await seedPhones(s, [kept!], 5);
  const keptId = alertPhoneId(s.h.fields, kept!);
  const before = await snapshot(s);
  for (const version of [0, 4, 6]) {
    await rejected(
      await s.add({ phone: fresh, expected_version: version }),
      'add',
      20902,
      CONFLICT,
    );
    await rejected(
      await s.remove({ phone_id: keptId, expected_version: version }),
      'remove',
      20902,
      CONFLICT,
    );
    expect(await snapshot(s), String(version)).toEqual(before);
  }
});

it('[B1-22g][D10-152] 别人先改了组：拿旧版本再写 → 20902；刷新列表取新版本后重试成功', async () => {
  const s = await setup(h);
  const other = await signIn(h, s.f, s.appId);
  const [kept, mine, theirs] = mobiles(3);
  await seedPhones(s, [kept!], 2);
  const seen = await phonesOf(s);
  await accepted(await other.add({ phone: theirs, expected_version: seen.version }), 'add');
  const before = await snapshot(s);
  await rejected(
    await s.add({ phone: mine, expected_version: seen.version }),
    'add',
    20902,
    CONFLICT,
  );
  await rejected(
    await s.remove({ phone_id: alertPhoneId(s.h.fields, kept!), expected_version: seen.version }),
    'remove',
    20902,
    CONFLICT,
  );
  expect(await snapshot(s)).toEqual(before);
  const fresh = await phonesOf(s);
  expect(fresh.version).toBe(3);
  const data = await accepted(await s.add({ phone: mine, expected_version: 3 }), 'add');
  expect(data.version).toBe(4);
  expect(maskedOf(data)).toEqual([masked(kept!), masked(mine!), masked(theirs!)].sort());
});

for (const start of [0, 3]) {
  it(`[B1-22g][D10-152] 同一版本（${start}）并发两笔新增只能一笔成功，败者 20902；只有一个新号码、一条历史、一条审计`, async () => {
    const s = await setup(h);
    const other = await signIn(h, s.f, s.appId);
    const [kept, a, b] = mobiles(3);
    if (start > 0) await seedPhones(s, [kept!], start);
    const tokens = [await s.issue(), await other.issue()];
    const results = await Promise.all([
      s.add({ phone: a, expected_version: start }, { token: tokens[0]! }),
      other.add({ phone: b, expected_version: start }, { token: tokens[1]! }),
    ]);
    expect(results.map((r) => r.json().code).sort((x, y) => x - y)).toEqual([0, 20902]);
    const winner = results.findIndex((r) => r.json().code === 0);
    const data = await accepted(results[winner]!, 'add');
    await rejected(results[1 - winner]!, 'add', 20902, CONFLICT);
    const added = winner === 0 ? a! : b!;
    const expected = start > 0 ? [kept!, added] : [added];
    expect(data.version).toBe(start + 1);
    expect(maskedOf(data)).toEqual(expected.map(masked).sort());
    expect((await stored(s))!.sort()).toEqual([...expected].sort());
    expect((await configRow(s))!.version).toBe(start + 1);
    expect((await history(s)).map((row) => row.version)).toEqual([start + 1]);
    expect((await audits(s)).map((row) => row.action)).toEqual([ACTIONS.add]);
  });
}

it('[B1-22g][D10-152] 同一版本并发删除与新增只能一笔成功', async () => {
  const s = await setup(h);
  const other = await signIn(h, s.f, s.appId);
  const [kept, fresh] = mobiles(2);
  await seedPhones(s, [kept!], 6);
  const tokens = [await s.issue(), await other.issue()];
  const results = await Promise.all([
    s.remove(
      { phone_id: alertPhoneId(s.h.fields, kept!), expected_version: 6 },
      { token: tokens[0]! },
    ),
    other.add({ phone: fresh, expected_version: 6 }, { token: tokens[1]! }),
  ]);
  expect(results.map((r) => r.json().code).sort((x, y) => x - y)).toEqual([0, 20902]);
  expect((await configRow(s))!.version).toBe(7);
  const removed = results[0]!.json().code === 0;
  expect((await stored(s))!.sort()).toEqual(removed ? [] : [kept!, fresh!].sort());
  expect((await audits(s)).map((row) => row.action)).toEqual([
    removed ? ACTIONS.remove : ACTIONS.add,
  ]);
});
