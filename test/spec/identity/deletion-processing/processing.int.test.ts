// B1-15g: one request through the three steps (brief §9.2 #3, #5; §9.3 items 1, 2, 4, 5, 12, 14):
// ① cleanup — sessions (account_deleted), nickname / avatar, real name (D10-137 ②), payout
// accounts (D10-186 ①: anonymized, never deleted), login_logs detached, the ports; ② Apple (no
// binding → not_applicable); ③ completion — deleted_identities, user_oauth, users tombstone,
// COMPLETE → done. Over PostgreSQL as couli_app; Clock, ports and logger injected.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  DAY_MS,
  DEFAULT_AVATAR,
  HOUR_MS,
  PAYEE_NAME,
  RETENTION_MS,
  TOMBSTONE_NICKNAME,
  at,
  close,
  deletedIdentitiesOf,
  device,
  devicesOf,
  growthDetach,
  loginLog,
  loginLogsOf,
  member,
  oauth,
  oauthOf,
  open,
  payoutAccount,
  payoutAccountsOf,
  processing,
  realname,
  realnameOf,
  relationLogsOf,
  request,
  reset,
  session,
  sessionsOf,
  userRow,
  type Kit,
} from './kit.ts';

let database: TestDatabase;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  kit = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    await database?.drop();
  }
});
beforeEach(async () => {
  await reset(kit);
});

it('[AC-B1-15g#1] 一轮走完三步：cleaned_at=now，无 Apple 授权 → not_applicable，调账无需 → done（processed_at=now）', async () => {
  const { m, row } = await processing(kit.db);
  const runner = kit.runner();
  expect(await runner.runOnce()).toEqual({ scanned: 1 });
  const now = kit.clock.now();
  expect(await request(kit.db, row.id)).toEqual({
    ...row,
    status: 'done',
    processed_at: now,
    cleaned_at: now,
    apple_revoke_attempts: 0,
    apple_revoke_result: 'not_applicable',
    row_version: row.row_version + 1,
    updated_at: now,
  });
  expect(kit.appleCalls).toEqual([]);
  expect(kit.callsOf('funds', m)).toHaveLength(1);
});

it('[AC-B1-15g#2] 完成后 users 是墓碑：status=deleted、deleted_reason=account_deleted、手机号密文与 HMAC 置空、昵称「已注销用户」、默认头像、改名计数清零', async () => {
  const { m } = await processing(kit.db);
  const before = await userRow(kit.db, m);
  expect(before.phone_hmac).toBe(m.phoneHmac);
  await kit.runner().runOnce();
  const now = kit.clock.now();
  const after = await userRow(kit.db, m);
  expect(after).toEqual({
    ...before,
    status: 'deleted',
    deleted_reason: 'account_deleted',
    phone_cipher: null,
    phone_hmac: null,
    nickname: TOMBSTONE_NICKNAME,
    avatar: DEFAULT_AVATAR,
    nickname_change_month: null,
    nickname_change_count: 0,
    invite_code: expect.any(String),
    attr_code: expect.any(String),
    row_version: expect.any(Number),
    updated_at: now,
  });
  expect(after.row_version).toBeGreaterThan(before.row_version);
});

it('[AC-B1-15g#3] 会话：本用户全部未吊销 sid → revoked_at=now、account_deleted，已吊销的保持原样；同机他人会话与 devices 行不变；推送解绑钩子在同一事务拿到这些 sid', async () => {
  const { m } = await processing(kit.db);
  const other = await member(kit.db, { appId: m.appId, status: 'normal' });
  const shared = await device(kit.db, m.appId);
  const own = await device(kit.db, m.appId);
  const live = [await session(kit.db, m, shared.id), await session(kit.db, m, own.id)];
  await session(kit.db, m, own.id, { revoked: true });
  await session(kit.db, other, shared.id);
  const sessionsBefore = await sessionsOf(kit.db, m.appId);
  const devicesBefore = await devicesOf(kit.db, m.appId);
  await kit.runner().runOnce();
  const now = kit.clock.now();
  expect(await sessionsOf(kit.db, m.appId)).toEqual(
    sessionsBefore.map((row) =>
      live.includes(row.sid)
        ? { ...row, revoked_at: now, revoke_reason: 'account_deleted', updated_at: now }
        : row,
    ),
  );
  expect(await devicesOf(kit.db, m.appId)).toEqual(devicesBefore);
  expect(kit.revokedHooks).toEqual([
    { inTransaction: true, sids: [...live].sort(), appId: m.appId },
  ]);
});

it('[AC-B1-15g#4] 登录日志：本用户的行 user_id 置空、其余列不变，他人的行不动', async () => {
  const { m } = await processing(kit.db);
  const other = await member(kit.db, { appId: m.appId, status: 'normal' });
  const d = await device(kit.db, m.appId);
  await loginLog(kit.db, m, d.hash);
  await loginLog(kit.db, m, d.hash);
  await loginLog(kit.db, other, d.hash);
  const before = await loginLogsOf(kit.db, m.appId);
  await kit.runner().runOnce();
  const after = await loginLogsOf(kit.db, m.appId);
  expect(after).toEqual(
    before.map((row) => (row.user_id === m.uid ? { ...row, user_id: null } : row)),
  );
  expect(after.filter((row) => row.user_id === null)).toHaveLength(2);
});

