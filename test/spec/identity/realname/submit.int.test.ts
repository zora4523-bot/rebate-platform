import { randomUUID } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  BODY,
  CONTEXT,
  ID,
  NAME,
  NOW,
  PATH,
  ROOT,
  close,
  envelope,
  fixture,
  open,
  privateDataAbsent,
  reader,
  reset,
  residentId,
  seedVerified,
  type Kit,
} from './kit.ts';
import type * as Level from '../../../../apps/api/src/modules/identity/application/identity-level.ts';

let database: TestDatabase;
let server: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  server = await acquireTestRedis();
  kit = await open(database, server);
});
beforeEach(() => {
  if (kit) reset(kit);
});
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await server?.stop();
    } finally {
      await database?.drop();
    }
  }
});

it('[AC-B1-13d#1] 提交操作去掉 planned 并通过真实 AppModule 注册', async () => {
  expect(kit.document.paths[PATH]!['post']!['x-implementation']).not.toBe('planned');
  const f = await fixture(kit);
  envelope(kit, await f.submit(), 30406);
  expect(kit.vendor).toHaveBeenCalledTimes(1);
});

it('[AC-B1-13d#2] 未绑手机先于单独同意、格式、年龄且不计次', async () => {
  const f = await fixture(kit, { phone: false, consent: false });
  const response = await f.submit({ name: NAME, id_no: 'bad' });
  envelope(kit, response, 10005);
  expect(kit.vendor).not.toHaveBeenCalled();
  expect(await f.rows()).toEqual([]);
  await sql`UPDATE app.users SET phone_hmac = ${'a'.repeat(64)} WHERE id = ${f.uid}`.execute(
    kit.db,
  );
  await f.consent(true);
  for (let i = 0; i < 3; i++) envelope(kit, await f.submit(), 30406);
  envelope(kit, await f.submit(), 30410);
});

it.each(['missing', 'device', 'other-type', 'withdrawn', 'other-user'] as const)(
  '[AC-B1-13d#3] user 级当前实名同意缺失（%s）先于格式，不接受其他同意',
  async (mode) => {
    const f = await fixture(kit, { consent: false });
    if (mode === 'device') await f.consent(true, -1, 'device');
    if (mode === 'other-type') await f.consent(true, -1, 'user', 1, 'privacy');
    if (mode === 'withdrawn') {
      await f.consent(false, 0);
      // Insert the older accepted row later to distinguish server_at from insertion order.
      await f.consent(true, -1000);
    }
    if (mode === 'other-user') await fixture(kit, { appId: f.appId });
    const response = await f.submit({ name: NAME, id_no: 'bad' });
    expect(envelope(kit, response, 10004).data).toEqual({ consent_type: 'id_verification' });
    expect(kit.vendor).not.toHaveBeenCalled();
    expect(await f.rows()).toEqual([]);
    await f.consent(true, 1, 'user', 7);
    for (let i = 0; i < 3; i++) envelope(kit, await f.submit(), 30406);
    envelope(kit, await f.submit(), 30410);
    privateDataAbsent(kit, [response]);
  },
);

it.each(['', '110105491231002', '110105194912310020', '110105199902300023'])(
  '[AC-B1-13d#4] 身份证格式或校验位失败 %j：20001 fields，不计次不存敏感字段',
  async (id_no) => {
    const f = await fixture(kit);
    for (let i = 0; i < 4; i++) {
      const response = await f.submit({ name: NAME, id_no });
      expect(envelope(kit, response, 20001).data).toEqual({ fields: ['id_no'] });
    }
    expect(kit.vendor).not.toHaveBeenCalled();
    expect(await f.rows()).toEqual([]);
    for (let i = 0; i < 3; i++) envelope(kit, await f.submit(), 30406);
    envelope(kit, await f.submit(), 30410);
  },
);

