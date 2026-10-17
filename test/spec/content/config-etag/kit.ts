// F1-02h §9: independent copy of the config HTTP fixture.
// No imports from other test kits; database lifecycle stays in *.int.test.ts.
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
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createTokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';

export type Config = Schema<'Config'>;
export type Json = DB['config_items']['value'];
export type Values = Record<string, Json>;
export const PLATFORMS = [
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
] as const;
export const REQUIRED: Values = {
  h5_base_url: 'https://h5.example.test/',
  'h5_release.stable': 'stable-v1',
  kf: { url: 'https://kf.example.test/chat' },
  'legal.privacy.version': 7,
  'legal.privacy.min_version': 3,
  'legal.agreement.version': 5,
};
export const ROOT = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));

export interface Response {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  json<T = unknown>(): T;
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
type Entry = 'api' | 'admin' | 'stream';
type CreateHttpApp = (
  entry: Entry,
  options: {
    config: ReturnType<typeof loadConfig>;
    clock: ReturnType<typeof fixture>['clock'];
    logger: ReturnType<typeof createRootLogger>;
    dbHandles?: DbHandles;
    redisUrl?: ReturnType<typeof loadConnectionConfig>['redisUrl'];
  },
) => Promise<HttpApp>;

export async function harness(db: Kysely<DB>, databaseUrl: string, redisUrl: string) {
  const deps = fixture();
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'f1-02h-'));
  const apps: HttpApp[] = [];
  const logs: string[] = [];
  try {
    // Synthetic, ephemeral fixture keys only; never reads operator credentials.
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
      JWT_KEY_ID: deps.keyring.kid,
      JWT_PRIVATE_KEY_PEM: deps.keyring.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    });
    const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp: CreateHttpApp;
    };
    async function start(entry: Entry, handle: Kysely<DB> | null = db) {
      const app = await createHttpApp(entry, {
        config,
        clock: deps.clock,
        logger: createRootLogger(
          { level: 'trace', entry, appEnv: 'test' },
          { write: (line: string) => void logs.push(line) },
        ),
        ...(handle === null
          ? {}
          : {
              dbHandles: { db: handle, dbRead: null, close: async () => undefined },
              redisUrl: loadConnectionConfig(entry, {
                DATABASE_URL: databaseUrl,
                REDIS_URL: redisUrl,
              }).redisUrl,
            }),
      });
      apps.push(app);
      await app.init();
      return app;
    }
    const app = await start('api');
    return {
      db,
      app,
      start,
      logs,
      deps,
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
      for (const instance of apps.toReversed()) await instance.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
export type Harness = Awaited<ReturnType<typeof harness>>;

export function appId(): string {
  return `f102h_${randomBytes(10).toString('hex')}`;
}
export function headers(id: string): Record<string, string> {
  return { 'x-app-id': id, 'x-platform': 'ios', 'x-app-version': '2.0.0' };
}
export function read(app: HttpApp, id: string, extra: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url: '/v1/config', headers: { ...headers(id), ...extra } });
}
export async function seedConfig(db: Kysely<DB>, id: string, values: Values) {
  for (const [key, value] of Object.entries(values)) {
    await db
      .withSchema('app')
      .insertInto('config_items')
      .values({
        app_id: id,
        key,
        value: sql`${JSON.stringify(value)}::jsonb`,
        version: 1,
        row_version: 1,
        updated_by: 'f1-02h-rule-test',
        created_at: '2026-10-05T04:00:00.000Z',
        updated_at: '2026-10-05T04:00:00.000Z',
      })
      .execute();
  }
}
export async function configured(h: Harness, values: Values = {}) {
  const id = appId();
  await seedConfig(h.db, id, { ...REQUIRED, ...values });
  return id;
}
export async function changeConfig(
  h: Harness,
  id: string,
  key: string,
  value: Json,
  advanceMs = 60_000,
) {
  await h.db
    .withSchema('app')
    .updateTable('config_items')
    .set({
      value: sql`${JSON.stringify(value)}::jsonb`,
      version: sql`version + 1`,
      row_version: sql`row_version + 1`,
      updated_at: h.deps.clock.now(),
    })
    .where('app_id', '=', id)
    .where('key', '=', key)
    .execute();
  // Explicitly follow the existing content-reader policy, not a new ten-second TTL.
  h.deps.clock.advanceMs(advanceMs);
}
export async function registerDevice(h: Harness, id: string) {
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
  return response.json<{ data: { device_id: string } }>().data;
}
export async function session(
  h: Harness,
  id: string,
  device: { device_id: string },
  scope: 'full' | 'deletion_only' = 'full',
  userId: string = randomUUID(),
) {
  const user = await seedUser(h.db, id, userId);
  const issued = await h.db.transaction().execute((trx) =>
    createSession(
      trx,
      {
        uid: user.id,
        app_id: id,
        device_id: device.device_id,
        scp: scope,
      },
      h.deps,
    ),
  );
  return { user, issued, headers: { authorization: `Bearer ${issued.access_token}` } };
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
    const result = new Map<string, Validator>();
    for (const status of ['200', '4XX', '5XX']) {
      result.set(
        status,
        compile({
          schema:
            doc.paths['/v1/config']!.get.responses[status]!.content['application/json']!.schema,
          httpPart: 'body',
        }),
      );
    }
    return result;
  })();
  return validators;
}
export async function validate(response: Response) {
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const check = (await responseValidators()).get(status)!;
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}
export async function success(app: HttpApp, id: string, extra: Record<string, string> = {}) {
  const response = await read(app, id, extra);
  // Check status before dereferencing data: an unimplemented route must fail an assertion,
  // never throw a TypeError that would invalidate the isolated red run.
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: expect.any(Object) });
  await validate(response);
  return response.json<{ data: Config }>().data;
}
export async function failure(response: Response) {
  expect(response.statusCode).toBe(500);
  expect(response.json()).toMatchObject({ code: 50001 });
  await validate(response);
}
export function expectLog(lines: string[], level: 40 | 50, key: string) {
  expect(
    lines.some((line) => {
      const entry = JSON.parse(line) as { level: number };
      return entry.level === level && line.includes(key);
    }),
    `日志 level=${level} 应记录配置键 ${key}`,
  ).toBe(true);
}

