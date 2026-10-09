// B1-02c: HTTP/DB helpers only; expected business results stay in the rule tests.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type {
  DbHandles,
  loadConnectionConfig,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

const ROOT = new URL('../../../../', import.meta.url);
type IdSource = 'idfv' | 'android_id' | 'oaid' | 'odid';
export interface HashCase {
  device_hash: string;
  id_source: IdSource;
  note: string;
}
export const vectors = JSON.parse(
  readFileSync(new URL('specs/device-hash.vectors.json', ROOT), 'utf8'),
) as {
  hash_cases: HashCase[];
  invalid_hash_seeds: { device_hash: string; note: string }[];
};

export function validCase(): HashCase {
  expect(vectors.hash_cases.length, '前置条件：有效哈希向量非空').toBeGreaterThan(0);
  return vectors.hash_cases[0]!;
}

export function headers(source: IdSource = 'idfv', appId = 'couli', appVersion = '1.2.3') {
  return {
    'x-app-id': appId,
    'x-platform': source === 'idfv' ? 'ios' : source === 'odid' ? 'harmony' : 'android',
    'x-app-version': appVersion,
  };
}

export interface Response {
  statusCode: number;
  json<T>(): T;
}
export interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(request: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload: Record<string, unknown>;
  }): Promise<Response>;
}

// Computed import, as in masking's HTTP tests: Nest decorators use the api tsconfig.
const BOOTSTRAP = new URL('apps/api/src/bootstrap.ts', ROOT).href;
type CreateHttpApp = (
  entry: 'api',
  overrides: {
    config: ReturnType<typeof loadConfig>;
    logger: RootLogger;
    clock: FixedClock;
    dbHandles: DbHandles;
    redisUrl?: RedisUrl;
  },
) => Promise<HttpApp>;
type RedisUrl = ReturnType<typeof loadConnectionConfig>['redisUrl'];

export function makeDir(): string {
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, 'spec-b1-02c-devices-'));
}

// B1-02q: from B1-03f on, device registration reserves a per-IP slot in Redis and an entry
// without Redis refuses it (42901), so callers that register devices pass a one-shot Redis.
export async function buildApp(
  db: Kysely<DB>,
  dir: string,
  lines: string[],
  redisUrl?: RedisUrl,
): Promise<HttpApp> {
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  const masterFile = join(dir, 'master.hex');
  const keyringFile = join(dir, 'keyring.json');
  writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
  writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 });
  const { createHttpApp } = (await import(BOOTSTRAP)) as { createHttpApp: CreateHttpApp };
  return createHttpApp('api', {
    config: loadConfig({
      APP_ENV: 'test',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: masterFile,
      FIELD_KEYRING_FILE: keyringFile,
    }),
    clock: new FixedClock('2026-10-05T04:00:00.000Z'),
    logger: createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      { write: (chunk: string) => void lines.push(chunk) },
    ),
    // The test owns the connection and closes it after the application shuts down.
    dbHandles: { db, dbRead: null, close: async () => undefined },
    ...(redisUrl === undefined ? {} : { redisUrl }),
  });
}

export function register(
  app: HttpApp,
  payload: Record<string, unknown>,
  requestHeaders = headers(),
): Promise<Response> {
  return app.inject({ method: 'POST', url: '/v1/devices', headers: requestHeaders, payload });
}

// Resolve the API's existing parser dependency without adding dependencies to the test package.
export async function responseValidator() {
  const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{
      paths: Record<
        string,
        {
          post?: {
            operationId?: string;
            responses?: Record<
              string,
              {
                content?: Record<string, { schema?: JsonSchema }>;
              }
            >;
          };
        }
      >;
    }>;
  };
  const document = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)));
  const operation = document.paths['/v1/devices']?.post;
  expect(operation?.operationId, '前置条件：registerDevice 契约存在').toBe('registerDevice');
  const schema = operation?.responses?.['200']?.content?.['application/json']?.schema;
  expect(schema, '前置条件：200 响应 schema 存在').toBeDefined();
  const errorSchema = operation?.responses?.['4XX']?.content?.['application/json']?.schema;
  expect(errorSchema, '前置条件：4XX 错误响应 schema 存在').toBeDefined();
  const compile = createValidatorCompiler();
  return {
    validate: compile({ schema: schema!, httpPart: 'body' }),
    validateError: compile({ schema: errorSchema!, httpPart: 'body' }),
  };
}

export interface DeviceRow {
  id: string;
  app_id: string;
  user_id: string | null;
  device_hash: string;
  id_source: string;
  platform: string;
  app_version: string;
  revoked_at: Date | null;
  install_secret_cipher: Buffer;
  [column: string]: unknown;
}

async function assertTable(db: Kysely<DB>): Promise<void> {
  const result = await sql<{ present: boolean }>`
    SELECT to_regclass('app.devices') IS NOT NULL AS present
  `.execute(db);
  expect(result.rows[0]?.present, '前置条件：B1-02a 已创建 app.devices').toBe(true);
}

export async function countDevices(db: Kysely<DB>): Promise<number> {
  await assertTable(db);
  const result = await sql<{ n: string }>`SELECT count(*)::text AS n FROM app.devices`.execute(db);
  return Number(result.rows[0]!.n);
}

export async function deviceRows(db: Kysely<DB>, hash: string): Promise<DeviceRow[]> {
  await assertTable(db);
  const columns = await sql<{ column_name: string; udt_name: string; is_nullable: string }>`
    SELECT column_name, udt_name, is_nullable FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'devices'
  `.execute(db);
  expect(columns.rows, '前置条件：B1-02b 已迁移为非空 bytea 密文列').toContainEqual({
    column_name: 'install_secret_cipher',
    udt_name: 'bytea',
    is_nullable: 'NO',
  });
  expect(columns.rows.map((column) => column.column_name)).not.toContain('install_secret_hash');
  return (await sql<DeviceRow>`SELECT * FROM app.devices WHERE device_hash = ${hash}`.execute(db))
    .rows;
}
