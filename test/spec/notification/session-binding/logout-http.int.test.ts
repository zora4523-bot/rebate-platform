import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import type { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { DbHandles } from '../../../../apps/api/src/modules/platform/db/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { contract, ROOT, type Response } from '../../risk/signature/kit.ts';
import { HEADERS } from '../../identity/token/kit.ts';
import {
  openSuite,
  closeSuite,
  fixture,
  rejectTokenWrites,
  seedUser,
  type Fixture,
  type Suite,
} from './kit.ts';

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
  }): Promise<Response>;
}

async function buildApp(f: Fixture, db = suite.db) {
  // Computed import keeps Nest decorators out of the spec project's erasable TS compilation.
  // This is the real AppModule, with no replacement logout handler or notification provider.
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'api',
      overrides: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
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
    dbHandles: { db, dbRead: null, close: async () => undefined },
  });
}

function logout(app: HttpApp, f: Fixture, token = f.initial.access_token) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/logout',
    headers: {
      ...HEADERS,
      'x-app-id': f.appId,
      'x-device-id': f.deviceId,
      authorization: `Bearer ${token}`,
    },
  });
}

async function accepted(response: Response) {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: {} });
  const operation = (await contract()).paths['/v1/auth/logout']!.post!;
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

it('[BR-ID-07][AC-S1-76#2] 真实HTTP退出经AppModule解绑当前sid，另一设备不受影响', async () => {
  const f = await fixture(suite);
  const id = await f.seedToken();
  const before = await f.token(id);
  const otherDevice = await f.device();
  const other = await f.issue(f.uid, otherDevice);
  const otherId = await f.seedToken({ device_id: otherDevice, bound_sid: other.sid });
  const untouched = await f.token(otherId);
  const app = await buildApp(f);
  try {
    await app.init();
    await accepted(await logout(app, f));
    expect((await f.session()).revoked_at).toEqual(f.clock.now());
    expect(await f.token(id)).toMatchObject({
      user_id: null,
      bound_sid: null,
      revoked_at: null,
      token: before.token,
    });
    expect(await f.token(otherId)).toEqual(untouched);
    expect((await f.session(other.sid)).revoked_at).toBeNull();
  } finally {
    await app.close();
  }
});

for (const account of ['same', 'other'] as const) {
  it(`[BR-ID-07][AC-S1-76#6] ${account}账号新登录后，HTTP退出旧sid保留新绑定，退出新sid才清空`, async () => {
    const f = await fixture(suite);
    const user = account === 'same' ? f.uid : await seedUser(f.db, f.appId);
    const current = await f.issue(user);
    // Direct fixture insert isolates logout wiring from the binding command under test elsewhere.
    const id = await f.seedToken({ user_id: user, bound_sid: current.sid });
    const before = await f.token(id);
    const app = await buildApp(f);
    try {
      await app.init();
      await accepted(await logout(app, f));
      expect(await f.token(id)).toEqual(before);
      expect((await f.session(current.sid)).revoked_at).toBeNull();
      expect((await f.deviceRow()).last_login_sid).toBe(current.sid);
      await accepted(await logout(app, f, current.access_token));
      expect(await f.token(id)).toMatchObject({ user_id: null, bound_sid: null, revoked_at: null });
    } finally {
      await app.close();
    }
  });
}

it('[BR-ID-07][AC-S1-76#2] 真实HTTP退出遇到令牌写失败时，会话吊销必须回滚', async () => {
  const f = await fixture(suite);
  const id = await f.seedToken();
  const before = await f.token(id);
  const session = await f.session();
  const failed = rejectTokenWrites(suite.db);
  const app = await buildApp(f, failed.db);
  try {
    await app.init();
    const response = await logout(app, f);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 50001 });
    expect(failed.attempts()).toBe(1);
    expect(await f.session()).toEqual(session);
    expect(await f.token(id)).toEqual(before);
  } finally {
    await app.close();
  }
});
