import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type * as Privacy from '../../../../apps/api/src/modules/identity/application/privacy-consent.ts';
import type * as Platform from '../../../../apps/api/src/modules/platform/index.ts';
import type * as Scope from '../../../../apps/api/src/modules/risk/application/minimum-version.ts';
import {
  ROOT,
  NOW,
  MIN_KEY,
  activate,
  consent,
  noKey,
  privacyError,
  request,
  user,
} from './kit.ts';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: ReturnType<typeof createDb>;
let api: typeof Privacy;
let platform: typeof Platform;
let scope: typeof Scope;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 3 });
  api = (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as typeof Privacy;
  platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as typeof Platform;
  scope = (await import(
    new URL('apps/api/src/modules/risk/application/minimum-version.ts', ROOT).href
  )) as typeof Scope;
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

async function fixture(value: unknown = 3) {
  const appId = `privacy_${randomUUID()}`;
  const uid = await user(db, appId);
  const input = request(appId, uid);
  const configValue = vi.fn<Privacy.PrivacyConsentConfigReader['configValue']>(async () =>
    value === undefined ? null : { value, version: 1 },
  );
  const warn = vi.fn();
  const options: Privacy.PrivacyConsentOptions = {
    db,
    config: { pooled: { configValue }, on: () => ({ configValue }) },
    logger: { warn },
  };
  return { appId, uid, input, configValue, warn, options };
}

it('[AC-B1-02zh#3] 配置缺失只警告 config_key；无用户记录放行；两种情况不能混为拒绝', async () => {
  const f = await fixture();
  f.configValue.mockResolvedValueOnce(null);
  await consent(db, f.appId, f.uid, { accepted: false });
  const checks = api.createPrivacyConsentChecks(f.options);
  await expect(activate(checks, f.input)).resolves.toBe(true);
  expect(f.warn).toHaveBeenCalledWith(
    { config_key: 'legal.privacy.min_version' },
    expect.any(String),
  );
  expect(f.warn.mock.calls[0]?.[0]).toEqual({ config_key: 'legal.privacy.min_version' });
  const other = await user(db, f.appId);
  await expect(activate(checks, request(f.appId, other))).resolves.toBe(true);
  await expect(activate(checks, f.input)).rejects.toMatchObject(privacyError(f.input.id));
});

it('[AC-B1-02zh#4] server_at 最新优先于版本、accepted 与插入顺序；同刻 id 后者获胜，逐请求读取', async () => {
  const f = await fixture();
  await consent(db, f.appId, f.uid, { version: 8, at: '2026-10-17T02:00:02Z' });
  await consent(db, f.appId, f.uid, {
    version: 1,
    accepted: false,
    clientAt: '2099-01-01T00:00:00Z',
  });
  const selects: string[] = [];
  const counted = db.withPlugin({
    transformQuery(args) {
      if (args.node.kind === 'SelectQueryNode') selects.push(JSON.stringify(args.node));
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  const checks = api.createPrivacyConsentChecks({ ...f.options, db: counted });
  await expect(activate(checks, f.input)).resolves.toBe(true);
  const earlier = await consent(db, f.appId, f.uid, {
    accepted: false,
    version: 9,
    at: '2026-10-17T02:00:02Z',
  });
  await expect(activate(checks, f.input)).rejects.toMatchObject(privacyError(f.input.id));
  const later = await consent(db, f.appId, f.uid, { version: 3, at: '2026-10-17T02:00:02Z' });
  expect(BigInt(later.id)).toBeGreaterThan(BigInt(earlier.id));
  await expect(activate(checks, f.input)).resolves.toBe(true);
  expect(selects).toHaveLength(3);
  for (const query of selects) {
    expect(query).toContain('consent_records');
    expect(JSON.parse(query)).toMatchObject({
      limit: { kind: 'LimitNode', limit: { kind: 'ValueNode', value: 1 } },
    });
  }
  expect(f.configValue).toHaveBeenCalledWith(f.appId, 'legal.privacy.min_version');
});

it('[AC-B1-02zh#5] 用户、app_id、类型和主体隔离，设备撤回与 agreement 不影响用户 privacy', async () => {
  const f = await fixture();
  const uidB = await user(db, f.appId);
  const otherApp = `privacy_${randomUUID()}`;
  const uidC = await user(db, otherApp);
  await consent(db, f.appId, f.uid, { version: 3 });
  await consent(db, f.appId, uidB, { version: 1 });
  await consent(db, otherApp, uidC, { accepted: false, version: 9 });
  const device = randomUUID();
  await sql`INSERT INTO app.devices (id, app_id, device_hash, id_source, platform,
    app_version, last_seen_at, install_secret_cipher)
    VALUES (${device}, ${f.appId}, ${'a'.repeat(64)}, 'idfv', 'ios', '2.0.0',
    ${new Date(NOW)}, ${Buffer.from('synthetic')})`.execute(db);
  await consent(db, f.appId, f.uid, {
    subject: 'device',
    device,
    accepted: false,
    version: 1,
    at: '2026-10-17T02:00:03Z',
  });
  await consent(db, f.appId, f.uid, {
    type: 'agreement',
    accepted: false,
    at: '2026-10-17T02:00:04Z',
  });
  const checks = api.createPrivacyConsentChecks(f.options);
  await expect(activate(checks, f.input)).resolves.toBe(true);
  const b = request(f.appId, uidB);
  const cross = request(otherApp, uidC);
  await expect(activate(checks, b)).rejects.toMatchObject(privacyError(b.id));
  await expect(activate(checks, cross)).rejects.toMatchObject(privacyError(cross.id));
  // users.id is globally unique and consent_records has a composite FK: the same uid cannot
  // have valid rows in two apps. Query that uid under the other app instead; no matching row
  // must be found. An omitted app_id predicate would incorrectly return uidB's low consent.
  await expect(activate(checks, request(otherApp, uidB))).resolves.toBe(true);
});

for (const [method, path] of [
  ['POST', '/v1/consents'],
  ['POST', '/v1/auth/refresh'],
  ['GET', '/v1/config'],
  ['POST', '/v1/auth/logout'],
  ['GET', '/v1/agreements/:type'],
  ['GET', '/v1/articles/:id'],
  ['POST', '/v1/agent/sessions'],
  ['GET', '/v1/agent/sessions/current'],
  ['GET', '/__privacy_unknown'],
  ['PUT', '/v1/me/favorites/:platform/:product_key'],
] as const) {
  it(`[AC-B1-02zh#6] 守卫跳过 ${method} ${path}，不读库或配置`, async () => {
    const f = await fixture();
    const checks = api.createPrivacyConsentChecks({ ...f.options, db: null });
    await expect(activate(checks, request(f.appId, f.uid, method, path))).resolves.toBe(true);
    expect(f.configValue).not.toHaveBeenCalled();
  });
}

for (const [method, path] of [
  ['GET', '/v1/me'],
  ['PATCH', '/v1/me'],
  ['POST', '/v1/auth/step-up'],
  ['GET', '/v1/me/deletion'],
  ['POST', '/v1/me/deletion/cancel'],
  ['POST', '/v1/idempotency-keys/abandon'],
  ['GET', '/v1/me/payout-account'],
  ['GET', '/v1/invites/me'],
] as const) {
  it(`[AC-B1-02zh#7] ${method} ${path} 没有隐私白名单豁免`, async () => {
    const f = await fixture();
    await consent(db, f.appId, f.uid);
    const input = request(f.appId, f.uid, method, path);
    const checks = api.createPrivacyConsentChecks(f.options);
    await expect(activate(checks, input)).rejects.toMatchObject(privacyError(input.id));
  });
}

for (const failure of [
  'db',
  'config',
  'no-db',
  'no-config',
  'zero',
  'fraction',
  'string',
] as const) {
  it(`[AC-B1-02zh#8] ${failure} → 50001，不能误放行`, async () => {
    const f = await fixture();
    await consent(db, f.appId, f.uid, { version: 9 });
    const unavailable = db.withPlugin({
      transformQuery() {
        throw new Error('fixture database failed');
      },
      async transformResult(args) {
        return args.result;
      },
    });
    if (failure === 'config') f.configValue.mockRejectedValue(new Error('fixture config failed'));
    if (failure === 'zero') f.configValue.mockResolvedValue({ value: 0, version: 1 });
    if (failure === 'fraction') f.configValue.mockResolvedValue({ value: 1.5, version: 1 });
    if (failure === 'string') f.configValue.mockResolvedValue({ value: '3', version: 1 });
    const checks = api.createPrivacyConsentChecks({
      ...f.options,
      db: failure === 'no-db' ? null : failure === 'db' ? unavailable : db,
      config: failure === 'no-config' ? null : f.options.config,
    });
    await expect(activate(checks, f.input)).rejects.toMatchObject({ code: 50001, statusCode: 500 });
  });
}

it('[AC-B1-02zh#9] 无 HTTP scope 的直接幂等调用不判隐私', async () => {
  const f = await fixture();
  const checks = api.createPrivacyConsentChecks({ ...f.options, db: null });
  await expect(
    checks.postMiss({
      appId: f.appId,
      actor: { userId: f.uid, deviceId: null, phoneHmac: null },
      method: 'POST',
      path: '/v1/me/deletion',
      key: randomUUID(),
      body: {},
      traceId: f.input.id,
    }),
  ).resolves.toBeUndefined();
  expect(f.configValue).not.toHaveBeenCalled();
});

for (const mode of ['allow', 'refuse', 'config-failure', 'consent-failure'] as const) {
  it(`[AC-B1-02zh#10] post-miss ${mode}：配置与同意都在 claim 事务读取，拒绝不留键、不执行后续检查`, async () => {
    const f = await fixture();
    await consent(db, f.appId, f.uid, { version: 1 });
    const input = request(f.appId, f.uid, 'POST', '/v1/me/deletion');
    const key = randomUUID();
    const clock = new platform.FixedClock(NOW);
    const content = (await import(new URL('apps/api/src/modules/content/index.ts', ROOT).href)) as {
      createContentReader(options: {
        db: ReturnType<typeof createDb>;
        clock: Platform.Clock;
      }): Privacy.PrivacyConsentConfigReader;
    };
    let reading = false;
    const handle = db.withPlugin({
      transformQuery(args) {
        if (
          reading &&
          mode === 'consent-failure' &&
          args.node.kind === 'SelectQueryNode' &&
          JSON.stringify(args.node).includes('consent_records')
        )
          throw new Error('fixture read failed');
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const poisoned = db.withPlugin({
      transformQuery() {
        throw new Error('must not borrow pooled connection');
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const on = vi.fn<NonNullable<Privacy.PrivacyConsentOptions['config']>['on']>((trx) => {
      expect(trx.isTransaction).toBe(true);
      if (mode === 'config-failure') throw new Error('fixture config failed');
      const reader = content.createContentReader({ db: trx, clock });
      return {
        async configValue(appId, key) {
          const expected = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(
            platform.idempotencyPostMissTransaction()!,
          );
          const actual = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
          expect(actual.rows).toEqual(expected.rows);
          return reader.configValue(appId, key);
        },
      };
    });
    const checks = api.createPrivacyConsentChecks({
      ...f.options,
      db: poisoned,
      config: { pooled: { configValue: f.configValue }, on },
    });
    const idem = platform.createIdempotency({
      db: handle.withSchema('app'),
      clock,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    platform.registerIdempotencyPostMissCheck(idem, async () => {
      const trx = platform.idempotencyPostMissTransaction()!;
      await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
        VALUES (${f.appId}, ${MIN_KEY}, '3'::jsonb, 'privacy-test')`.execute(trx);
      await consent(trx, f.appId, f.uid, {
        version: 3,
        accepted: mode !== 'refuse',
        at: '2026-10-17T02:00:05Z',
      });
    });
    platform.registerIdempotencyPostMissCheck(idem, async (command) => {
      reading = true;
      try {
        await checks.postMiss(command);
      } finally {
        reading = false;
      }
    });
    const later = vi.fn(async () => {});
    platform.registerIdempotencyPostMissCheck(idem, later);
    const business = vi.fn(async () => ({
      status: 200,
      envelope: { code: 0, msg: '', data: {}, trace_id: input.id },
    }));
    const run = () =>
      scope.MINIMUM_VERSION_SCOPE.run({ request: input, idempotencyEntered: false }, () =>
        idem.executeInTransaction(
          {
            appId: f.appId,
            actor: { userId: f.uid, deviceId: null, phoneHmac: null },
            method: 'POST',
            path: '/v1/me/deletion',
            key,
            body: {},
            traceId: input.id,
          },
          business,
        ),
      );
    if (mode === 'allow') {
      expect((await run()).status).toBe(200);
      expect(later).toHaveBeenCalledTimes(1);
      expect(business).toHaveBeenCalledTimes(1);
    } else {
      await expect(run()).rejects.toMatchObject(
        mode === 'refuse' ? privacyError(input.id) : { code: 50001, statusCode: 500 },
      );
      expect(later).not.toHaveBeenCalled();
      expect(business).not.toHaveBeenCalled();
      await noKey(db, f.appId, key);
    }
    expect(on).toHaveBeenCalledTimes(1);
    expect(f.configValue).not.toHaveBeenCalled();
  });
}
