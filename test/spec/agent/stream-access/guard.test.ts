// B3-03i 第 9 节 5：按 run 的守卫工厂（RunManagerDeps.guardFor，规划 B3-05-plan §1.3 G-1）。ownerKey
// u:<user_id> → 用户主体、d:<device_id> → 设备主体（BR-AI-20），其他格式拒绝；check 先开放（BR-AI-12，
// agent.enabled 与名单 → 30501）后同意（BR-AI-13 → 10004），与 BR-AI-23 ①③ 同序（非名单用户未同意 →
// 30501，BR-AI-13 细则例）；都通过 → null；读取失败 → 拒绝（RunManager 下一轮再查）。
import { expect, it } from 'vitest';

import { createRunGuardFactory } from '../../../../apps/api/src/modules/agent/stream/access/index.ts';
import {
  APP,
  FakeConsent,
  FakeVersion,
  OTHER_APP,
  messageOf,
  newId,
  openConfig,
  outcome,
  type FakeConfig,
} from './kit.ts';

function setup(config: FakeConfig = openConfig()) {
  const version = new FakeVersion();
  const consent = new FakeConsent(version.source);
  const guardFor = createRunGuardFactory({ reader: config, consent, version: version.source });
  return { config, version, consent, guardFor };
}

it('[AC-B3-03i#18][BR-AI-13][BR-AI-20] ownerKey u:<id> → 用户主体（appId 取 run.appId，userId 为该 id）；d:<id> → 设备主体（userId=null）；都通过 → null', async () => {
  const s = setup(openConfig(OTHER_APP));
  const userId = newId();
  const deviceId = newId();
  const user = s.guardFor({ appId: OTHER_APP, ownerKey: `u:${userId}`, runId: newId() });
  const device = s.guardFor({ appId: OTHER_APP, ownerKey: `d:${deviceId}`, runId: newId() });
  expect(await user.check()).toBeNull();
  expect(await device.check()).toBeNull();
  expect(s.consent.calls).toHaveLength(2);
  expect(s.consent.calls[0]).toMatchObject({ appId: OTHER_APP, userId });
  expect(s.consent.calls[1]).toEqual({ appId: OTHER_APP, userId: null, deviceId });
});

it.each([
  { ownerKey: 'x:019a0000-0000-7000-8000-00000000abcd' },
  { ownerKey: 'u:' },
  { ownerKey: 'd:' },
  { ownerKey: '019a0000-0000-7000-8000-00000000abcd' },
  { ownerKey: '' },
  { ownerKey: 'U:019a0000-0000-7000-8000-00000000abcd' },
])(
  '[AC-B3-03i#19][BR-AI-20] ownerKey 不是 u:<id> / d:<id>（"$ownerKey"）→ 构造抛错或 check 拒绝，不去查同意',
  async (c) => {
    const s = setup();
    const result = await outcome(async () => {
      const guard = s.guardFor({ appId: APP, ownerKey: c.ownerKey, runId: newId() });
      return guard.check();
    });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (!result.ok) expect(messageOf(result.error)).not.toMatch(/^NotImplemented:/);
    expect(s.consent.calls).toEqual([]);
  },
);

it('[AC-B3-03i#20][BR-AI-12][BR-AI-13][BR-AI-23] 先开放后同意：开关关 + 已撤回 → 30501；开关开 + 已撤回 → 10004；名单期间不在名单的用户与设备主体 → 30501；名单内 → 看同意', async () => {
  const userId = newId();
  const deviceId = newId();
  const s = setup();
  s.consent.refuseUser(APP, userId, 'withdrawn');
  s.consent.refuseDevice(APP, deviceId, 'withdrawn');
  const user = s.guardFor({ appId: APP, ownerKey: `u:${userId}`, runId: newId() });
  const device = s.guardFor({ appId: APP, ownerKey: `d:${deviceId}`, runId: newId() });
  expect(await user.check(), 'on, withdrawn').toEqual({ code: 10004 });
  expect(await device.check(), 'on, withdrawn (device)').toEqual({ code: 10004 });

  s.config.set(APP, 'agent.enabled', false);
  expect(await user.check(), 'off, withdrawn').toEqual({ code: 30501 });
  expect(await device.check(), 'off, withdrawn (device)').toEqual({ code: 30501 });

  s.config.set(APP, 'agent.enabled', true).set(APP, 'agent.whitelist_only', true);
  const listed = newId();
  s.config.set(APP, 'agent.whitelist_user_ids', [listed]);
  expect(await user.check(), 'whitelist, not listed').toEqual({ code: 30501 });
  expect(await device.check(), 'whitelist, device subject').toEqual({ code: 30501 });
  const listedGuard = s.guardFor({ appId: APP, ownerKey: `u:${listed}`, runId: newId() });
  expect(await listedGuard.check(), 'whitelist, listed, consent allowed').toBeNull();
  s.consent.refuseUser(APP, listed, 'outdated');
  expect(await listedGuard.check(), 'whitelist, listed, consent outdated').toEqual({
    code: 10004,
  });
});

