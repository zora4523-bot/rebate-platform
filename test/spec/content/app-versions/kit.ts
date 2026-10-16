// F1-02e rule-test kit: GET /v1/app-versions/check observed only through HTTP, the contract and
// direct writes to app.app_versions (decision 11). No content-module internals are imported.
//
// Sources: contracts/openapi.yaml checkAppVersion + AppVersionCheck/StoreListing; 04 §6.2, §3.2;
// BR-ID-01 「最低支持版本的接口层拦截」; F1-02b [AC-F1-02b#2] (no channel fallback);
// couli-runs/F1-02e/decision-orchestrator.md decisions 1-11 (no row / dirty row -> 50001, stores
// order + default_store appended, 60 s shared cache, X-App-Version never changes the response).
// App wiring copies test/spec/identity/request-context/app.int.test.ts; the row writer copies
// test/spec/content/read/kit.ts seedVersion; validate copies platform-icons/read/kit.ts.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

const ROOT = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));

export const PATH = '/v1/app-versions/check';
export const START = '2031-05-06T07:08:09.000Z';
export const CACHE_MS = 60_000;

export type Check = Schema<'AppVersionCheck'>;

export interface Response {
  statusCode: number;
  headers: Record<string, unknown>;
  json<T = { code: number; msg: string; data?: unknown; trace_id: string }>(): T;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<Response>;
}

export interface Harness {
  app: HttpApp;
  db: Kysely<DB>;
  clock: FixedClock;
}

/** Registers beforeAll/afterAll; the returned object is filled once beforeAll has run. */
export function harness(): Harness {
  const h = {} as Harness;
  let database:
    Awaited<ReturnType<(typeof import('@couli/db/testing'))['createTestDatabase']>> | undefined;
  let redis:
    Awaited<ReturnType<(typeof import('@couli/db/testing'))['acquireTestRedis']>> | undefined;
  let directory: string | undefined;

  beforeAll(async () => {
    const testing = await import('@couli/db/testing');
    database = await testing.createTestDatabase();
    h.db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
    redis = await testing.acquireTestRedis();
    const base = fileURLToPath(new URL('.tmp/', ROOT));
    mkdirSync(base, { recursive: true });
    directory = mkdtempSync(join(base, 'f1-02e-'));
    // Ephemeral synthetic key material only; no real credentials are read.
    const master = randomBytes(32);
    const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
    const masterFile = join(directory, 'synthetic-master.hex');
    const keyringFile = join(directory, 'synthetic-keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 });
    const jwt = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    h.clock = new FixedClock(START);

    const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp(
        entry: 'api',
        options: {
          config: ReturnType<typeof loadConfig>;
          clock: FixedClock;
          logger: ReturnType<typeof createRootLogger>;
          dbHandles: DbHandles;
          redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
        },
      ): Promise<HttpApp>;
    };
    h.app = await createHttpApp('api', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: masterFile,
        FIELD_KEYRING_FILE: keyringFile,
        JWT_KEY_ID: 'f1-02e-p256',
        JWT_PRIVATE_KEY_PEM: jwt.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: h.clock,
      logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
      dbHandles: { db: h.db, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('api', {
        DATABASE_URL: database.urlFor('couli_app'),
        REDIS_URL: redis.url,
      }).redisUrl,
    });
    await h.app.init();
  }, 180_000);

  afterAll(async () => {
    try {
      await h.app?.close();
    } finally {
      try {
        if (h.db !== undefined) await destroyDb(h.db);
        await database?.drop();
      } finally {
        await redis?.stop();
        if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
      }
    }
  });
  return h;
}

/** A fresh app_id per test (≤ 32 chars) so the 60 s (appId, platform) cache never leaks. */
export function freshAppId(): string {
  return `f102e-${randomBytes(8).toString('hex')}`;
}

export interface Row {
  appId: string;
  platform: string;
  channel: string;
  latest_version: string;
  min_supported_version: string | null;
  recommended_version: string | null;
  update_title: string;
  update_notes: string;
  store_url: string;
  default_store: string;
  store_listings: unknown;
}

export function row(appId: string, patch: Partial<Row> = {}): Row {
  return {
    appId,
    platform: 'android',
    channel: 'official',
    latest_version: '3.4.5',
    min_supported_version: '1.2.3',
    recommended_version: '2.3.4',
    update_title: '新版本标题',
    update_notes: '修复若干问题\n第二行说明',
    store_url: 'https://store.example.test/app/couli',
    default_store: 'huawei',
    store_listings: [
      { store: 'huawei', listed_version: '3.4.0' },
      { store: 'xiaomi', listed_version: null },
    ],
    ...patch,
  };
}