it('[AC-B1-15g#5] deleted_identities：手机号一行 + 本用户会话所在每台设备的哈希一行（去重），reason=account_deleted、expire_at=deleted_at+180 天；他人设备不进；再跑不重复插', async () => {
  const { m } = await processing(kit.db);
  const other = await member(kit.db, { appId: m.appId, status: 'normal' });
  const d1 = await device(kit.db, m.appId);
  const d2 = await device(kit.db, m.appId);
  const d3 = await device(kit.db, m.appId);
  await session(kit.db, m, d1.id);
  await session(kit.db, m, d1.id, { revoked: true });
  await session(kit.db, m, d2.id, { revoked: true });
  await session(kit.db, other, d3.id);
  const runner = kit.runner();
  await runner.runOnce();
  const now = kit.clock.now();
  const expire = new Date(now.getTime() + RETENTION_MS);
  const base = { app_id: m.appId, reason: 'account_deleted', deleted_at: now, expire_at: expire };
  const expected = [
    { ...base, phone_hmac: m.phoneHmac, device_hash: null },
    { ...base, phone_hmac: null, device_hash: d1.hash },
    { ...base, phone_hmac: null, device_hash: d2.hash },
  ].sort((a, b) =>
    `${a.phone_hmac ?? ''}/${a.device_hash ?? ''}`.localeCompare(
      `${b.phone_hmac ?? ''}/${b.device_hash ?? ''}`,
    ),
  );
  expect(await deletedIdentitiesOf(kit.db, m.appId)).toEqual(expected);
  kit.clock.set(at(HOUR_MS));
  await runner.runOnce();
  await kit.runner().runOnce();
  expect(await deletedIdentitiesOf(kit.db, m.appId)).toEqual(expected);
});

it('[AC-B1-15g#6] deleted_identities：没有手机号的用户只记设备哈希；既无手机号也无会话 → 不写', async () => {
  const noPhone = await processing(kit.db, { phone: false });
  const d = await device(kit.db, noPhone.m.appId);
  await session(kit.db, noPhone.m, d.id);
  const nothing = await processing(kit.db, { phone: false });
  await kit.runner().runOnce();
  const now = kit.clock.now();
  expect(await deletedIdentitiesOf(kit.db, noPhone.m.appId)).toEqual([
    {
      app_id: noPhone.m.appId,
      reason: 'account_deleted',
      phone_hmac: null,
      device_hash: d.hash,
      deleted_at: now,
      expire_at: new Date(now.getTime() + RETENTION_MS),
    },
  ]);
  expect(await deletedIdentitiesOf(kit.db, nothing.m.appId)).toEqual([]);
  for (const r of [noPhone.row, nothing.row]) {
    expect((await request(kit.db, r.id)).status).toBe('done');
  }
});

it('[AC-B1-15g#7] 实名：无成功提现（端口答 false）→ status=none、四个密文与 provider / verified_at 清空、tax_retained=false、row_version+1；端口在清理事务内、users 行已锁时被问', async () => {
  const { m } = await processing(kit.db);
  const before = await realname(kit.db, m);
  kit.setSucceeded(m, false);
  await kit.runner().runOnce();
  const now = kit.clock.now();
  expect(await realnameOf(kit.db, m)).toEqual({
    ...before,
    status: 'none',
    name_cipher: null,
    id_no_cipher: null,
    id_no_hmac: null,
    birth_date_cipher: null,
    provider: null,
    verified_at: null,
    tax_retained: false,
    row_version: before.row_version + 1,
    updated_at: now,
  });
  expect(kit.callsOf('succeeded', m)).toEqual([
    {
      port: 'succeeded',
      input: { appId: m.appId, userId: m.uid },
      inTransaction: true,
      userRowLocked: true,
    },
  ]);
});

it('[AC-B1-15g#8] 实名：有过成功提现（端口答 true）→ 保留四个密文、标 tax_retained、status=none（不再占已实名唯一索引），row_version+1', async () => {
  const { m } = await processing(kit.db);
  const before = await realname(kit.db, m);
  kit.setSucceeded(m, true);
  await kit.runner().runOnce();
  expect(await realnameOf(kit.db, m)).toMatchObject({
    id: before.id,
    status: 'none',
    tax_retained: true,
    name_cipher: before.name_cipher,
    id_no_cipher: before.id_no_cipher,
    id_no_hmac: before.id_no_hmac,
    birth_date_cipher: before.birth_date_cipher,
    row_version: before.row_version + 1,
  });
  expect(kit.callsOf('succeeded', m)).toHaveLength(1);
});