it.each([
  ['2012-09-29', '2026-09-29T15:59:59.999Z', '2026-09-29T16:00:00.000Z'],
  ['2012-02-29', '2026-03-01T15:59:59.999Z', '2026-03-01T16:00:00.000Z'],
])(
  '[AC-B1-13d#5] 出生 %s 满 14 岁须生日次日 +08:00；闰日非闰年按 3 月 2 日',
  async (birth, before, boundary) => {
    kit.clock.set(before);
    const f = await fixture(kit);
    const body = { name: NAME, id_no: residentId(birth) };
    kit.clock.set(before);
    for (let i = 0; i < 4; i++) envelope(kit, await f.submit(body), 30407);
    expect(await f.rows()).toEqual([]);
    expect(kit.vendor).not.toHaveBeenCalled();
    kit.clock.set(boundary);
    kit.vendor.mockResolvedValue({ outcome: 'match', provider: 'test-two-elements' });
    envelope(kit, await f.submit(body), 0);
    expect(kit.vendor).toHaveBeenCalledTimes(1);
    expect((await f.rows())[0]?.['verified_at']).toEqual(new Date(boundary));
  },
);

it('[AC-B1-13d#6] 次数已满仍先校验格式、年龄，再拒绝占用证件且不暴露对方', async () => {
  const f = await fixture(kit);
  const owner = await fixture(kit, { appId: f.appId });
  await seedVerified(kit, owner);
  for (let i = 0; i < 3; i++) envelope(kit, await f.submit(), 30405);
  expect(envelope(kit, await f.submit({ ...BODY, id_no: 'bad' }), 20001).data).toEqual({
    fields: ['id_no'],
  });
  envelope(kit, await f.submit({ ...BODY, id_no: residentId('2020-01-01') }), 30407);
  const occupied = await f.submit();
  const free = await f.submit({ ...BODY, id_no: residentId('1980-01-01') });
  envelope(kit, occupied, 30410);
  envelope(kit, free, 30410);
  expect(occupied.json<{ data?: unknown }>().data).toEqual(free.json<{ data?: unknown }>().data);
  expect(kit.vendor).not.toHaveBeenCalled();
  expect(await f.rows()).toEqual([]);
  privateDataAbsent(kit, [occupied, free], [owner.uid]);
});

it('[AC-B1-13d#7] 不一致计次并持久化 failed；同一用户下一次可成功且 Me 实时接表', async () => {
  const f = await fixture(kit);
  expect(envelope(kit, await f.me(), 0, '/v1/me').data?.['realname_status']).toBe('none');
  const mismatch = await f.submit();
  envelope(kit, mismatch, 30406);
  const rows = await f.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: 'failed',
    name_cipher: null,
    id_no_cipher: null,
    id_no_hmac: null,
    birth_date_cipher: null,
  });
  expect(envelope(kit, await f.me(), 0, '/v1/me').data?.['realname_status']).toBe('failed');
  kit.vendor.mockResolvedValue({ outcome: 'match', provider: 'test-two-elements' });
  const success = await f.submit();
  envelope(kit, success, 0);
  expect(await f.rows()).toHaveLength(1);
  expect(envelope(kit, await f.me(), 0, '/v1/me').data).toMatchObject({
    realname_status: 'verified',
  });
  privateDataAbsent(kit, [mismatch, success]);
});

it('[AC-B1-13d#8] 成功二要素调用、规范化号码与加密落库、Clock 时间、响应不含原文', async () => {
  const f = await fixture(kit);
  kit.vendor.mockResolvedValue({ outcome: 'match', provider: 'test-two-elements' });
  const response = await f.submit({ name: NAME, id_no: ' 11010519491231002x ' });
  const data = envelope(kit, response, 0).data;
  expect(data).toEqual({ realname_status: 'verified', masked_name: expect.any(String) });
  expect(data?.['masked_name']).not.toBe(NAME);
  expect(String(data?.['masked_name'])).toContain('*');
  expect(kit.vendor).toHaveBeenCalledExactlyOnceWith({
    app_id: f.appId,
    user_id: f.uid,
    name: NAME,
    id_no: ID,
  });
  const rows = await f.rows();
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row).toMatchObject({
    status: 'verified',
    provider: 'test-two-elements',
    verified_at: new Date(NOW),
    id_no_hmac: kit.crypto.blindIndex(ID, CONTEXT.id_no_cipher),
  });
  expect(row['id_no_hmac']).toMatch(/^[0-9a-f]{64}$/);
  for (const [column, plain] of [
    ['name_cipher', NAME],
    ['id_no_cipher', ID],
    ['birth_date_cipher', '1949-12-31'],
  ] as const) {
    expect(Buffer.isBuffer(row[column])).toBe(true);
    const cipher = (row[column] as Buffer).toString('utf8');
    expect(cipher).not.toContain(plain);
    expect(kit.crypto.decrypt(cipher, CONTEXT[column])).toBe(plain);
  }
  expect(row).not.toHaveProperty('adult_at');
  privateDataAbsent(kit, [response]);
});

