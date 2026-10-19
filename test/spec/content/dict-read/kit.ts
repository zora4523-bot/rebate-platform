// Independent F1-02s fixture: real api bootstrap, direct SQL fixture writes, no frozen-test imports.
// The *.int.test.ts owns database/Redis provisioning; this module never imports db/testing.
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  createRootLogger,
  FixedClock,
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

const ROOT = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
export const NOW = '2031-03-04T05:06:07.000Z';
export const PATH = '/v1/dict';
export type Dict = Schema<'Dict'>;
type Json = DB['config_items']['value'];

export interface Response {
  statusCode: number;
  json<T = { code: number; data?: unknown }>(): T;
}
export interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<Response>;
  getHttpAdapter(): {
    getInstance(): { hasRoute(input: { method: 'GET'; url: string }): boolean };
  };
}

export async function harness(db: Kysely<DB>, databaseUrl: string, redisUrl: string) {
  const clock = new FixedClock(NOW);
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'f1-02s-'));
  const apps: HttpApp[] = [];
  const logs: string[] = [];
  try {
    // Ephemeral synthetic fixture keys only; no operator credentials are read.
    const master = randomBytes(32);
    const wrapped = await createWrappedKeyring(new LocalKeyProvider(master));
    const masterFile = join(directory, 'synthetic-master.hex');
    const keyringFile = join(directory, 'synthetic-keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(wrapped), { mode: 0o600 });
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const kid = 'f1-02s-p256';
    const config = loadConfig({
      APP_ENV: 'test',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: masterFile,
      FIELD_KEYRING_FILE: keyringFile,
      JWT_KEY_ID: kid,
      JWT_PRIVATE_KEY_PEM: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp(
        entry: 'api',
        options: {
          config: ReturnType<typeof loadConfig>;
          clock: FixedClock;
          logger: ReturnType<typeof createRootLogger>;
          dbHandles?: DbHandles;
          redisUrl?: ReturnType<typeof loadConnectionConfig>['redisUrl'];
        },
      ): Promise<HttpApp>;
    };
    async function start(handle: Kysely<DB> | null = db): Promise<HttpApp> {
      const app = await createHttpApp('api', {
        config,
        clock,
        logger: createRootLogger(
          { level: 'trace', entry: 'api', appEnv: 'test' },
          { write: (line: string) => void logs.push(line) },
        ),
        ...(handle === null
          ? {}
          : {
              dbHandles: { db: handle, dbRead: null, close: async () => undefined },
              redisUrl: loadConnectionConfig('api', {
                DATABASE_URL: databaseUrl,
                REDIS_URL: redisUrl,
              }).redisUrl,
            }),
      });
      apps.push(app);
      await app.init();
      return app;
    }
    const app = await start();
    return {
      db,
      clock,
      app,
      logs,
      start,
      restrictedToken(appId: string): string {
        const iat = Math.floor(clock.now().getTime() / 1000);
        // Valid ES256 deletion_only access-token claims; no session is seeded deliberately:
        // x-auth none must not look up this token's session (nor require its device header).
        const input = [
          { alg: 'ES256', typ: 'JWT', kid },
          {
            uid: '0199f102-0000-7000-8000-000000000001',
            app_id: appId,
            sid: 'f102s_no_session',
            device_id: '0199f102-0000-7000-8000-000000000002',
            scp: 'deletion_only',
            iss: 'couli-api',
            aud: 'app',
            iat,
            exp: iat + 7200,
          },
        ]
          .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
          .join('.');
        return `${input}.${sign('sha256', Buffer.from(input), {
          key: pair.privateKey,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url')}`;
      },
      async close() {
        try {
          for (const instance of apps.toReversed()) await instance.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      for (const app of apps.toReversed()) await app.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
export type Harness = Awaited<ReturnType<typeof harness>>;

let sequence = 0;
export function appId(): string {
  sequence += 1;
  return `f102s_${process.pid.toString(36)}_${sequence}`;
}

export async function configValue(db: Kysely<DB>, id: string, key: string, value: Json) {
  await db
    .withSchema('app')
    .insertInto('config_items')
    .values({
      app_id: id,
      key,
      value: sql`${JSON.stringify(value)}::jsonb`,
      version: 1,
      row_version: 0,
      updated_by: 'f1-02s-test',
      created_at: NOW,
      updated_at: NOW,
    })
    .onConflict((conflict) =>
      conflict.columns(['app_id', 'key']).doUpdateSet({
        value: sql`${JSON.stringify(value)}::jsonb`,
        version: sql`config_items.version + 1`,
        row_version: sql`config_items.row_version + 1`,
      }),
    )
    .execute();
}

export async function configRequired(db: Kysely<DB>, id: string) {
  const values: Record<string, Json> = {
    h5_base_url: 'https://h5.example.test/',
    'h5_release.stable': 'stable-v1',
    kf: { url: 'https://kf.example.test/chat' },
    'legal.privacy.version': 7,
    'legal.privacy.min_version': 3,
    'legal.agreement.version': 5,
  };
  for (const [key, value] of Object.entries(values)) await configValue(db, id, key, value);
}

export interface Row {
  dict: string;
  code: string;
  version: number;
  text: string | null;
}
/** Explicit dict/code fields are the oracle; never split fixture keys using production code. */
export async function seedRows(db: Kysely<DB>, id: string, rows: readonly Row[]) {
  const adminId = randomUUID();
  await db
    .withSchema('app')
    .insertInto('admin_users')
    .values({
      id: adminId,
      app_id: id,
      login_name: `fixture_${adminId}`,
      password_hash: 'unused-fixture',
      is_super: true,
      status: 'active',
      row_version: 0,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
  await db
    .withSchema('app')
    .insertInto('dict_items')
    .values(
      rows.map((row) => ({
        ...row,
        app_id: id,
        created_by: adminId,
        created_at: NOW,
      })),
    )
    .execute();
}

export function read(app: HttpApp, id: string, url = PATH, extra: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url,
    headers: { 'x-app-id': id, 'x-platform': 'ios', 'x-app-version': '2.0.0', ...extra },
  });
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
    for (const path of [PATH, '/v1/config']) {
      for (const status of ['200', '4XX', '5XX']) {
        result.set(
          `${path}:${status}`,
          compile({
            schema: doc.paths[path]!.get.responses[status]!.content['application/json']!.schema,
            httpPart: 'body',
          }),
        );
      }
    }
    return result;
  })();
  return validators;
}
export async function validate(response: Response, path = PATH) {
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const check = (await responseValidators()).get(`${path}:${status}`)!;
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}
export async function success(response: Response): Promise<Dict> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response);
  return response.json<Schema<'DictResponse'>>().data;
}
