// F1-02d §9: observe GET /v1/config.platform_icons only through HTTP, real config_items rows and
// real platform_icons / platform_icon_versions rows (db/schema.sql, migration 0028 grants).
// No content imports. Self-contained: minimal copies of the F1-02c config fixture, the identity
// session fixture and the F1-06w platform-icon row fixture; no other test kit is imported.
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
export type Key = Schema<'PlatformIconKey'>;
export type Delivered = Schema<'ConfigPlatformIcon'>;
export type Json = DB['config_items']['value'];
export type Values = Record<string, Json>;

// F1-02c §9.2 #3: keys without which /v1/config answers 50001; seeded so the suite can turn
// green once F1-02c is merged.
export const REQUIRED: Values = {
  h5_base_url: 'https://h5.example.test/',
  'h5_release.stable': 'stable-v1',
  kf: { url: 'https://kf.example.test/chat' },
  'legal.privacy.version': 7,
  'legal.privacy.min_version': 3,
  'legal.agreement.version': 5,
};
// Trailing slashes on purpose: the delivered url drops them (platform mediaUrlOf contract).
export const BASE = 'https://icons.example.invalid/media///';
export const INSTANT = '2026-10-05T04:00:00.000Z';
const SAVED = '2026-10-02T03:04:05.000Z';
export const ROOT = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));

/** Independent oracle of the delivered url: `<base without trailing slashes>/<sha256>.<format>`. */
export function expectedUrl(sha256: string, format: 'svg' | 'png'): string {
  return `https://icons.example.invalid/media/${sha256}.${format}`;
}

export interface Response {
  statusCode: number;
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
}
type AppConfig = ReturnType<typeof loadConfig>;
type CreateHttpApp = (
  entry: 'api',
  options: {
    config: AppConfig;
    clock: FixedClock;
    logger: ReturnType<typeof createRootLogger>;
    dbHandles?: DbHandles;
    redisUrl?: ReturnType<typeof loadConnectionConfig>['redisUrl'];
  },
) => Promise<HttpApp>;

function deps() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyring = {
    ...pair,
    kid: 'test-p256',
    publicKeys: new Map([['test-p256', pair.publicKey]]),
  };
  const clock = new FixedClock(INSTANT);
  const tokens = createTokenService({ clock, keys: keyring });
  return { keyring, clock, tokens };
}

export async function harness(db: Kysely<DB>, databaseUrl: string, redisUrl: string) {
  const fixture = deps();
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'f1-02d-'));
  const apps: HttpApp[] = [];
  const logs: string[] = [];
  const cleanup = async () => {
    try {
      for (const instance of apps.toReversed()) await instance.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
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
      JWT_KEY_ID: fixture.keyring.kid,
      JWT_PRIVATE_KEY_PEM: fixture.keyring.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
      MEDIA_PUBLIC_BASE_URL: BASE,
    });
    expect(config.mediaPublicBaseUrl).toBe(BASE);
    const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp: CreateHttpApp;
    };
    async function start(media: 'configured' | 'unset') {
      // AppConfig: "A hand-built config without it counts as unset" (staging / prod without the
      // variable); APP_ENV=test would otherwise fill in the local default base.
      const effective: AppConfig =
        media === 'configured' ? config : { ...config, mediaPublicBaseUrl: undefined };
      const app = await createHttpApp('api', {
        config: effective,
        clock: fixture.clock,
        logger: createRootLogger(
          { level: 'trace', entry: 'api', appEnv: 'test' },
          { write: (line: string) => void logs.push(line) },
        ),
        dbHandles: { db, dbRead: null, close: async () => undefined },
        redisUrl: loadConnectionConfig('api', { DATABASE_URL: databaseUrl, REDIS_URL: redisUrl })
          .redisUrl,
      });
      apps.push(app);
      await app.init();
      return app;
    }
    const app = await start('configured');
    return { db, app, start, logs, deps: fixture, close: cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
export type Harness = Awaited<ReturnType<typeof harness>>;

export function appId(): string {
  return `f102d_${randomBytes(10).toString('hex')}`;
}
export function headers(id: string): Record<string, string> {
  return { 'x-app-id': id, 'x-platform': 'ios', 'x-app-version': '2.0.0' };
}
export function read(app: HttpApp, id: string, extra: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url: '/v1/config', headers: { ...headers(id), ...extra } });
}