// Independent oracle from F1-02c §9.2 #10. Hex conversion avoids sharing the reader's
// byte-decoding implementation; use bigint so the first 64 bits never lose precision.
export function bucket(id: string, subject: string): number {
  const hex = createHash('sha256').update(`${id}:${subject}`, 'utf8').digest('hex');
  return Number(BigInt(`0x${hex.slice(0, 16)}`) % 10_000n);
}

function fixture() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyring = {
    ...pair,
    kid: 'test-p256',
    publicKeys: new Map([['test-p256', pair.publicKey]]),
  };
  const clock = new FixedClock('2026-10-05T04:00:00.000Z');
  const tokens = createTokenService({ clock, keys: keyring });
  return { keyring, clock, tokens };
}

async function seedUser(db: Kysely<DB>, id: string, userId: string) {
  await db
    .withSchema('app')
    .insertInto('users')
    .values({
      id: userId,
      app_id: id,
      nickname: '配置缓存测试用户',
      avatar: 'synthetic-avatar',
      invite_code: randomUUID(),
      attr_code: randomBytes(4).toString('hex'),
      level: 'normal',
      status: 'normal',
      register_method: 'sms',
    })
    .execute();
  return { id: userId };
}

/** Raw text construction sorts integer-looking keys lexicographically, too (§9.2-3). */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value)!;
}

export function versionOf(data: Config): string {
  const { config_version: ignored, ...payload } = data;
  void ignored;
  return createHash('sha256').update(canonical(payload), 'utf8').digest('hex').slice(0, 32);
}

/** Assert before accessing the tag: old implementations fail by assertion, never TypeError. */
export async function snapshot(app: HttpApp, id: string, extra: Record<string, string> = {}) {
  const response = await read(app, id, extra);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: expect.any(Object) });
  await validate(response);
  expect(response.headers['etag']).toEqual(expect.any(String));
  expect(response.headers['etag']).toMatch(/^"[0-9A-Za-z._:-]{1,64}"$/);
  expect(response.headers['etag']).toMatch(/^"[0-9a-f]{32}"$/);
  const etag = response.headers['etag'] as string;
  const data = response.json<{ data: Config }>().data;
  expect(data.config_version).toBe(etag.slice(1, -1));
  expect(data.config_version).toBe(versionOf(data));
  return { response, data, etag };
}

