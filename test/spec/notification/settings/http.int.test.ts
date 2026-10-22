// Real authenticated Fastify requests and business-role persistence; no external services.
import { createHash, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { bindPushTokensForSession } from '../../../../apps/api/src/modules/notification/application/session-bindings.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  createValidatorCompiler,
  routeSchemaOf,
  validationErrorEnvelope,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { HEADERS, fixture as identityFixture } from '../../identity/token/kit.ts';
import { contract, ROOT, type Response } from '../../risk/signature/kit.ts';
import {
  COMBINATIONS,
  NOW,
  OFF,
  ON,
  PATH,
  TIMEOUT,
  expectSchema,
  seedSettings,
  seedUser,
  settingsOf,
  type Operation,
  type Settings,
} from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db !== undefined) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: {
    method: 'GET' | 'PUT';
    url: string;
    headers: Record<string, string>;
    payload?: unknown;
  }): Promise<Response>;
}

async function fixture() {
  const deps = identityFixture();
  deps.clock.set(NOW);
  const login = async () => {
    const device_id = randomUUID();
    await db
      .withSchema('app')
      .insertInto('devices')
      .values({
        id: device_id,
        app_id: 'couli',
        device_hash: createHash('sha256').update(device_id).digest('hex'),
        id_source: 'idfv',
        install_secret_cipher: Buffer.from('unused-by-settings-tests'),
        platform: 'ios',
        app_version: '2.0.0',
        last_seen_at: deps.clock.now(),
        created_at: deps.clock.now(),
      })
      .execute();
    const uid = await seedUser(db, 'couli');
    const issued = await db
      .transaction()
      .execute((trx) =>
        createSession(
          trx,
          { uid, app_id: 'couli', device_id, scp: 'full' },
          deps,
          (same, session) =>
            bindPushTokensForSession(
              same,
              { app_id: 'couli', user_id: uid, device_id, sid: session.sid },
              deps.clock,
            ),
        ),
      );
    return { uid, device_id, ...issued };
  };
  const me = await login();
  const someone = await login();
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: 'api', overrides: object): Promise<App>;
  };
  const app = await createHttpApp('api', {
    config: loadConfig({
      APP_ENV: 'test',
      JWT_KEY_ID: deps.keyring.kid,
      JWT_PRIVATE_KEY_PEM: deps.keyring.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    }),
    clock: deps.clock,
    logger: createRootLogger({ entry: 'api', appEnv: 'test', level: 'silent' }),
    dbHandles: { db, dbRead: null, close: async () => undefined },
    startQueue: false,
  });
  const request = (method: 'GET' | 'PUT', payload?: unknown, caller = me) =>
    app.inject({
      method,
      url: PATH,
      headers: {
        ...HEADERS,
        'x-channel': 'appstore',
        'x-device-id': caller.device_id,
        authorization: `Bearer ${caller.access_token}`,
      },
      ...(payload === undefined ? {} : { payload }),
    });
  return {
    app,
    request,
    clock: deps.clock,
    someone,
    owner: { app_id: 'couli', user_id: me.uid },
    other: { app_id: 'couli', user_id: someone.uid },
  };
}

async function success(response: Response, operation: Operation, settings: Settings) {
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, msg: '', data: settings });
  await expectSchema(operation, '200', response.json());
}

it(
  '[AC-B1-12m#12] HTTP默认全开且不插行，PUT八种组合可往返、重复保存不增行且隔离登录账号',
  async () => {
    const f = await fixture();
    try {
      await seedSettings(db, f.other, OFF);
      const beforeOther = await settingsOf(db, f.other);
      await f.app.init();
      await success(await f.request('GET'), 'getNotificationSettings', ON);
      expect(await settingsOf(db, f.owner)).toEqual([]);
      for (const settings of COMBINATIONS) {
        f.clock.advanceMs(1_000);
        await success(await f.request('PUT', settings), 'updateNotificationSettings', settings);
        await success(await f.request('GET'), 'getNotificationSettings', settings);
        await success(await f.request('PUT', settings), 'updateNotificationSettings', settings);
        const rows = await settingsOf(db, f.owner);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ ...f.owner, ...settings, updated_at: f.clock.now() });
        await success(await f.request('GET', undefined, f.someone), 'getNotificationSettings', OFF);
        expect(await settingsOf(db, f.other)).toEqual(beforeOther);
      }
    } finally {
      await f.app.close();
    }
  },
  TIMEOUT,
);

const fields = ['service_push', 'subscription_push', 'marketing_push'] as const;
const invalidBodies: { label: string; value: unknown; field?: string }[] = [
  ...fields.map((field) => ({
    label: `缺少${field}`,
    value: Object.fromEntries(Object.entries(ON).filter(([key]) => key !== field)),
    field,
  })),
  ...['extra', 'app_id', 'user_id'].map((field) => ({
    label: `额外${field}`,
    value: { ...ON, [field]: 'untrusted-value' },
    field,
  })),
  ...fields.flatMap((field) =>
    [null, 0, 1, 'true', 'false', [], {}].map((value) => ({
      label: `${field}非布尔${JSON.stringify(value)}`,
      value: { ...ON, [field]: value },
      field,
    })),
  ),
  { label: '空对象', value: {} },
  { label: '数组', value: [] },
];

it.each(invalidBodies)(
  '[AC-B1-12m#13] $label：20001且fields与平台契约校验一致，原值和元数据不变',
  async ({ value, field }) => {
    const f = await fixture();
    try {
      await seedSettings(db, f.owner, OFF);
      await seedSettings(db, f.other, ON);
      await f.app.init();
      await success(await f.request('GET'), 'getNotificationSettings', OFF);
      const before = await settingsOf(db, f.owner);
      const beforeOther = await settingsOf(db, f.other);
      const op = (await contract()).paths[PATH]!.put!;
      const route = routeSchemaOf(op as Parameters<typeof routeSchemaOf>[0]);
      const check = createValidatorCompiler()({ schema: route.body!, httpPart: 'body' });
      expect(check(structuredClone(value))).toBe(false);
      const expected = validationErrorEnvelope(
        { code: 'FST_ERR_VALIDATION', validation: check.errors, validationContext: 'body' },
        'fixture-trace',
      );
      expect(expected?.body.data.fields.length).toBeGreaterThan(0);
      if (field !== undefined) expect(expected!.body.data.fields).toContain(field);
      const response = await f.request('PUT', value);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({
        code: 20001,
        data: { fields: expected!.body.data.fields },
      });
      await expectSchema('updateNotificationSettings', '4XX', response.json());
      expect(await settingsOf(db, f.owner)).toEqual(before);
      expect(await settingsOf(db, f.other)).toEqual(beforeOther);
    } finally {
      await f.app.close();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-12m#14] HTTP并发首次PUT都返回200和各自保存值，最终仅一行完整设置',
  async () => {
    const f = await fixture();
    try {
      await f.app.init();
      expect(await settingsOf(db, f.owner)).toEqual([]);
      const results = await Promise.all([f.request('PUT', OFF), f.request('PUT', ON)]);
      await success(results[0], 'updateNotificationSettings', OFF);
      await success(results[1], 'updateNotificationSettings', ON);
      const rows = await settingsOf(db, f.owner);
      expect(rows).toHaveLength(1);
      expect([OFF, ON]).toContainEqual({
        service_push: rows[0]!.service_push,
        subscription_push: rows[0]!.subscription_push,
        marketing_push: rows[0]!.marketing_push,
      });
      expect(rows[0]).toMatchObject({
        row_version: 1,
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      });
    } finally {
      await f.app.close();
    }
  },
  TIMEOUT,
);