it.each(['timeout', 'unavailable', 'throw'] as const)(
  '[AC-B1-13d#9] 供应商 %s 回 50401/50301，预占回退，不写失败密文且不泄露异常内容',
  async (mode) => {
    const f = await fixture(kit);
    if (mode === 'throw') kit.vendor.mockRejectedValue(new Error(`vendor error ${NAME} ${ID}`));
    else kit.vendor.mockResolvedValue({ outcome: mode });
    const responses = [];
    for (let i = 0; i < 4; i++) {
      const response = await f.submit();
      envelope(kit, response, mode === 'timeout' ? 50401 : 50301);
      responses.push(response);
    }
    expect(await f.rows()).toEqual([]);
    kit.vendor.mockResolvedValue({ outcome: 'mismatch', provider: 'test-two-elements' });
    for (let i = 0; i < 3; i++) envelope(kit, await f.submit(), 30406);
    envelope(kit, await f.submit(), 30410);
    expect(kit.vendor).toHaveBeenCalledTimes(7);
    privateDataAbsent(kit, responses);
  },
);

it('[AC-B1-13d#10] 计次按用户独立，+08:00 自然日零点重置而非 UTC 或滚动 24 小时', async () => {
  const f = await fixture(kit);
  for (let i = 0; i < 3; i++) envelope(kit, await f.submit(), 30406);
  envelope(kit, await f.submit(), 30410);
  const other = await fixture(kit, { appId: f.appId });
  envelope(kit, await other.submit(), 30406);
  kit.clock.set('2026-09-29T16:00:00.000Z');
  for (let i = 0; i < 3; i++) envelope(kit, await f.submit(), 30406);
  envelope(kit, await f.submit(), 30410);
  expect(kit.vendor).toHaveBeenCalledTimes(7);
  expect(kit.attemptKeys).toContain(`${f.appId}:2026-09-29:${f.uid}`);
  expect(kit.attemptKeys).toContain(`${f.appId}:2026-09-30:${f.uid}`);
  expect(kit.attemptKeys).toContain(`${f.appId}:2026-09-29:${other.uid}`);
});

it('[AC-B1-13d#11] 六个并发请求只允许三次供应商调用，预占防止超额', async () => {
  const f = await fixture(kit);
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.submit()));
  expect(responses.map((r) => r.json<{ code: number }>().code).sort()).toEqual([
    30406, 30406, 30406, 30410, 30410, 30410,
  ]);
  expect(kit.vendor).toHaveBeenCalledTimes(3);
  for (const response of responses) envelope(kit, response, response.json<{ code: number }>().code);
  expect(await f.rows()).toHaveLength(1);
});

it('[AC-B1-13d#12] 不一致的幂等重放不重复调用或计次；新键第三次后封顶', async () => {
  const f = await fixture(kit);
  const key = randomUUID();
  const first = await f.submit(BODY, key);
  envelope(kit, first, 30406);
  const replay = await f.submit(BODY, key);
  envelope(kit, replay, 30406);
  expect(kit.vendor).toHaveBeenCalledTimes(1);
  expect(replay.json<{ data?: unknown }>().data).toEqual(first.json<{ data?: unknown }>().data);
  for (let i = 0; i < 2; i++) envelope(kit, await f.submit(), 30406);
  envelope(kit, await f.submit(), 30410);
  expect(kit.vendor).toHaveBeenCalledTimes(3);
});

