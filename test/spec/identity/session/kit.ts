// B1-02k §9: real PG/Redis; setup never calls a B1-02k skeleton.
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, vi } from 'vitest';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import {
  createRefreshService,
  type RefreshCommand,
  type RefreshOptions,
  type RefreshResult,
} from '../../../../apps/api/src/modules/identity/application/refresh.ts';
import { createTokenCheck } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSessionLookup } from '../../../../apps/api/src/modules/identity/infra/session-lookup.ts';
import {
  createRedisHandle,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { openKit, closeKit, seedUser, type Kit } from '../registration/kit.ts';
import { fixture as tokenFixture, request, HEADERS } from '../token/kit.ts';
import { acquireRedis, redisConnection, memoryLogger, type TestRedis } from '../sms-codes/kit.ts';

export const MONTH = 30 * 86400_000;
export const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export interface Suite extends Kit {
  server: TestRedis;
  redis: RedisHandle;
}
export async function openSuite(): Promise<Suite> {
  const kit = await openKit();
  try {
    const server = await acquireRedis();
    expect(server).toBeDefined();
    const redis = await createRedisHandle(redisConnection(server!.url), {
      logger: memoryLogger().logger,
    });
    expect(redis).not.toBeNull();
    return { ...kit, server: server!, redis: redis! };
  } catch (error) {
    await closeKit(kit);
    throw error;
  }
}
export async function closeSuite(suite: Suite | undefined) {
  if (!suite) return;
  try {
    await suite.redis.close();
  } finally {
    try {
      await suite.server.stop();
    } finally {
      await closeKit(suite);
    }
  }
}
export async function fixture(suite: Suite) {
  const deps = tokenFixture();
  const appId = `refresh_${randomUUID().replaceAll('-', '')}`;
  const uid = await seedUser(suite.db, appId);
  const db = suite.db.withSchema('app');
  const device = async (app = appId) => {
    const id = randomUUID();
    await sql`INSERT INTO app.devices
      (id,app_id,device_hash,id_source,install_secret_cipher,platform,app_version,last_seen_at)
      VALUES (${id},${app},${hash(id)},'idfv',${Buffer.from('unused-by-application-tests')},'ios','2.0.0',${deps.clock.now()})`.execute(
      db,
    );
    return id;
  };
  const deviceId = await device();
  const issue = (user = uid, dev = deviceId, app = appId, scp: 'full' | 'deletion_only' = 'full') =>
    db
      .transaction()
      .execute((trx) => createSession(trx, { uid: user, app_id: app, device_id: dev, scp }, deps));
  const initial = await issue();
  const minimum = vi
    .fn<RefreshOptions['versions']['minSupportedVersion']>()
    .mockResolvedValue(null);
  const { logger, lines } = memoryLogger();
  const afterRevoked = vi
    .fn<NonNullable<RefreshOptions['afterRevoked']>>()
    .mockResolvedValue(undefined);
  const options: RefreshOptions = {
    db,
    clock: deps.clock,
    tokens: deps.tokens,
    crypto: suite.crypto,
    redis: suite.redis,
    versions: { minSupportedVersion: minimum },
    logger,
    afterRevoked,
  };
  const command: RefreshCommand = {
    refresh_token: initial.refresh_token,
    verifiedDevice: { deviceId, appId },
    platform: 'ios',
    channel: 'appstore',
    version: '2.0.0',
  };
  const refresh = async (
    input: Partial<RefreshCommand> = {},
    ports: Partial<RefreshOptions> = {},
  ) => createRefreshService({ ...options, ...ports }).refresh({ ...command, ...input });
  const session = (sid = initial.sid, app = appId) =>
    db
      .selectFrom('sessions')
      .selectAll()
      .where('app_id', '=', app)
      .where('sid', '=', sid)
      .executeTakeFirstOrThrow();
  const chain = (sid = initial.sid) =>
    db
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('app_id', '=', appId)
      .where('sid', '=', sid)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  const deviceRow = (id = deviceId) =>
    db.selectFrom('devices').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const guard = createTokenCheck({ tokens: deps.tokens, sessions: createSessionLookup(db) });
  const access = (token = initial.access_token, dev = deviceId) =>
    guard(
      request(
        { method: 'POST', path: '/v1/auth/logout' },
        { ...HEADERS, 'x-app-id': appId, 'x-device-id': dev, authorization: `Bearer ${token}` },
      ),
    );
  return {
    ...deps,
    appId,
    uid,
    deviceId,
    device,
    db,
    issue,
    initial,
    minimum,
    options,
    afterRevoked,
    lines,
    command,
    refresh,
    session,
    chain,
    deviceRow,
    access,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export function success(result: RefreshResult) {
  expect(result.code).toBe(0);
  if (result.code !== 0) throw new Error('unreachable after assertion');
  return result.data;
}
export async function assertRevoked(f: Fixture, token = f.initial.refresh_token) {
  expect(await f.session()).toMatchObject({
    revoked_at: f.clock.now(),
    revoke_reason: 'refresh_reuse',
  });
  expect(await f.refresh({ refresh_token: token })).toEqual({ code: 10404 });
  await expect(f.access()).rejects.toMatchObject({ code: 10002 });
}
export function brokenRedis(redis: RedisHandle, operation: 'get' | 'set'): RedisHandle {
  return {
    ...redis,
    namespace(name) {
      const ns = redis.namespace(name);
      return {
        ...ns,
        [operation]: async () => {
          throw new Error('fixture Redis unavailable');
        },
      };
    },
  };
}
export async function identityExports() {
  // Avoid pulling Nest decorators into the erasable-only spec TypeScript project.
  return (await import(
    new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
  )) as typeof import('../../../../apps/api/src/modules/identity/application/revoke-sessions.ts');
}
