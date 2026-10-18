// F1-02j: independent HTTP fixture; no imports from frozen rule-test kits.
// Database/Redis lifecycle belongs to delivery.int.test.ts, never this helper.
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { createTokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';

export type Config = Schema<'Config'>;
export type Json = DB['config_items']['value'];
export type Values = Record<string, Json>;
const ROOT = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
const REQUIRED: Values = {
  h5_base_url: 'https://h5.example.test/',
  'h5_release.stable': 'stable-v1',
  kf: { url: 'https://kf.example.test/chat' },
  'legal.privacy.version': 7,
  'legal.privacy.min_version': 3,
  'legal.agreement.version': 5,
};

interface Response {
  statusCode: number;
  json<T = unknown>(): T;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
}
type CreateHttpApp = (
  entry: 'api',
  options: {
    config: ReturnType<typeof loadConfig>;
    clock: FixedClock;
    logger: ReturnType<typeof createRootLogger>;
    dbHandles: DbHandles;
    redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
  },
) => Promise<HttpApp>;

export async function harness(db: Kysely<DB>, databaseUrl: string, redisUrl: string) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyring = {
    ...pair,
    kid: 'test-p256',
    publicKeys: new Map([['test-p256', pair.publicKey]]),
  };
  const clock = new FixedClock('2026-10-05T04:00:00.000Z');
  const deps = { clock, tokens: createTokenService({ clock, keys: keyring }) };
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'f1-02j-'));
  const logs: string[] = [];
  let app: HttpApp | undefined;
  try {
    // Only synthetic, ephemeral test keys, created when the orchestrator runs the container.
    const master = randomBytes(32);
    const wrapped = await createWrappedKeyring(new LocalKeyProvider(master));
    const masterFile = join(directory, 'synthetic-master.hex');
    const keyringFile = join(directory, 'synthetic-keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(wrapped), { mode: 0o600 });
    const config = loadConfig({
      APP_ENV: 'test',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: masterFile,
      FIELD_KEYRING_FILE: keyringFile,
      JWT_KEY_ID: keyring.kid,
      JWT_PRIVATE_KEY_PEM: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    // Nest decorators must be loaded through the existing dynamic bootstrap convention.
    const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp: CreateHttpApp;
    };
    app = await createHttpApp('api', {
      config,
      clock,
      logger: createRootLogger(
        { level: 'trace', entry: 'api', appEnv: 'test' },
        { write: (line: string) => void logs.push(line) },
      ),
      dbHandles: { db, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('api', {
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
      }).redisUrl,
    });
    await app.init();
    const started = app;
    return {
      db,
      app: started,
      logs,
      deps,
      async close() {
        try {
          await started.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await app?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
export type Harness = Awaited<ReturnType<typeof harness>>;

export async function configured(h: Harness, values: Values = {}) {
  const id = `f102j_${randomBytes(10).toString('hex')}`;
  for (const [key, value] of Object.entries({ ...REQUIRED, ...values })) {
    await h.db
      .withSchema('app')
      .insertInto('config_items')
      .values({
        app_id: id,
        key,
        value: sql`${JSON.stringify(value)}::jsonb`,
        version: 1,
        row_version: 1,
        updated_by: 'f1-02j-rule-test',
        created_at: h.deps.clock.now(),
        updated_at: h.deps.clock.now(),
      })
      .execute();
  }
  return id;
}

function headers(id: string): Record<string, string> {
  return {
    'x-app-id': id,
    'x-platform': 'ios',
    'x-app-version': '2.0.0',
    'x-device-id': '019a0000-0000-7000-8000-000000000001',
  };
}

export async function login(h: Harness, id: string) {
  const response = await h.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: { ...headers(id), 'content-type': 'application/json' },
    payload: JSON.stringify({
      device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      id_source: 'idfv',
    }),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: { device_id: expect.any(String) } });
  const deviceId = response.json<{ data: { device_id: string } }>().data.device_id;
  const userId = randomUUID();
  await h.db
    .withSchema('app')
    .insertInto('users')
    .values({
      id: userId,
      app_id: id,
      nickname: '剪贴板配置测试用户',
      avatar: 'synthetic-avatar',
      invite_code: randomUUID(),
      attr_code: randomBytes(4).toString('hex'),
      level: 'normal',
      status: 'normal',
      register_method: 'sms',
    })
    .execute();
  const issued = await h.db
    .transaction()
    .execute((trx) =>
      createSession(trx, { uid: userId, app_id: id, device_id: deviceId, scp: 'full' }, h.deps),
    );
  return { authorization: `Bearer ${issued.access_token}`, 'x-device-id': deviceId };
}

type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let responseValidator: Promise<Validator> | undefined;
function validator() {
  responseValidator ??= (async () => {
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(
        path: string,
        options: object,
      ): Promise<{
        paths: Record<
          string,
          {
            get: { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> };
          }
        >;
      }>;
    };
    const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    });
    return createValidatorCompiler()({
      schema: doc.paths['/v1/config']!.get.responses['200']!.content['application/json']!.schema,
      httpPart: 'body',
    });
  })();
  return responseValidator;
}

export async function success(h: Harness, id: string, extra: Record<string, string> = {}) {
  const response = await h.app.inject({
    method: 'GET',
    url: '/v1/config',
    headers: { ...headers(id), ...extra },
  });
  // Assert before dereferencing: a missing route/response must not produce a TypeError.
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: expect.any(Object) });
  const check = await validator();
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
  return response.json<{ data: Config }>().data;
}

export function warnings(h: Harness, start: number, id: string, key: string) {
  return h.logs
    .slice(start)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (entry) =>
        entry['level'] === 40 &&
        entry['event'] === 'content_config_value_invalid' &&
        entry['app_id'] === id &&
        entry['config_key'] === key,
    );
}
