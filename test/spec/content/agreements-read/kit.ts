// F1-02n: independent fixtures; no imports from other tasks' frozen rule tests.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { AgreementType } from '../../../../apps/api/src/modules/content/index.ts';
import { createTokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const NOW = '2031-03-04T05:06:07.000Z';
export const PATH = '/v1/agreements';
export const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
export type PublicAgreement = Schema<'PublicAgreement'>;
export type AgreementData = Schema<'AgreementsData'>;

export interface Response {
  statusCode: number;
  json<T = { code: number; data?: unknown }>(): T;
}
export interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
  getHttpAdapter(): {
    getInstance(): { hasRoute(input: { method: 'GET'; url: string }): boolean };
  };
}
export type CreateHttpApp = (
  entry: 'api',
  options: {
    config: ReturnType<typeof loadConfig>;
    clock: FixedClock;
    logger: ReturnType<typeof createRootLogger>;
    dbHandles?: DbHandles;
    redisUrl?: ReturnType<typeof loadConnectionConfig>['redisUrl'];
  },
) => Promise<HttpApp>;

// Only *.int.test.ts imports @couli/db/testing and passes its entry here.
interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<unknown>;
}
interface TestRedis {
  readonly url: string;
  stop(): Promise<unknown>;
}
interface TestingEntry {
  createTestDatabase(): Promise<TestDatabase>;
  acquireTestRedis(): Promise<TestRedis>;
}