it('[AC-B1-13d#13] verified 重提直接返回已存脱敏姓名，忽略新证件且不改行不计次', async () => {
  const f = await fixture(kit);
  await seedVerified(kit, f);
  const before = await f.rows();
  const responses = [];
  for (let i = 0; i < 4; i++) {
    const response = await f.submit({ name: '不应替换', id_no: 'bad' });
    const data = envelope(kit, response, 0).data;
    expect(data?.['realname_status']).toBe('verified');
    expect(data?.['masked_name']).toContain('明');
    responses.push(response);
  }
  expect(await f.rows()).toEqual(before);
  expect(kit.vendor).not.toHaveBeenCalled();
  privateDataAbsent(kit, responses, ['不应替换']);
});

it('[AC-B1-13d#14] verified 仍先检查手机和最新同意', async () => {
  const f = await fixture(kit, { phone: false, consent: false });
  await seedVerified(kit, f);
  const before = await f.rows();
  envelope(kit, await f.submit(), 10005);
  await sql`UPDATE app.users SET phone_hmac = ${'b'.repeat(64)} WHERE id = ${f.uid}`.execute(
    kit.db,
  );
  expect(envelope(kit, await f.submit(), 10004).data).toEqual({ consent_type: 'id_verification' });
  expect(await f.rows()).toEqual(before);
  expect(kit.vendor).not.toHaveBeenCalled();
});

it('[AC-B1-13d#15] 成功前其他账号抢先实名，真实 PG 部分唯一冲突回 30405 并计一次', async () => {
  const f = await fixture(kit);
  const winner = await fixture(kit, { appId: f.appId });
  kit.vendor.mockImplementationOnce(async () => {
    // The preflight found no owner; now commit an actual competing verified row before return.
    await seedVerified(kit, winner);
    return { outcome: 'match', provider: 'test-two-elements' };
  });
  const conflict = await f.submit();
  envelope(kit, conflict, 30405);
  expect(kit.vendor).toHaveBeenCalledTimes(1);
  expect((await f.rows()).some((row) => row['status'] === 'verified')).toBe(false);
  for (let i = 0; i < 2; i++) envelope(kit, await f.submit(), 30405);
  envelope(kit, await f.submit(), 30410);
  expect(kit.vendor).toHaveBeenCalledTimes(1);
  const rows = (
    await sql<{
      user_id: string;
    }>`SELECT user_id FROM app.realname WHERE app_id = ${f.appId} AND status = 'verified'`.execute(
      kit.db,
    )
  ).rows;
  expect(rows).toEqual([{ user_id: winner.uid }]);
  privateDataAbsent(kit, [conflict], [winner.uid]);
});

it('[AC-B1-13d#16] 不同 app 的已实名号码不占用本 app，失败行不占用证件', async () => {
  const owner = await fixture(kit);
  await seedVerified(kit, owner);
  const f = await fixture(kit);
  const failed = await fixture(kit, { appId: f.appId });
  envelope(kit, await failed.submit(), 30406);
  kit.vendor.mockResolvedValue({ outcome: 'match', provider: 'test-two-elements' });
  envelope(kit, await f.submit(), 0);
  expect((await f.rows())[0]?.['status']).toBe('verified');
  expect(kit.vendor).toHaveBeenCalledTimes(2);
});

it('[AC-B1-13d#17] Redis 不可用封闭失败 50001，不调用供应商也不存密文', async () => {
  const f = await fixture(kit);
  kit.faults.redis = true;
  envelope(kit, await f.submit(), 50001);
  expect(kit.vendor).not.toHaveBeenCalled();
  expect(await f.rows()).toEqual([]);
  expect([...kit.namespaces].some((name) => name.includes('realname'))).toBe(true);
  kit.faults.redis = false;
  for (let i = 0; i < 3; i++) envelope(kit, await f.submit(), 30406);
  envelope(kit, await f.submit(), 30410);
});