export function notModified(response: Response, etag: string) {
  expect(response.statusCode).toBe(304);
  expect(response.body).toBe('');
  expect(response.headers['content-type']).toBeUndefined();
  expect(response.headers['etag']).toBe(etag);
  expect(response.headers['x-trace-id']).toEqual(expect.any(String));
  expect(response.headers['x-trace-id']).not.toBe('');
}

interface IconApp {
  id: string;
  adminId: string;
}
export async function iconAdmin(h: Harness, id: string): Promise<IconApp> {
  const adminId = randomUUID();
  await h.db
    .withSchema('app')
    .insertInto('admin_users')
    .values({
      id: adminId,
      app_id: id,
      login_name: `f102h-${randomBytes(6).toString('hex')}`,
      password_hash: 'synthetic-not-a-real-hash',
      is_super: true,
      status: 'active',
      password_must_change: false,
      created_at: h.deps.clock.now(),
      updated_at: h.deps.clock.now(),
    })
    .execute();
  return { id, adminId };
}
export interface SavedVersion {
  version: number;
  sha256: string;
  format: 'svg' | 'png';
}

/** A saved version (upload first for the FK). Saving alone is a draft: it publishes nothing. */
export async function saveVersion(
  h: Harness,
  a: IconApp,
  key: string,
  version: number,
  format: 'svg' | 'png' = 'svg',
): Promise<SavedVersion> {
  const uploadId = randomUUID();
  const sha256 = createHash('sha256').update(`${a.id}:${key}:${version}:${format}`).digest('hex');
  const app = h.db.withSchema('app');
  await app
    .insertInto('platform_icon_uploads')
    .values({
      id: uploadId,
      app_id: a.id,
      key,
      sha256,
      format,
      bytes: 1234,
      sanitized: true,
      created_by_admin_id: a.adminId,
      created_at: '2026-10-02T03:04:05.000Z',
      expires_at: '2026-10-08T00:00:00.000Z',
    })
    .execute();
  await app
    .insertInto('platform_icon_versions')
    .values({
      app_id: a.id,
      key,
      version,
      upload_id: uploadId,
      sha256,
      format,
      bytes: 1234,
      sanitized: true,
      source_url: 'https://brand.example.test/assets',
      downloaded_on: '2026-10-01',
      ever_published: false,
      revision: 1,
      created_by: 'saved-username',
      created_by_admin_id: a.adminId,
      created_at: '2026-10-02T03:04:05.000Z',
    })
    .execute();
  return { version, sha256, format };
}

/**
 * Point the mark at `version` (publish / rollback) or at null (「恢复内置」, or a mark that only
 * has drafts). Direct row writes stand in for the admin entry, another process; the reader
 * clock is never advanced by this helper.
 */
export async function setCurrent(h: Harness, a: IconApp, key: string, version: number | null) {
  const app = h.db.withSchema('app');
  const existing = await app
    .selectFrom('platform_icons')
    .select('revision')
    .where('app_id', '=', a.id)
    .where('key', '=', key)
    .executeTakeFirst();
  if (existing === undefined) {
    await app
      .insertInto('platform_icons')
      .values({
        app_id: a.id,
        key,
        current_version: version,
        revision: 1,
        updated_by: 'f1-02h-rule-test',
        updated_by_admin_id: a.adminId,
        updated_at: '2026-10-05T04:00:00.000Z',
      })
      .execute();
    return;
  }
  await app
    .updateTable('platform_icons')
    .set({ current_version: version, revision: existing.revision + 1 })
    .where('app_id', '=', a.id)
    .where('key', '=', key)
    .execute();
  if (version !== null) {
    await app
      .updateTable('platform_icon_versions')
      .set({ ever_published: true })
      .where('app_id', '=', a.id)
      .where('key', '=', key)
      .where('version', '=', version)
      .execute();
  }
}
