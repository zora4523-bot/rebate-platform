// B3-03i 第 9 节 4：③ AI 同意适配（BR-AI-13：登录用户按 user_id 查、游客按 device_id 查；找不到、最新一条
// accepted=false、版本不是当前版本都返回 10004）。判定口径属 B1-02r（不在此测），这里只测适配：传给同意读取的
// 主体、三种拒绝 → {code: 10004}、允许 → null、读取或版本源失败 → 端口拒绝。
import { expect, it } from 'vitest';

import { createAgentConsentPort } from '../../../../apps/api/src/modules/agent/stream/access/index.ts';
import { APP, FakeConsent, FakeVersion, OTHER_APP, guest, member } from './kit.ts';

function setup(): { version: FakeVersion; consent: FakeConsent } {
  const version = new FakeVersion();
  return { version, consent: new FakeConsent(version.source) };
}

it('[AC-B3-03i#15][BR-AI-13] 主体：登录用户（绑没绑手机都一样）传 {appId, userId, deviceId}；游客传 userId=null 与本机 deviceId；不传别的字段', async () => {
  const { version, consent } = setup();
  const port = createAgentConsentPort({ consent, version: version.source });
  const bound = member({ phoneBound: true });
  const unbound = member({ phoneBound: false, appId: OTHER_APP });
  const visitor = guest();
  for (const c of [bound, unbound, visitor]) expect(await port.check(c)).toBeNull();
  expect(consent.calls).toEqual([
    { appId: APP, userId: bound.userId, deviceId: bound.deviceId },
    { appId: OTHER_APP, userId: unbound.userId, deviceId: unbound.deviceId },
    { appId: APP, userId: null, deviceId: visitor.deviceId },
  ]);
});

it.each([
  { reason: 'missing' as const },
  { reason: 'withdrawn' as const },
  { reason: 'outdated' as const },
])(
  '[AC-B3-03i#16][BR-AI-13] 同意读取答 $reason → {code: 10004}；同一设备上的其他主体不受影响（允许 → null）',
  async (c) => {
    const { version, consent } = setup();
    const port = createAgentConsentPort({ consent, version: version.source });
    const user = member({ phoneBound: true });
    const sameDeviceGuest = { ...guest(), deviceId: user.deviceId };
    consent.refuseUser(APP, user.userId!, c.reason);
    expect(await port.check(user), 'refused user').toEqual({ code: 10004 });
    expect(await port.check(sameDeviceGuest), 'device subject of the same device').toBeNull();
    const device = guest();
    consent.refuseDevice(APP, device.deviceId, c.reason);
    expect(await port.check(device), 'refused guest').toEqual({ code: 10004 });
  },
);

it('[AC-B3-03i#17][BR-AI-13] 同意记录读取失败或版本源失败 → 端口拒绝（reject），不放行、不当作 10004', async () => {
  for (const failing of ['records', 'version'] as const) {
    const { version, consent } = setup();
    if (failing === 'records') consent.fail = true;
    else version.fail = true;
    const port = createAgentConsentPort({ consent, version: version.source });
    for (const who of [member({ phoneBound: true }), guest()]) {
      let rejected = false;
      let answer: unknown = 'not settled';
      try {
        answer = await port.check(who);
      } catch (error) {
        rejected = true;
        expect(String(error)).not.toMatch(/NotImplemented/);
      }
      expect({ failing, rejected, answer }).toEqual({
        failing,
        rejected: true,
        answer: 'not settled',
      });
    }
  }
});
