// B1-12d · real HTTP through the real AppModule (api entry, business-role PG): GET
// /v1/messages/{message_id} answers the caller's own message, contract-checked; unknown, someone
// else's, another app's and non-UUID ids all answer the same 404 / 30701; the read changes no row;
// the request checks still run before it (BR-ID-10 细则「推送点击的落点」; 编排者裁定 B1–B4).
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { bindPushTokensForSession } from '../../../../apps/api/src/modules/notification/application/session-bindings.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import type { DbHandles } from '../../../../apps/api/src/modules/platform/db/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { ROOT, type Response } from '../../risk/signature/kit.ts';
import { HEADERS, fixture as tokenFixture } from '../../identity/token/kit.ts';
import {
  DB_TIMEOUT,
  closeSuite,
  expectSchema,
  messagesOf,
  newAppId,
  openSuite,
  seedMessage,
  seedUser,
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
  inject(input: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<Response>;
}

// HTTP headers and fixture rows use the registered app 'couli'; cases are isolated by user.
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
        install_secret_cipher: Buffer.from('unused-by-message-read-tests'),
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
    return { uid, device_id: deviceId, ...issued };
  };
  return { ...deps, appId, db, device, login };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Login = Awaited<ReturnType<Fixture['login']>>;

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

function getMessage(app: HttpApp, messageId: string, caller?: Login) {
  return app.inject({
    method: 'GET',
    url: `/v1/messages/${encodeURIComponent(messageId)}`,
    headers: {
      ...HEADERS,
      'x-app-id': 'couli',
      'x-channel': 'appstore',
      ...(caller === undefined
        ? {}
        : { 'x-device-id': caller.device_id, authorization: `Bearer ${caller.access_token}` }),
    },
  });
}

/** 404 / 30701, contract-valid; returns the body without its trace id for comparison. */
async function notFound(response: Response) {
  expect(response.statusCode, response.body).toBe(404);
  const body = response.json();
  expect(body).toMatchObject({ code: 30701 });
  await expectSchema('4XX', body);
  const { trace_id: _trace, ...rest } = body as Record<string, unknown>;
  void _trace;
  return rest;
}

it(
  '[AC-B1-12d#13][BR-ID-10] 真实HTTP：登录账号取自己的消息回200，字段与库一致并过契约InboxMessageResponse；读取不改read_at',
  async () => {
    const f = await fixture();
    const me = await f.login(await f.device());
    const id = await seedMessage(f.db, {
      app_id: 'couli',
      user_id: me.uid,
      code: 'WITHDRAW_PAID',
      title: '提现已到账',
      body: '你的提现已到账',
      route: { route: 'WithdrawRecords', params: {} },
      created_at: '2026-10-02T01:30:00.000Z',
    });
    const before = await messagesOf(f.db, 'couli');
    const app = await buildApp(f);
    try {
      await app.init();
      for (let round = 0; round < 2; round += 1) {
        const response = await getMessage(app, id, me);
        expect(response.statusCode, response.body).toBe(200);
        const body = response.json<{ code: number; msg: string; data: Record<string, unknown> }>();
        await expectSchema('200', body);
        expect(body.code).toBe(0);
        expect(body.msg).toBe('');
        expect({
          ...body.data,
          created_at: new Date(String(body.data['created_at'])).toISOString(),
        }).toEqual({
          message_id: id,
          code: 'WITHDRAW_PAID',
          title: '提现已到账',
          body: '你的提现已到账',
          created_at: '2026-10-02T01:30:00.000Z',
          read_at: null,
          route: { route: 'WithdrawRecords', params: {} },
        });
      }
      expect(await messagesOf(f.db, 'couli')).toEqual(before);
    } finally {
      await app.close();
    }
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12d#14][BR-ID-10] 真实HTTP：不存在、他人的、跨app的、非UUID的message_id一律404/30701且响应完全一致，不改任何消息行',
  async () => {
    const f = await fixture();
    const me = await f.login(await f.device());
    const someone = await f.login(await f.device());
    const mine = await seedMessage(f.db, { app_id: 'couli', user_id: me.uid });
    const theirs = await seedMessage(f.db, { app_id: 'couli', user_id: someone.uid });
    const other = newAppId('oth');
    const foreigner = await seedUser(f.db, other);
    const abroad = await seedMessage(f.db, { app_id: other, user_id: foreigner });
    const beforeHere = await messagesOf(f.db, 'couli');
    const beforeThere = await messagesOf(f.db, other);
    const app = await buildApp(f);
    try {
      await app.init();
      // Sanity: the owners read their own messages, so the misses below are about ownership.
      expect((await getMessage(app, mine, me)).statusCode).toBe(200);
      expect((await getMessage(app, theirs, someone)).statusCode).toBe(200);
      const unknown = await notFound(await getMessage(app, randomUUID(), me));
      expect(unknown).toMatchObject({ code: 30701 });
      expect(await notFound(await getMessage(app, theirs, me))).toEqual(unknown);
      expect(await notFound(await getMessage(app, abroad, me))).toEqual(unknown);
      expect(await notFound(await getMessage(app, 'abc', me))).toEqual(unknown);
      expect(await notFound(await getMessage(app, 'a'.repeat(64), me))).toEqual(unknown);
      expect(await messagesOf(f.db, 'couli')).toEqual(beforeHere);
      expect(await messagesOf(f.db, other)).toEqual(beforeThere);
    } finally {
      await app.close();
    }
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12d#15][BR-ID-10] 真实HTTP：message_id超过64字符回400/20001；未带令牌回401/10001，均不读出消息',
  async () => {
    const f = await fixture();
    const me = await f.login(await f.device());
    const mine = await seedMessage(f.db, { app_id: 'couli', user_id: me.uid });
    const app = await buildApp(f);
    try {
      await app.init();
      expect((await getMessage(app, mine, me)).statusCode).toBe(200);
      const tooLong = await getMessage(app, 'a'.repeat(65), me);
      expect(tooLong.statusCode, tooLong.body).toBe(400);
      expect(tooLong.json()).toMatchObject({ code: 20001 });
      await expectSchema('4XX', tooLong.json());
      const anonymous = await getMessage(app, mine);
      expect(anonymous.statusCode, anonymous.body).toBe(401);
      expect(anonymous.json()).toMatchObject({ code: 10001 });
      expect(anonymous.json()).not.toHaveProperty('data.message_id');
    } finally {
      await app.close();
    }
  },
  DB_TIMEOUT,
);