export function useHarness(name: string, load: () => Promise<TestingEntry>) {
  let database: TestDatabase | undefined;
  let redis: TestRedis | undefined;
  let db: Kysely<DB> | undefined;
  let app: HttpApp | undefined;
  let directory: string | undefined;
  const clock = new FixedClock(NOW);
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const kid = 'f1-02n-test';
  const tokens = createTokenService({
    clock,
    keys: { ...pair, kid, publicKeys: new Map([[kid, pair.publicKey]]) },
  });

  beforeAll(async () => {
    const testing = await load();
    database = await testing.createTestDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
    redis = await testing.acquireTestRedis();
    const base = fileURLToPath(new URL('.tmp/f1-02n/', ROOT));
    mkdirSync(base, { recursive: true });
    directory = mkdtempSync(join(base, `${name}-`));
    // Generated synthetic fixture keys only; no operator credential files are accessed.
    const master = randomBytes(32);
    const wrapped = await createWrappedKeyring(new LocalKeyProvider(master));
    const masterFile = join(directory, 'synthetic-master.hex');
    const keyringFile = join(directory, 'synthetic-keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(wrapped), { mode: 0o600 });
    const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp: CreateHttpApp;
    };
    app = await createHttpApp('api', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: masterFile,
        FIELD_KEYRING_FILE: keyringFile,
        JWT_KEY_ID: kid,
        JWT_PRIVATE_KEY_PEM: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock,
      logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
      dbHandles: { db, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('api', {
        DATABASE_URL: database.urlFor('couli_app'),
        REDIS_URL: redis.url,
      }).redisUrl,
    });
    await app.init();
  }, 180_000);

  beforeEach(() => clock.set(NOW));
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      try {
        if (db !== undefined) await destroyDb(db);
        await database?.drop();
      } finally {
        await redis?.stop();
        if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  return {
    get db() {
      return db!;
    },
    get app() {
      return app!;
    },
    clock,
    async restrictedHeaders(appId: string) {
      const registered = await app!.inject({
        method: 'POST',
        url: '/v1/devices',
        headers: { ...headers(appId), 'content-type': 'application/json' },
        payload: JSON.stringify({ device_hash: '0'.repeat(64), id_source: 'idfv' }),
      });
      expect(registered.statusCode).toBe(200);
      const device = registered.json<{ data: { device_id: string } }>().data;
      const uid = newId();
      await db!
        .withSchema('app')
        .insertInto('users')
        .values({
          id: uid,
          app_id: appId,
          nickname: '协议测试用户',
          avatar: 'synthetic-avatar',
          invite_code: uid,
          attr_code: uid,
          level: 'normal',
          status: 'normal',
          register_method: 'sms',
        })
        .execute();
      const issued = await db!
        .transaction()
        .execute((trx) =>
          createSession(
            trx,
            { uid, app_id: appId, device_id: device.device_id, scp: 'deletion_only' },
            { clock, tokens },
          ),
        );
      return { authorization: `Bearer ${issued.access_token}`, 'x-device-id': device.device_id };
    },
  };
}

let sequence = 0;
export function newId(): string {
  sequence += 1;
  return `0199f102-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
}
export function newAppId(): string {
  sequence += 1;
  return `f102n_${process.pid.toString(36)}_${sequence}`;
}
export function headers(appId: string): Record<string, string> {
  return { 'x-app-id': appId, 'x-platform': 'ios', 'x-app-version': '2.0.0' };
}
export function read(app: HttpApp, appId: string, extra: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url: PATH, headers: { ...headers(appId), ...extra } });
}

export async function seedAgreement(
  db: Kysely<DB>,
  appId: string,
  type: AgreementType,
  version: number,
  patch: { minVersion?: number; publishedAt?: string; articleVersion?: number } = {},
) {
  const actor = newId();
  const articleId = newId();
  const articleVersion = patch.articleVersion ?? version + 10;
  const minVersion = patch.minVersion ?? 1;
  const publishedAt = patch.publishedAt ?? '2031-03-01T01:02:03.456Z';
  // Deliberately differs from the URL builder and from the article version.
  const url = `https://published.example.test/${appId}/${type}/v${version}.html?source=saved`;
  const textSha256 = (version % 16).toString(16).repeat(64);
  await db
    .withSchema('app')
    .insertInto('admin_users')
    .values({
      id: actor,
      app_id: appId,
      login_name: actor,
      password_hash: 'synthetic-unused',
      is_super: true,
      status: 'active',
    })
    .execute();
  await db
    .withSchema('app')
    .insertInto('articles')
    .values({
      id: articleId,
      app_id: appId,
      category: 'agreement',
      title: `${type} v${version}`,
      body: `协议正文 ${version}`,
      version: articleVersion,
      status: 'published',
      published_at: publishedAt,
      notice_closable: false,
      notice_content_version: 1,
    })
    .execute();
  await db
    .withSchema('app')
    .insertInto('agreements')
    .values({
      id: newId(),
      app_id: appId,
      type,
      version,
      min_version: minVersion,
      requires_resign: type === 'labor_agreement' && minVersion === version,
      article_id: articleId,
      article_version: articleVersion,
      text_sha256: textSha256,
      url,
      legal_confirmed_by: 'test-legal',
      legal_confirm_note: '测试确认',
      published_at: publishedAt,
      published_by: actor,
    })
    .execute();
  return {
    type,
    version,
    min_version: minVersion,
    article_id: articleId,
    article_version: articleVersion,
    text_sha256: textSha256,
    url,
    published_at: publishedAt,
  };
}

type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let validators: Promise<Map<string, Validator>> | undefined;
async function responseValidators() {
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
              responses: Record<
                string,
                {
                  content: Record<string, { schema: JsonSchema }>;
                }
              >;
            };
          }
        >;
      }>;
    };
    const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    });
    const compile = createValidatorCompiler();
    return new Map(
      ['200', '4XX', '5XX'].map((status) => [
        status,
        compile({
          schema: doc.paths[PATH]!.get.responses[status]!.content['application/json']!.schema,
          httpPart: 'body',
        }),
      ]),
    );
  })();
  return validators;
}
export async function validate(response: Response) {
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const check = (await responseValidators()).get(status)!;
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}
export async function success(app: HttpApp, appId: string): Promise<AgreementData> {
  const response = await read(app, appId);
  expect(response.statusCode).toBe(200);
  expect(response.json().code).toBe(0);
  await validate(response);
  const data = response.json<{ data: AgreementData }>().data;
  // Date-time spelling is not contractual; compare the instant, preserving every other field.
  for (const row of [data.privacy, data.agreement]) {
    if (row !== null) row.published_at = new Date(row.published_at).toISOString();
  }
  return data;
}