/** Writes every column of app_versions; store_listings is stored verbatim as jsonb. */
export async function seed(db: Kysely<DB>, value: Row): Promise<void> {
  await db
    .insertInto('app_versions')
    .values({
      id: randomUUID(),
      app_id: value.appId,
      platform: value.platform,
      channel: value.channel,
      latest_version: value.latest_version,
      min_supported_version: value.min_supported_version,
      recommended_version: value.recommended_version,
      update_title: value.update_title,
      update_notes: value.update_notes,
      store_url: value.store_url,
      default_store: value.default_store,
      store_listings: sql`${JSON.stringify(value.store_listings)}::jsonb`,
      created_at: START,
      updated_at: START,
    })
    .execute();
}

export async function changeLatest(db: Kysely<DB>, value: Row, latest: string): Promise<void> {
  await db
    .updateTable('app_versions')
    .set({ latest_version: latest, row_version: sql`row_version + 1`, updated_at: START })
    .where('app_id', '=', value.appId)
    .where('platform', '=', value.platform)
    .where('channel', '=', value.channel)
    .execute();
}

/**
 * couli_app has only SELECT/INSERT/UPDATE on app_versions (db/migrations/0010), so "the row is
 * gone" is modelled by moving it to another channel of the same app and platform: the original
 * (app, platform, channel) then has no row, while the (app, platform) cache key is unchanged.
 */
export async function moveAway(db: Kysely<DB>, value: Row, channel: string): Promise<void> {
  await db
    .updateTable('app_versions')
    .set({ channel, row_version: sql`row_version + 1`, updated_at: START })
    .where('app_id', '=', value.appId)
    .where('platform', '=', value.platform)
    .where('channel', '=', value.channel)
    .execute();
}

/** Full, valid request headers; a never-registered but well-formed device id (decision 2). */
export function headers(
  appId: string,
  patch: Record<string, string | undefined> = {},
): Record<string, string> {
  const all: Record<string, string | undefined> = {
    'x-app-id': appId,
    'x-platform': 'android',
    'x-app-version': '2.0.0',
    'x-channel': 'official',
    'x-device-id': randomUUID(),
    ...patch,
  };
  return Object.fromEntries(
    Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function check(h: Harness, requestHeaders: Record<string, string>): Promise<Response> {
  return h.app.inject({ method: 'GET', url: PATH, headers: requestHeaders });
}

/** Expected data for a row: every column verbatim, stores as given (no default appended). */
export function expected(value: Row, stores: Check['stores']): Check {
  return {
    latest_version: value.latest_version,
    min_supported_version: value.min_supported_version,
    recommended_version: value.recommended_version,
    update_title: value.update_title,
    update_notes: value.update_notes,
    store_url: value.store_url,
    default_store: value.default_store,
    stores,
  };
}

type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let validators: Promise<Map<string, Validator>> | undefined;
function responseValidators(): Promise<Map<string, Validator>> {
  validators ??= (async () => {
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(
        path: string,
        options: object,
      ): Promise<{
        paths: Record<
          string,
          {
            get: {
              responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
            };
          }
        >;
      }>;
    };
    const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    });
    const compile = createValidatorCompiler();
    const result = new Map<string, Validator>();
    for (const status of ['200', '4XX', '5XX']) {
      result.set(
        status,
        compile({
          schema: doc.paths[PATH]!.get.responses[status]!.content['application/json']!.schema,
          httpPart: 'body',
        }),
      );
    }
    return result;
  })();
  return validators;
}

/** Validates against 200 / 4XX / 5XX of checkAppVersion (AppVersionCheckResponse or ErrorEnvelope). */
export async function validate(response: Response): Promise<void> {
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const verify = (await responseValidators()).get(status)!;
  expect(verify(response.json()), JSON.stringify(verify.errors)).toBe(true);
  expect(verify.errors ?? []).toEqual([]);
}

/** 200, code 0, contract-valid; returns data. */
export async function ok(response: Response): Promise<Check> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response);
  return response.json<{ data: Check }>().data;
}

/** Rejected with the given code (20001 -> 400, 50001 -> 500) and a contract-valid ErrorEnvelope. */
export async function rejected(response: Response, code: 20001 | 50001): Promise<void> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(code === 50001 ? 500 : 400);
  expect(response.json()).toMatchObject({ code });
  expect(response.json()).not.toHaveProperty('data.latest_version');
  await validate(response);
}
