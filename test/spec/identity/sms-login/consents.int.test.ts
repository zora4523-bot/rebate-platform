import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  openKit,
  closeKit,
  fixture,
  rows,
  consent,
  otherDevice,
  success,
  assertLogin,
  type Kit,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

it.each([
  { deviceVersion: 12, copy: true },
  { deviceVersion: 1, copy: false },
])(
  '[AC-B1-02j#40][BR-ID-01/12] 受限已有账号也按条件 login_merge，设备 privacy 版本=$deviceVersion，复制=$copy',
  async ({ deviceVersion, copy }) => {
    const f = await fixture(kit);
    const uid = await f.account();
    f.minimum.mockResolvedValue('3.0.0');
    await consent(kit, f, {
      user: uid,
      type: 'privacy',
      version: f.command.body.legal_versions.privacy,
      at: -3000,
    });
    const deviceRecord = await consent(kit, f, {
      type: 'privacy',
      version: deviceVersion,
      at: -1000,
      accepted: false,
    });
    const before = (await rows(kit, f.appId)).consents;
    const data = await assertLogin(kit, f, await f.login(), false, 'deletion_only');
    expect(data.user_id).toBe(uid);
    const all = (await rows(kit, f.appId)).consents;
    expect(all.filter((row) => before.some((old) => old.id === row.id))).toEqual(before);
    const merged = all.filter((row) => row.channel === 'login_merge');
    expect(merged).toHaveLength(copy ? 1 : 0);
    if (copy)
      expect(merged[0]).toMatchObject({
        subject_type: 'user',
        user_id: uid,
        type: 'privacy',
        version: deviceVersion,
        accepted: false,
        client_at: deviceRecord.client_at,
        server_at: f.clock.now(),
      });
  },
);

it.each([
  {
    label: '用户无记录',
    userVersion: null,
    userAt: -1000,
    deviceVersion: 1,
    deviceAt: -3000,
    copy: true,
  },
  {
    label: '设备版本更高但更早',
    userVersion: 2,
    userAt: -1000,
    deviceVersion: 3,
    deviceAt: -3000,
    copy: true,
  },
  {
    label: '同版本设备更晚',
    userVersion: 3,
    userAt: -3000,
    deviceVersion: 3,
    deviceAt: -1000,
    copy: true,
  },
  {
    label: '设备版本更低但更晚',
    userVersion: 3,
    userAt: -3000,
    deviceVersion: 2,
    deviceAt: -1000,
    copy: false,
  },
  {
    label: '同版本设备更早',
    userVersion: 3,
    userAt: -1000,
    deviceVersion: 3,
    deviceAt: -3000,
    copy: false,
  },
  {
    label: '版本与时间相等',
    userVersion: 3,
    userAt: -1000,
    deviceVersion: 3,
    deviceAt: -1000,
    copy: false,
  },
])(
  '[AC-B1-02j#11][BR-ID-12] login_merge $label，copy=$copy，保留 accepted 与 client_at',
  async (entry) => {
    const f = await fixture(kit);
    const uid = await f.account();
    if (entry.userVersion !== null)
      await consent(kit, f, {
        user: uid,
        type: 'personalization',
        version: entry.userVersion,
        at: entry.userAt,
      });
    const deviceRecord = await consent(kit, f, {
      type: 'personalization',
      version: entry.deviceVersion,
      at: entry.deviceAt,
      accepted: false,
    });
    const before = (await rows(kit, f.appId)).consents;
    success(await f.login());
    const all = (await rows(kit, f.appId)).consents;
    expect(all.filter((row) => before.some((old) => old.id === row.id))).toEqual(before);
    const merged = all.filter((row) => row.channel === 'login_merge');
    expect(merged).toHaveLength(entry.copy ? 1 : 0);
    if (entry.copy)
      expect(merged[0]).toMatchObject({
        subject_type: 'user',
        user_id: uid,
        type: 'personalization',
        version: entry.deviceVersion,
        accepted: false,
        client_at: deviceRecord.client_at,
        server_at: f.clock.now(),
      });
  },
);

it('[AC-B1-02j#12][BR-ID-12] 当前状态按 server_at 取，不取最大 version 或最大 id，也不复制整段历史', async () => {
  const f = await fixture(kit);
  const uid = await f.account();
  await consent(kit, f, { type: 'id_verification', version: 2, at: -1000, accepted: false });
  await consent(kit, f, { type: 'id_verification', version: 20, at: -5000 });
  await consent(kit, f, { user: uid, type: 'id_verification', version: 1, at: -2000 });
  await consent(kit, f, { user: uid, type: 'id_verification', version: 30, at: -6000 });
  success(await f.login());
  expect(
    (await rows(kit, f.appId)).consents.filter((row) => row.channel === 'login_merge'),
  ).toEqual([
    expect.objectContaining({ user_id: uid, type: 'id_verification', version: 2, accepted: false }),
  ]);
});

it('[AC-B1-02j#13][BR-ID-12] 只从本次安装复制；ai_third_party、labor_agreement 不合并', async () => {
  const f = await fixture(kit);
  const uid = await f.account();
  const another = await otherDevice(kit, f);
  await consent(kit, f, { device: another, type: 'personalization', version: 20, at: -1000 });
  await consent(kit, f, { type: 'ai_third_party', version: 9, at: -1000 });
  // Schema forbids device-level labor_agreement: seed the legal user-only form.
  const labor = await consent(kit, f, {
    user: uid,
    device: f.deviceId,
    type: 'labor_agreement',
    version: 4,
    at: -1000,
  });
  success(await f.login());
  const all = (await rows(kit, f.appId)).consents;
  expect(all.filter((row) => row.channel === 'login_merge')).toEqual([]);
  expect(all.filter((row) => row.type === 'labor_agreement')).toEqual([labor]);
  expect(all.filter((row) => row.type === 'ai_third_party' && row.subject_type === 'user')).toEqual(
    [],
  );
});

it('[AC-B1-02j#14][BR-ID-04/12] 新号也合并设备当前状态；登录页版本和点击时间仍取请求', async () => {
  const f = await fixture(kit);
  for (const type of ['privacy', 'agreement', 'personalization']) {
    await consent(kit, f, { type, version: 12, at: -1000, accepted: false });
  }
  const data = success(await f.login());
  expect(data.is_new_user).toBe(true);
  const all = (await rows(kit, f.appId)).consents;
  const pages = all.filter((row) => row.channel === 'login_page');
  expect(pages).toHaveLength(2);
  for (const type of ['privacy', 'agreement'] as const)
    expect(pages.find((row) => row.type === type)).toMatchObject({
      user_id: data.user_id,
      version: f.command.body.legal_versions[type],
      accepted: true,
      client_at: new Date(f.command.body.consent_at),
      server_at: f.clock.now(),
    });
  const merged = all.filter((row) => row.channel === 'login_merge');
  expect(merged.map((row) => row.type).sort()).toEqual(['agreement', 'personalization', 'privacy']);
  expect(
    merged.every((row) => row.user_id === data.user_id && row.version === 12 && !row.accepted),
  ).toBe(true);
});