it('[AC-B1-15g#9] 收款账号匿名化不删行：账号密文 / HMAC / 卡 BIN 置空、is_current=false、anonymized_at=now、户名换成不含原名的占位；他人账号不动', async () => {
  const { m } = await processing(kit.db);
  const other = await member(kit.db, { appId: m.appId, status: 'normal' });
  const accounts = [
    await payoutAccount(kit.db, m, 'alipay', true),
    await payoutAccount(kit.db, m, 'bank_card', false),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const untouched = await payoutAccount(kit.db, other, 'alipay', true);
  await kit.runner().runOnce();
  const now = kit.clock.now();
  const after = await payoutAccountsOf(kit.db, m);
  expect(after.map((row) => row.id)).toEqual(accounts.map((row) => row.id));
  for (const [index, row] of after.entries()) {
    expect(row).toMatchObject({
      app_id: m.appId,
      user_id: m.uid,
      payout_method: accounts[index]!.payout_method,
      anonymized_at: now,
      is_current: false,
      alipay_logon_id_cipher: null,
      alipay_hmac: null,
      bank_card_no_cipher: null,
      bank_card_hmac: null,
      card_bin: null,
    });
    expect(row.payee_name).not.toContain(PAYEE_NAME);
  }
  expect(await payoutAccountsOf(kit.db, other)).toEqual([untouched]);
});

it('[AC-B1-15g#10] user_oauth 在完成事务里全部删除（微信与 Apple），他人绑定不动', async () => {
  const { m } = await processing(kit.db);
  const other = await member(kit.db, { appId: m.appId, status: 'normal' });
  await oauth(kit.db, m, 'wechat');
  await oauth(kit.db, m, 'apple');
  await oauth(kit.db, other, 'wechat');
  const others = (await oauthOf(kit.db, m.appId)).filter((row) => row.user_id === other.uid);
  await kit.runner().runOnce();
  expect(await oauthOf(kit.db, m.appId)).toEqual(others);
});

it('[AC-B1-15g#11] 直属下级经 growth 端口 parent_id 置空、各写一条 parent_deleted 关系日志；孙辈与本人行的其余关系不动', async () => {
  kit.useGrowth(await growthDetach());
  const { m } = await processing(kit.db);
  const c1 = await member(kit.db, { appId: m.appId, status: 'normal', parentId: m.uid });
  const c2 = await member(kit.db, { appId: m.appId, status: 'normal', parentId: m.uid });
  const grandchild = await member(kit.db, {
    appId: m.appId,
    status: 'normal',
    parentId: c1.uid,
  });
  const grandBefore = await userRow(kit.db, grandchild);
  await kit.runner().runOnce();
  const now = kit.clock.now();
  for (const child of [c1, c2]) {
    expect(await userRow(kit.db, child)).toMatchObject({
      parent_id: null,
      parent_bind_source: null,
      parent_bound_at: null,
    });
  }
  expect(await userRow(kit.db, grandchild)).toEqual(grandBefore);
  expect(await relationLogsOf(kit.db, m.appId)).toEqual(
    [c1, c2]
      .map((child) => ({
        app_id: m.appId,
        user_id: child.uid,
        from_parent_id: m.uid,
        to_parent_id: null,
        source: 'parent_deleted',
        operator: 'system',
        at: now,
      }))
      .sort((a, b) => a.user_id.localeCompare(b.user_id)),
  );
});

it('[AC-B1-15g#12] 进度列（cleaned_at、apple_*）写入不动 row_version / updated_at；调账未完成时停在 processing，手机号、user_oauth 留到完成事务，deleted_identities 未写', async () => {
  const { m, row } = await processing(kit.db);
  await oauth(kit.db, m, 'wechat');
  const oauthBefore = await oauthOf(kit.db, m.appId);
  const userBefore = await userRow(kit.db, m);
  kit.setAdjustment(m, 'pending');
  const runner = kit.runner();
  await runner.runOnce();
  const cleanedAt = kit.clock.now();
  expect(await request(kit.db, row.id)).toEqual({
    ...row,
    cleaned_at: cleanedAt,
    apple_revoke_result: 'not_applicable',
  });
  const user = await userRow(kit.db, m);
  expect(user).toMatchObject({
    status: 'deleting',
    phone_cipher: userBefore.phone_cipher,
    phone_hmac: userBefore.phone_hmac,
    nickname: TOMBSTONE_NICKNAME,
    avatar: DEFAULT_AVATAR,
  });
  expect(await oauthOf(kit.db, m.appId)).toEqual(oauthBefore);
  expect(await deletedIdentitiesOf(kit.db, m.appId)).toEqual([]);
  // The adjustment is approved: the next round completes; cleaned_at keeps the first round's time.
  kit.setAdjustment(m, 'done');
  kit.clock.set(at(DAY_MS));
  await runner.runOnce();
  const doneAt = kit.clock.now();
  expect(await request(kit.db, row.id)).toEqual({
    ...row,
    status: 'done',
    processed_at: doneAt,
    cleaned_at: cleanedAt,
    apple_revoke_result: 'not_applicable',
    row_version: row.row_version + 1,
    updated_at: doneAt,
  });
  expect(await oauthOf(kit.db, m.appId)).toEqual([]);
  expect((await userRow(kit.db, m)).phone_hmac).toBeNull();
});
