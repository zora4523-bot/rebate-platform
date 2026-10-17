// B1-12c · real HTTP through the real AppModule (api entry, business-role PG): the route reports
// through notification with the token principal, answers the contract's EmptyResponse in every
// rule outcome, and the request checks still run before it (BR-ID-07 细则「上报时只接受当前会话」).
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { bindPushTokensForSession } from '../../../../apps/api/src/modules/notification/application/session-bindings.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import type { DbHandles } from '../../../../apps/api/src/modules/platform/db/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { contract, ROOT, type Response } from '../../risk/signature/kit.ts';
import { HEADERS, fixture as tokenFixture } from '../../identity/token/kit.ts';
import { DB_TIMEOUT, PROVIDER, closeSuite, openSuite, seedUser, type Suite } from './kit.ts';

const PATH = '/v1/devices/push-token';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
}, 30_000);

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
}

// HTTP headers and fixture rows use the registered app 'couli'; cases are isolated by device.
async function fixture() {
  const deps = tokenFixture();
  const appId = 'couli';
  const db = suite.db;
  const device = async () => {
    const id = randomUUID();
    await db
      .insertInto('devices')
      .values({
        id,
        app_id: appId,
        device_hash: createHash('sha256').update(id).digest('hex'),
        id_source: 'idfv',
        install_secret_cipher: Buffer.from('unused-by-push-report-tests'),
        platform: 'ios',
        app_version: '2.0.0',
        last_seen_at: deps.clock.now(),
        created_at: deps.clock.now(),
      })
      .execute();
    return id;
  };
  const login = async (deviceId: string) => {
    const uid = await seedUser(db, appId);
    const issued = await db
      .transaction()
      .execute((trx) =>
        createSession(
          trx,
          { uid, app_id: appId, device_id: deviceId, scp: 'full' },
          deps,
          (same, session) =>
            bindPushTokensForSession(
              same,
              { app_id: appId, user_id: uid, device_id: deviceId, sid: session.sid },
              deps.clock,
            ),
        ),
      );
    return { uid, ...issued };
  };
  const rowsOf = (deviceId: string) =>
    db
      .selectFrom('push_tokens')
      .selectAll()
      .where('app_id', '=', appId)
      .where('device_id', '=', deviceId)
      .execute();
  return { ...deps, appId, db, device, login, rowsOf };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function buildApp(f: Fixture) {
  // Computed import keeps Nest decorators out of the spec project's erasable TS compilation.
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'api',
      overrides: {
        config: ReturnType<typeof loadConfig>;
        clock: Fixture['clock'];
        logger: ReturnType<typeof createRootLogger>;
        dbHandles: DbHandles;
      },
    ): Promise<HttpApp>;
  };
  return createHttpApp('api', {
    config: loadConfig({
      APP_ENV: 'test',
      JWT_KEY_ID: f.keyring.kid,
      JWT_PRIVATE_KEY_PEM: f.keyring.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
    clock: f.clock,
    logger: createRootLogger({ entry: 'api', appEnv: 'test', level: 'silent' }),
    dbHandles: { db: suite.db, dbRead: null, close: async () => undefined },
  });
}

function post(app: HttpApp, deviceId: string, body: unknown, accessToken?: string) {
  return app.inject({
    method: 'POST',
    url: PATH,
    headers: {
      ...HEADERS,
      'x-app-id': 'couli',
      'x-device-id': deviceId,
      'content-type': 'application/json',
      ...(accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` }),
    },
    payload: JSON.stringify(body),
  });
}

async function accepted(response: Response) {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, msg: '', data: {} });
  const operation = (await contract()).paths[PATH]!.post!;
  const responses = operation['responses'] as Record<
    string,
    { content: Record<string, { schema: JsonSchema }> }
  >;
  const validate = createValidatorCompiler()({
    schema: responses['200']!.content['application/json']!.schema,
    httpPart: 'body',
  });
  expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
}

it(
  '[AC-B1-12c#31][BR-ID-07] 真实HTTP：当前会话上报写入令牌值与绑定；旧会话上报同样回成功但整条忽略',
  async () => {
    const f = await fixture();
    const d1 = await f.device();
    const s1 = await f.login(d1);
    const app = await buildApp(f);
    try {
      await app.init();
      await accepted(
        await post(app, d1, { provider: PROVIDER, token: 'pt-device-h-001' }, s1.access_token),
      );
      const written = await f.rowsOf(d1);
      expect(written).toEqual([
        expect.objectContaining({
          token: 'pt-device-h-001',
          provider: PROVIDER,
          user_id: s1.uid,
          bound_sid: s1.sid,
          token_set_at: new Date('2026-10-05T04:00:00.000Z'),
          revoked_at: null,
        }),
      ]);
      const s2 = await f.login(d1); // another account logs in on the same device
      const bound = await f.rowsOf(d1);
      expect(bound[0]).toMatchObject({ user_id: s2.uid, bound_sid: s2.sid });
      f.clock.advanceMs(60_000);
      // S1 is still a live session, but no longer the device's last_login_sid.
      await accepted(
        await post(app, d1, { provider: PROVIDER, token: 'pt-device-h-002' }, s1.access_token),
      );
      expect(await f.rowsOf(d1)).toEqual(bound);
    } finally {
      await app.close();
    }
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#32][BR-ID-07] 真实HTTP：请求体不合契约回400/20001且不写；未带令牌回401/10001',
  async () => {
    const f = await fixture();
    const d1 = await f.device();
    const s1 = await f.login(d1);
    const app = await buildApp(f);
    try {
      await app.init();
      await accepted(
        await post(app, d1, { provider: PROVIDER, token: 'pt-device-h-003' }, s1.access_token),
      );
      const before = await f.rowsOf(d1);
      for (const body of [
        { provider: PROVIDER },
        { provider: '', token: 'pt-device-h-004' },
        { provider: PROVIDER, token: 'pt-device-h-004', extra: 1 },
      ]) {
        const invalid = await post(app, d1, body, s1.access_token);
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json()).toMatchObject({ code: 20001 });
      }
      const anonymous = await post(app, d1, { provider: PROVIDER, token: 'pt-device-h-005' });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json()).toMatchObject({ code: 10001 });
      expect(await f.rowsOf(d1)).toEqual(before);
    } finally {
      await app.close();
    }
  },
  DB_TIMEOUT,
);
