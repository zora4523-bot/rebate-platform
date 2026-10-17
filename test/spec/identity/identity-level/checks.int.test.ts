import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type * as LevelApi from '../../../../apps/api/src/modules/identity/application/identity-level.ts';
import type * as PlatformApi from '../../../../apps/api/src/modules/platform/index.ts';
import type * as ScopeApi from '../../../../apps/api/src/modules/risk/application/minimum-version.ts';
import { seedUser } from '../registration/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
const PAYOUT = '/v1/me/payout-account';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: ReturnType<typeof createDb>;
let api: typeof LevelApi;
let platform: typeof PlatformApi;
let scope: typeof ScopeApi;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 3 });
  api = (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as typeof LevelApi;
  platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as typeof PlatformApi;
  scope = (await import(
    new URL('apps/api/src/modules/risk/application/minimum-version.ts', ROOT).href
  )) as typeof ScopeApi;
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

function request(
  appId: string,
  uid: string,
  path = PAYOUT,
  method = 'GET',
): ScopeApi.MinimumVersionRequest {
  return {
    id: randomUUID(),
    method,
    routeOptions: { url: path },
    headers: { 'x-app-id': 'untrusted-other-app' },
    principal: { app_id: appId, uid, sid: randomUUID(), device_id: randomUUID(), scp: 'full' },
    body: {
      app_id: 'untrusted-other-app',
      user_id: randomUUID(),
      phone_bound: true,
      realname_status: 'verified',
    },
  };
}
function activate(checks: LevelApi.IdentityLevelChecks, input: ScopeApi.MinimumVersionRequest) {
  return checks.guard.canActivate({ switchToHttp: () => ({ getRequest: () => input }) });
}
async function subject(phone: boolean) {
  const appId = `il_${randomBytes(10).toString('hex')}`;
  const uid = await seedUser(
    db,
    appId,
    phone ? { phoneHmac: randomBytes(32).toString('hex') } : {},
  );
  return { appId, uid, input: request(appId, uid) };
}

it('[AC-B1-02za#13] 默认实名只读端口恒为 none，不尝试读取尚未建表的 app.realname', async () => {
  const poisoned = db.withPlugin({
    transformQuery() {
      throw new Error('default reader must not query');
    },
    async transformResult(args) {
      return args.result;
    },
  });
  const reader = api.createDefaultRealnameStatusReader();
  expect(await reader.read(poisoned, { app_id: 'fixture', user_id: randomUUID() })).toBe('none');
});

for (const missing of ['no-row', 'other-app', 'null-phone'] as const) {
  it(`[AC-B1-02za#14] ${missing} → 10005，不调用实名端口（按令牌 app_id/uid 隔离）`, async () => {
    const s = await subject(missing !== 'null-phone');
    const read = vi.fn(async () => 'verified' as const);
    const checks = api.createIdentityLevelChecks({ db, realname: { read } });
    const input =
      missing === 'no-row'
        ? request(s.appId, randomUUID())
        : missing === 'other-app'
          ? request('other-app', s.uid)
          : s.input;
    await expect(activate(checks, input)).rejects.toMatchObject({ code: 10005, statusCode: 403 });
    expect(read).not.toHaveBeenCalled();
  });
}

for (const status of ['none', 'failed', 'verified'] as const) {
  it(`[AC-B1-02za#15] 实名端口 ${status} 决定结果；每个请求仅一次 users 读取和一次实名读取`, async () => {
    const s = await subject(true);
    const selects: unknown[] = [];
    const counted = db.withPlugin({
      transformQuery(args) {
        if (args.node.kind === 'SelectQueryNode') selects.push(args.node);
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const read = vi.fn(async () => status);
    const checks = api.createIdentityLevelChecks({ db: counted, realname: { read } });
    for (let n = 0; n < 2; n++) {
      if (status === 'verified') await expect(activate(checks, s.input)).resolves.toBe(true);
      else
        await expect(activate(checks, s.input)).rejects.toMatchObject({
          code: 30304,
          statusCode: 422,
        });
    }
    expect(selects).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(2);
    for (const [, principal] of read.mock.calls as unknown as Parameters<
      LevelApi.RealnameStatusReader['read']
    >[]) {
      expect(principal).toEqual({ app_id: s.appId, user_id: s.uid });
    }
  });
}

it('[AC-B1-02za#16] 同一检查实例不缓存实名状态：verified 后变 failed 立即拒绝', async () => {
  const s = await subject(true);
  const read = vi
    .fn<LevelApi.RealnameStatusReader['read']>()
    .mockResolvedValueOnce('verified')
    .mockResolvedValueOnce('failed');
  const checks = api.createIdentityLevelChecks({ db, realname: { read } });
  await expect(activate(checks, s.input)).resolves.toBe(true);
  await expect(activate(checks, s.input)).rejects.toMatchObject({ code: 30304, statusCode: 422 });
  expect(read).toHaveBeenCalledTimes(2);
});

for (const failure of ['db', 'realname', 'no-db'] as const) {
  it(`[AC-B1-02za#17] ${failure} 不可读时 fail-closed 50001，不当作实名未认证或直接放行`, async () => {
    const s = await subject(true);
    const unavailable = db.withPlugin({
      transformQuery() {
        throw new Error('fixture database failure');
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const read = vi.fn(async () => {
      if (failure === 'realname') throw new Error('fixture realname failure');
      return 'verified' as const;
    });
    const checks = api.createIdentityLevelChecks({
      db: failure === 'no-db' ? null : failure === 'db' ? unavailable : db,
      realname: { read },
    });
    await expect(activate(checks, s.input)).rejects.toMatchObject({ code: 50001, statusCode: 500 });
  });
}

for (const [method, path] of [
  ['POST', '/v1/devices'], // none
  ['GET', '/v1/products/search'], // optional
  ['GET', '/v1/me'], // login
  ['POST', '/v1/agent/sessions'], // BR-AI-23 owns agent order
  ['GET', '/v1/agent/future-route'],
  ['GET', '/__identity_level_unknown'],
  ['PUT', PAYOUT], // idempotent requests must be left to post-miss
] as const) {
  it(`[AC-B1-02za#18] 守卫跳过 ${method} ${path}，不触库或实名端口`, async () => {
    const read = vi.fn(async () => {
      throw new Error('exempt route must not read');
    });
    const checks = api.createIdentityLevelChecks({ db: null, realname: { read } });
    await expect(activate(checks, request('fixture', randomUUID(), path, method))).resolves.toBe(
      true,
    );
    expect(read).not.toHaveBeenCalled();
  });
}

it('[AC-B1-02za#19] 没有 HTTP scope 的直接幂等调用跳过身份等级检查', async () => {
  const read = vi.fn(async () => {
    throw new Error('non-HTTP must not read');
  });
  const checks = api.createIdentityLevelChecks({ db: null, realname: { read } });
  await expect(
    checks.postMiss({
      appId: 'fixture',
      actor: { userId: randomUUID(), deviceId: null, phoneHmac: null },
      method: 'PUT',
      path: PAYOUT,
      key: randomUUID(),
      body: {},
      traceId: randomUUID(),
    }),
  ).resolves.toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});

it('[AC-B1-02za#20] post-miss 的 phone 和实名读取都用 claim 事务，看到未提交的手机号而不借第二连接', async () => {
  const s = await subject(false);
  const input = request(s.appId, s.uid, PAYOUT, 'PUT');
  const unusablePool = db.withPlugin({
    transformQuery() {
      throw new Error('identity must use the claim transaction');
    },
    async transformResult(args) {
      return args.result;
    },
  });
  const read = vi.fn<LevelApi.RealnameStatusReader['read']>(async (handle, principal) => {
    expect(handle.isTransaction).toBe(true);
    const expected = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(
      platform.idempotencyPostMissTransaction()!,
    );
    const actual = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(handle);
    expect(actual.rows).toEqual(expected.rows);
    expect(principal).toEqual({ app_id: s.appId, user_id: s.uid });
    return 'verified';
  });
  const checks = api.createIdentityLevelChecks({ db: unusablePool, realname: { read } });
  const idem = platform.createIdempotency({
    db: db.withSchema('app'),
    clock: new platform.FixedClock('2026-10-17T02:00:00Z'),
    logger: { warn: vi.fn(), error: vi.fn() },
  });
  platform.registerIdempotencyPostMissCheck(idem, async () => {
    await platform
      .idempotencyPostMissTransaction()!
      .withSchema('app')
      .updateTable('users')
      .set({ phone_hmac: randomBytes(32).toString('hex') })
      .where('id', '=', s.uid)
      .where('app_id', '=', s.appId)
      .execute();
  });
  platform.registerIdempotencyPostMissCheck(idem, checks.postMiss);
  const business = vi.fn(async () => ({
    status: 200,
    envelope: { code: 0, msg: '', data: { fixture: true }, trace_id: input.id },
  }));
  const response = await scope.MINIMUM_VERSION_SCOPE.run(
    { request: input, idempotencyEntered: false },
    () =>
      idem.executeInTransaction(
        {
          appId: s.appId,
          actor: { userId: s.uid, deviceId: null, phoneHmac: null },
          method: 'PUT',
          path: PAYOUT,
          key: randomUUID(),
          body: {},
          traceId: input.id,
        },
        business,
      ),
  );
  expect(response.status).toBe(200);
  expect(read).toHaveBeenCalledTimes(1);
  expect(business).toHaveBeenCalledTimes(1);
});

for (const failure of ['db', 'realname'] as const) {
  it(`[AC-B1-02za#25] post-miss ${failure} 读取失败返回 50001，不执行后续检查或业务、不留幂等记录`, async () => {
    const s = await subject(true);
    const input = request(s.appId, s.uid, PAYOUT, 'PUT');
    const key = randomUUID();
    let checkingIdentity = false;
    const failRead = vi.fn(() => {
      throw new Error('fixture claim-transaction read failure');
    });
    const unavailable = db.withPlugin({
      transformQuery(args) {
        // Let the real idempotency lookup succeed; fail only reads inside the identity hook.
        if (failure === 'db' && checkingIdentity && args.node.kind === 'SelectQueryNode')
          failRead();
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const read = vi.fn<LevelApi.RealnameStatusReader['read']>(async () => {
      if (failure === 'realname') throw new Error('fixture realname read failure');
      return 'verified';
    });
    const checks = api.createIdentityLevelChecks({ db: unavailable, realname: { read } });
    const idem = platform.createIdempotency({
      db: unavailable.withSchema('app'),
      clock: new platform.FixedClock('2026-10-17T02:00:00Z'),
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    const postMiss = vi.fn<PlatformApi.IdempotencyPostMissCheck>(async (request) => {
      checkingIdentity = true;
      try {
        await checks.postMiss(request);
      } finally {
        checkingIdentity = false;
      }
    });
    const laterCheck = vi.fn(async () => {});
    platform.registerIdempotencyPostMissCheck(idem, postMiss);
    platform.registerIdempotencyPostMissCheck(idem, laterCheck);
    const business = vi.fn(async () => ({
      status: 200,
      envelope: { code: 0, msg: '', data: { fixture: true }, trace_id: input.id },
    }));
    await expect(
      scope.MINIMUM_VERSION_SCOPE.run({ request: input, idempotencyEntered: false }, () =>
        idem.executeInTransaction(
          {
            appId: s.appId,
            actor: { userId: s.uid, deviceId: null, phoneHmac: null },
            method: 'PUT',
            path: PAYOUT,
            key,
            body: {},
            traceId: input.id,
          },
          business,
        ),
      ),
    ).rejects.toMatchObject({ code: 50001, statusCode: 500 });
    expect(postMiss).toHaveBeenCalledTimes(1);
    expect(failRead).toHaveBeenCalledTimes(failure === 'db' ? 1 : 0);
    expect(read).toHaveBeenCalledTimes(failure === 'realname' ? 1 : 0);
    expect(laterCheck).not.toHaveBeenCalled();
    expect(business).not.toHaveBeenCalled();
    expect(
      await db
        .withSchema('app')
        .selectFrom('idempotency_keys')
        .select('id')
        .where('app_id', '=', s.appId)
        .where('key', '=', key)
        .execute(),
    ).toEqual([]);
  });
}