it('[AC-B3-03i#21][BR-AI-12][BR-AI-13] 读取失败（配置、同意记录、版本源任一）→ check 拒绝，不放行、不臆造 30501 / 10004', async () => {
  for (const failing of ['config', 'records', 'version'] as const) {
    const s = setup();
    const guard = s.guardFor({ appId: APP, ownerKey: `u:${newId()}`, runId: newId() });
    if (failing === 'config') s.config.fail = true;
    if (failing === 'records') s.consent.fail = true;
    if (failing === 'version') s.version.fail = true;
    const result = await outcome(() => guard.check());
    expect({ failing, ok: result.ok }).toEqual({ failing, ok: false });
    if (!result.ok) expect(messageOf(result.error)).not.toMatch(/^NotImplemented:/);
  }
});

it('[AC-B3-03i#22][BR-AI-13] 每个守卫只查自己 run 的主体：A 撤回后 A 的守卫 10004，同一工厂给 B 的守卫仍 null；同一主体的两个 run 都 10004', async () => {
  const s = setup();
  const a = newId();
  const b = newId();
  const guardA1 = s.guardFor({ appId: APP, ownerKey: `u:${a}`, runId: newId() });
  const guardA2 = s.guardFor({ appId: APP, ownerKey: `u:${a}`, runId: newId() });
  const guardB = s.guardFor({ appId: APP, ownerKey: `u:${b}`, runId: newId() });
  expect([await guardA1.check(), await guardA2.check(), await guardB.check()]).toEqual([
    null,
    null,
    null,
  ]);
  s.consent.refuseUser(APP, a, 'withdrawn');
  expect([await guardA1.check(), await guardA2.check(), await guardB.check()]).toEqual([
    { code: 10004 },
    { code: 10004 },
    null,
  ]);
});

it('[AC-B3-03i#34][BR-AI-12][BR-AI-13] 同一工厂实例交替为两个应用造守卫：各自读自己 app 的配置与同意（A 关、B 开；随后 A 开、B 关），不绑定第一次调用的 appId', async () => {
  const s = setup(
    openConfig(APP)
      .set(OTHER_APP, 'agent.enabled', true)
      .set(OTHER_APP, 'agent.whitelist_only', false),
  );
  s.config.set(APP, 'agent.enabled', false);
  const ownerKey = `u:${newId()}`;
  const a1 = s.guardFor({ appId: APP, ownerKey, runId: newId() });
  const b1 = s.guardFor({ appId: OTHER_APP, ownerKey, runId: newId() });
  const a2 = s.guardFor({ appId: APP, ownerKey: `d:${newId()}`, runId: newId() });
  const b2 = s.guardFor({ appId: OTHER_APP, ownerKey: `d:${newId()}`, runId: newId() });
  for (const [name, guard, app, expected] of [
    ['a1', a1, APP, { code: 30501 }],
    ['b1', b1, OTHER_APP, null],
    ['a2', a2, APP, { code: 30501 }],
    ['b2', b2, OTHER_APP, null],
  ] as const) {
    const asked = s.config.asked.length;
    const consulted = s.consent.calls.length;
    expect(await guard.check(), name).toEqual(expected);
    const reads = s.config.asked.slice(asked);
    expect(reads.length, `${name} reads its configuration`).toBeGreaterThan(0);
    for (const read of reads) expect(read.startsWith(`${app}:`), `${name}: ${read}`).toBe(true);
    for (const subject of s.consent.calls.slice(consulted)) {
      expect(subject.appId, `${name} consent app`).toBe(app);
    }
  }
  s.config.set(APP, 'agent.enabled', true).set(OTHER_APP, 'agent.enabled', false);
  expect([await a1.check(), await b1.check(), await a2.check(), await b2.check()]).toEqual([
    null,
    { code: 30501 },
    null,
    { code: 30501 },
  ]);
});