it('[AC-B1-13d#18] 公共只读出口使用调用方事务，隔离 app、不缓存、不改库', async () => {
  const f = await fixture(kit);
  const read = await reader(kit);
  const subject = { app_id: f.appId, user_id: f.uid };
  expect(await read.read(kit.db, subject)).toBe('none');
  expect(await read.verified(kit.db, subject)).toBeNull();
  await seedVerified(kit, f);
  const before = await f.rows();
  expect(await read.read(kit.db, subject)).toBe('verified');
  expect(await read.verified(kit.db, subject)).toEqual({
    name: NAME,
    birth_date: '1949-12-31',
    provider: 'test-two-elements',
    verified_at: new Date(NOW),
  });
  expect(await read.read(kit.db, { ...subject, app_id: 'another-app' })).toBe('none');
  expect(await read.verified(kit.db, { ...subject, app_id: 'another-app' })).toBeNull();
  expect(await f.rows()).toEqual(before);
  await kit.db.transaction().execute(async (trx) => {
    await sql`UPDATE app.realname SET status = 'failed', name_cipher = NULL, id_no_cipher = NULL, id_no_hmac = NULL, birth_date_cipher = NULL WHERE app_id = ${f.appId} AND user_id = ${f.uid}`.execute(
      trx,
    );
    expect(await read.read(trx, subject)).toBe('failed');
    expect(await read.verified(trx, subject)).toBeNull();
  });
  const after = await f.rows();
  expect(after[0]?.['row_version']).toBe(before[0]?.['row_version']);
  expect(kit.vendor).not.toHaveBeenCalled();
});

it('[AC-B1-13d#19] AppModule 给守卫⑨装配真实读取，verified 放行且 failed 再次拒绝', async () => {
  const f = await fixture(kit);
  const level = (await import(
    new URL('apps/api/src/modules/identity/application/identity-level.ts', ROOT).href
  )) as typeof Level;
  const checks = kit.app.get<Level.IdentityLevelChecks>(level.IDENTITY_LEVEL_CHECKS);
  const request = {
    id: randomUUID(),
    method: 'GET',
    routeOptions: { url: '/v1/me/payout-account' },
    headers: {},
    principal: {
      uid: f.uid,
      app_id: f.appId,
      scp: 'full' as const,
      sid: randomUUID(),
      device_id: f.deviceId,
    },
  };
  const context = { switchToHttp: () => ({ getRequest: () => request }) };
  await expect(checks.guard.canActivate(context)).rejects.toMatchObject({ code: 30304 });
  await seedVerified(kit, f);
  const outcome = await checks.guard.canActivate(context).then(
    (allowed) => allowed,
    (error: unknown) => error,
  );
  expect(outcome).toBe(true);
  await sql`UPDATE app.realname SET status = 'failed', name_cipher = NULL, id_no_cipher = NULL, id_no_hmac = NULL, birth_date_cipher = NULL WHERE app_id = ${f.appId} AND user_id = ${f.uid}`.execute(
    kit.db,
  );
  await expect(checks.guard.canActivate(context)).rejects.toMatchObject({ code: 30304 });
});

it('[AC-B1-13d#22] 未装配供应商时真实路由返回 50301，重复请求不产生实名行', async () => {
  const unavailable = await open(database, server, true);
  try {
    const f = await fixture(unavailable);
    const responses = [];
    for (let i = 0; i < 4; i++) {
      const response = await f.submit();
      envelope(unavailable, response, 50301);
      responses.push(response);
    }
    expect(unavailable.vendor).not.toHaveBeenCalled();
    expect(await f.rows()).toEqual([]);
    privateDataAbsent(unavailable, responses);
  } finally {
    await close(unavailable);
  }
});

it('[AC-B1-13d#23] 已有两次明确失败后供应商超时，只退本次预占，不能清空历史次数', async () => {
  const f = await fixture(kit);
  for (let i = 0; i < 2; i++) envelope(kit, await f.submit(), 30406);
  const before = await f.rows();
  kit.vendor.mockResolvedValueOnce({ outcome: 'timeout' });
  envelope(kit, await f.submit(), 50401);
  expect(await f.rows()).toEqual(before);
  envelope(kit, await f.submit(), 30406);
  envelope(kit, await f.submit(), 30410);
  expect(kit.vendor).toHaveBeenCalledTimes(4);
});

it('[AC-B1-13d#24] 已占用号码的小写 x 与空白规范化后仍 30405，不能绕过去重', async () => {
  const owner = await fixture(kit);
  await seedVerified(kit, owner);
  const f = await fixture(kit, { appId: owner.appId });
  const response = await f.submit({ name: NAME, id_no: ' 11010519491231002x ' });
  envelope(kit, response, 30405);
  expect(kit.vendor).not.toHaveBeenCalled();
  privateDataAbsent(kit, [response], [owner.uid]);
});
