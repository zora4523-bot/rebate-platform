// B1-02zx §9 #2 · the user, the device and the account (contract adminAddUserReverifiedDevice): each
// is refused alone here, the order between them is order.int.test.ts, the audit of these refusals
// audit.int.test.ts. Every target but the one under test is in order: the account carries the flag
// and the device is a live one of this user.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  account,
  body,
  deleted,
  deviceOf,
  flag,
  ok,
  record,
  recorded,
  records,
  rejected,
  revoke,
  setup,
  snapshot,
  unflag,
  unowned,
  user,
  type Device,
  type Setup,
  type Target,
} from './kit.ts';

const h = useHarness();

const UNKNOWN_USER = { fields: ['user_id'] };
const UNKNOWN_DEVICE = { fields: ['device_id'] };
const NOT_PENDING = { reason: 'reverify_not_pending' };
const ACCOUNT_DELETED = { reason: 'account_deleted' };

it('[AC-B1-02zx#12] 未知 user_id、别的 app 的用户（带不带 X-App-Id）、非 UUID 都是 20001 [user_id]，什么都不写', async () => {
  const s = await setup(h);
  // A real local account stays present: a write that forgets the user_id filter must show.
  const local = await account(s);
  const otherApp = `foreign-${randomUUID()}`;
  const foreign = await account(s, otherApp);
  const before = await snapshot(h, s.appId);
  const foreignBefore = await snapshot(h, otherApp);
  const cases: [string, Device, Record<string, string>][] = [
    [randomUUID(), local.device, {}],
    [foreign.target.id, foreign.device, {}],
    [foreign.target.id, foreign.device, { 'x-app-id': otherApp }],
    ['not-a-uuid', local.device, {}],
  ];
  for (const [id, device, headers] of cases) {
    const response = await record(s, id, body(device), { headers });
    await rejected(response, 20001, UNKNOWN_USER);
  }
  expect(await snapshot(h, s.appId)).toEqual(before);
  expect(await snapshot(h, otherApp)).toEqual(foreignBefore);
});

const FOREIGN_DEVICES: readonly {
  case: string;
  device: (s: Setup, target: Target) => Promise<Pick<Device, 'id'>>;
}[] = [
  { case: '未知', device: async () => ({ id: randomUUID() }) },
  {
    case: '别的 app 的',
    device: async (s) => deviceOf(s, await user(h, `foreign-${randomUUID()}`)),
  },
  {
    case: '已吊销的本人设备',
    device: async (s, target) => {
      const device = await deviceOf(s, target);
      await revoke(s, device);
      return device;
    },
  },
  { case: '同 app 别的用户的', device: async (s) => deviceOf(s, await user(h, s.appId)) },
  { case: '没有归属的', device: (s) => unowned(s) },
];

it.each(FOREIGN_DEVICES)(
  '[AC-B1-02zx#13] device_id 是$case设备 → 20001 [device_id]，不写 reverified_devices',
  async ({ device }) => {
    const s = await setup(h);
    const { target } = await account(s);
    const stray = await device(s, target);
    const before = await snapshot(h, s.appId);
    await rejected(await record(s, target.id, body(stray)), 20001, UNKNOWN_DEVICE);
    expect(await snapshot(h, s.appId)).toEqual(before);
  },
);

it('[AC-B1-02zx#14] device_id 合乎 Id 形状但不是 UUID → 20001 [device_id]，不是 5XX', async () => {
  const s = await setup(h);
  const { target } = await account(s);
  const response = await record(s, target.id, body({ id: 'not-a-uuid' }));
  await rejected(response, 20001, UNKNOWN_DEVICE);
  expect(await records(h, target)).toEqual([]);
});

it('[AC-B1-02zx#15] 账号没有待加验标记 → 30419 reverify_not_pending，不写 reverified_devices', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const device = await deviceOf(s, target);
  const before = await snapshot(h, s.appId);
  await rejected(await record(s, target.id, body(device)), 30419, NOT_PENDING);
  expect(await snapshot(h, s.appId)).toEqual(before);

  // The same request once the account carries the flag: only the flag decided.
  await flag(s, target);
  expect((await ok(await record(s, target.id, body(device)))).created).toBe(true);
});

it('[AC-B1-02zx#16] 无标记先于已记录：设备早已登记、标记后来清除 → 30419 reverify_not_pending，不是 created:false', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  await recorded(s, target, device, 'self', s.clock.now());
  await unflag(s, target);
  const before = await snapshot(h, s.appId);
  await rejected(await record(s, target.id, body(device)), 30419, NOT_PENDING);
  expect(await snapshot(h, s.appId)).toEqual(before);
});

it('[AC-B1-02zx#17] 账号已完成注销 → 30419 account_deleted，不带 data.stage，不写 reverified_devices', async () => {
  const s = await setup(h);
  const target = await deleted(s);
  const device = await deviceOf(s, target);
  await flag(s, target);
  const before = await snapshot(h, s.appId);
  await rejected(await record(s, target.id, body(device)), 30419, ACCOUNT_DELETED);
  expect(await snapshot(h, s.appId)).toEqual(before);
});