/** A fresh app_id with every F1-02c required key and one synthetic admin (icon rows' FK). */
export async function configured(h: Harness) {
  const id = appId();
  for (const [key, value] of Object.entries(REQUIRED)) {
    await h.db
      .withSchema('app')
      .insertInto('config_items')
      .values({
        app_id: id,
        key,
        value: sql`${JSON.stringify(value)}::jsonb`,
        version: 1,
        row_version: 1,
        updated_by: 'f1-02d-rule-test',
        created_at: INSTANT,
        updated_at: INSTANT,
      })
      .execute();
  }
  const adminId = randomUUID();
  await h.db
    .withSchema('app')
    .insertInto('admin_users')
    .values({
      id: adminId,
      app_id: id,
      login_name: `f102d-${randomBytes(6).toString('hex')}`,
      password_hash: 'synthetic-not-a-real-hash',
      is_super: true,
      status: 'active',
      password_must_change: false,
      created_at: INSTANT,
      updated_at: INSTANT,
    })
    .execute();
  return { id, adminId };
}
export type App = Awaited<ReturnType<typeof configured>>;

export interface SavedVersion {
  version: number;
  sha256: string;
  format: 'svg' | 'png';
}

/** A saved version (upload first for the FK). Saving alone is a draft: it publishes nothing. */
export async function saveVersion(
  h: Harness,
  a: App,
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
      created_at: SAVED,
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
      created_at: SAVED,
    })
    .execute();
  return { version, sha256, format };
}

/**
 * Point the mark at `version` (publish / rollback) or at null (「恢复内置」, or a mark that only
 * has drafts). Direct row writes stand in for the admin entry, another process; the reader
 * clock is never advanced by this helper.
 */
export async function setCurrent(h: Harness, a: App, key: string, version: number | null) {
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
        updated_by: 'f1-02d-rule-test',
        updated_by_admin_id: a.adminId,
        updated_at: INSTANT,
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

/** The exact delivered value for a saved version, derived independently of the reader. */
export function delivered(saved: SavedVersion): Delivered {
  return {
    url: expectedUrl(saved.sha256, saved.format),
    sha256: saved.sha256,
    version: saved.version,
  };
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

/** Synthetic signed-in session (full or deletion_only) for an app's own user. */
export async function session(h: Harness, id: string, scope: 'full' | 'deletion_only') {
  const device = await registerDevice(h, id);
  const userId = randomUUID();
  await h.db
    .withSchema('app')
    .insertInto('users')
    .values({
      id: userId,
      app_id: id,
      nickname: '平台标识下发测试用户',
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
      createSession(
        trx,
        { uid: userId, app_id: id, device_id: device.device_id, scp: scope },
        h.deps,
      ),
    );
  return { authorization: `Bearer ${issued.access_token}` };
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

/** 200 + ConfigResponse contract; checks status first so a missing route fails an assertion. */
export async function config(app: HttpApp, id: string, extra: Record<string, string> = {}) {
  const response = await read(app, id, extra);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: expect.any(Object) });
  await validate(response);
  return response.json<{ data: Config }>().data;
}

/** The platform_icons object, which §9.2 #1 says is always present when the base is configured. */
export async function icons(app: HttpApp, id: string, extra: Record<string, string> = {}) {
  const data = await config(app, id, extra);
  expect(Object.hasOwn(data, 'platform_icons'), '响应应总带 platform_icons 键').toBe(true);
  return data.platform_icons;
}

export function warned(lines: string[], id: string): boolean {
  return lines.some((line) => {
    const entry = JSON.parse(line) as { level: number };
    return entry.level === 40 && line.includes(id);
  });
}
