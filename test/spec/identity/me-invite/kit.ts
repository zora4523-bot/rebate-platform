// B1-11k: real AppModule, PG and Redis. No replacement of invitation, age or risk logic.
// Test resources are supplied by the *.int.test.ts entry; this kit never imports db/testing.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb } from '@couli/db';
import { sql } from 'kysely';
import { expect } from 'vitest';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
}
interface TestRedis {
  url: string;
}
type Platform = typeof import('../../../../apps/api/src/modules/platform/index.ts');
type Crypto = typeof import('../../../../apps/api/src/modules/platform/crypto/index.ts');
type Validation = typeof import('../../../../apps/api/src/modules/platform/validation/index.ts');
type Sessions = typeof import('../../../../apps/api/src/modules/identity/application/sessions.ts');
type Tokens = typeof import('../../../../apps/api/src/modules/identity/application/tokens.ts');
type Me = components['schemas']['Me'];
interface Response {
  statusCode: number;
  body: string;
  json<T>(): T;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol): T;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    payload?: string;
    headers: Record<string, string>;
  }): Promise<Response>;
}
type CreateHttpApp = (
  entry: 'api',
  options: Pick<
    Parameters<Platform['PlatformModule']['forRoot']>[0],
    'config' | 'clock' | 'logger' | 'dbHandles' | 'redisUrl'
  >,
) => Promise<HttpApp>;

const ROOT = new URL('../../../../', import.meta.url);
export const CREATED = '2026-10-01T02:00:00.000Z';
export const NOW = '2026-10-01T03:00:00.000Z';
export const PATH = '/v1/me';
export const NAME = '测试邀请实名人';
export const AVATAR = 'https://example.test/me-invite/avatar.png';

export async function open(database: TestDatabase, server: TestRedis) {
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as Platform;
  const crypto = (await import(
    new URL('apps/api/src/modules/platform/crypto/index.ts', ROOT).href
  )) as Crypto;
  const validation = (await import(
    new URL('apps/api/src/modules/platform/validation/index.ts', ROOT).href
  )) as Validation;
  const sessions = (await import(
    new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
  )) as Sessions;
  const tokens = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as Tokens;
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-11k-'));
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  let app: HttpApp | undefined;
  try {
    const master = randomBytes(32);
    const keyring = await crypto.createWrappedKeyring(new crypto.LocalKeyProvider(master));
    writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
    writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
    const clock = new platform.FixedClock(NOW);
    const lines: string[] = [];
    const logger = platform.createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      { write: (line: string) => void lines.push(line) },
    );
    const bootstrap = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp: CreateHttpApp;
    };
    app = await bootstrap.createHttpApp('api', {
      config: platform.loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
      }),
      clock,
      logger,
      dbHandles: { db, dbRead: null, close: async () => undefined },
      redisUrl: platform.loadConnectionConfig('api', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: server.url,
      }).redisUrl,
    });
    await app.init();
    const parser = createRequire(new URL('apps/api/package.json', ROOT))(
      '@readme/openapi-parser',
    ) as {
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
                { content: Record<string, { schema: Record<string, unknown> }> }
              >;
            };
          }
        >;
      }>;
    };
    const document = await parser.dereference(
      fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
      { resolve: { external: false } },
    );
    const schema = document.paths[PATH]!.get.responses['200']!.content['application/json']!.schema;
    return {
      app,
      db,
      dir,
      clock,
      lines,
      validate: validation.createValidatorCompiler()({ schema, httpPart: 'body' }),
      crypto: app.get<Awaited<ReturnType<Crypto['openFieldCrypto']>>>(platform.FIELD_CRYPTO),
      tokens: app.get<Parameters<Sessions['createSession']>[2]['tokens']>(tokens.TOKEN_SERVICE),
      createSession: sessions.createSession,
    };
  } catch (error) {
    await app?.close();
    await destroyDb(db);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
export type Kit = Awaited<ReturnType<typeof open>>;

export async function close(kit: Kit | undefined) {
  if (!kit) return;
  try {
    await kit.app.close();
  } finally {
    await destroyDb(kit.db);
    rmSync(kit.dir, { recursive: true, force: true });
  }
}

export async function config(kit: Kit, appId: string, key: string, value: unknown) {
  await kit.db
    .withSchema('app')
    .insertInto('config_items')
    .values({ app_id: appId, key, value: JSON.stringify(value), version: 1, updated_by: 'fixture' })
    .execute();
}

export async function fixture(
  kit: Kit,
  options: { appId?: string; phone?: boolean; createdAt?: string } = {},
) {
  const appId = options.appId ?? `mi_${randomBytes(10).toString('hex')}`;
  const uid = randomUUID();
  // Six characters from the contract alphabet; collision avoidance is local to a fixture app.
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const inviteCode = [...randomBytes(6)].map((n) => alphabet[n % alphabet.length]).join('');
  if (options.appId === undefined) {
    await sql`INSERT INTO app.app_versions
      (id, app_id, platform, channel, latest_version, min_supported_version, update_title,
       update_notes, store_url, default_store, store_listings)
      VALUES (${randomUUID()}, ${appId}, 'ios', 'appstore', '2.0.0', '2.0.0', 'fixture',
       'fixture', 'https://example.test/app', 'appstore', '[]'::jsonb)`.execute(kit.db);
  }
  const createdAt = new Date(options.createdAt ?? CREATED);
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, phone_hmac,
     created_at, updated_at)
    VALUES (${uid}, ${appId}, '邀请字段测试用户', ${AVATAR}, ${inviteCode}, ${randomUUID()},
      'L1', 'wechat', ${options.phone === false ? null : randomBytes(32).toString('hex')},
      ${createdAt}, ${createdAt})`.execute(kit.db);
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const response = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json<{ code: number }>().code).toBe(0);
  const device = response.json<{ data: { device_id: string } }>().data;
  const get = async (scope: 'full' | 'deletion_only' = 'full') => {
    // Reissue after moving the injected Clock, so age/backfill tests cannot fail on JWT expiry.
    const session = await kit.db
      .withSchema('app')
      .transaction()
      .execute((trx) =>
        kit.createSession(
          trx,
          { uid, app_id: appId, device_id: device.device_id, scp: scope },
          { clock: kit.clock, tokens: kit.tokens },
        ),
      );
    const result = await kit.app.inject({
      method: 'GET',
      url: PATH,
      headers: {
        ...headers,
        'x-device-id': device.device_id,
        authorization: `Bearer ${session.access_token}`,
      },
    });
    expect(result.statusCode).toBe(200);
    const body = result.json<{ code: number; data: Me }>();
    expect(body.code).toBe(0);
    expect(kit.validate(body), JSON.stringify(kit.validate.errors)).toBe(true);
    return body.data;
  };
  return { appId, uid, inviteCode, get };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function verified(kit: Kit, f: Fixture, birth: string) {
  // Same FieldCrypto contexts as B1-13d realname/kit.ts; synthetic PII, never an external call.
  const id = `synthetic-${f.uid}`;
  const encrypted = (value: string, context: string) =>
    Buffer.from(kit.crypto.encrypt(value, context));
  await sql`INSERT INTO app.realname
    (id, app_id, user_id, status, name_cipher, id_no_cipher, id_no_hmac, birth_date_cipher,
     provider, verified_at)
    VALUES (${randomUUID()}, ${f.appId}, ${f.uid}, 'verified',
      ${encrypted(NAME, 'realname.name')}, ${encrypted(id, 'realname.id_no')},
      ${kit.crypto.blindIndex(id, 'realname.id_no')},
      ${encrypted(birth, 'realname.birth_date')}, 'test-two-elements', ${kit.clock.now()})`.execute(
    kit.db,
  );
}

export async function risk(
  kit: Kit,
  f: Fixture,
  state: 'normal' | 'banned' | 'appealing' | 'frozen',
) {
  const until = state === 'frozen' ? new Date('2035-01-01T00:00:00.000Z') : null;
  await sql`INSERT INTO app.user_risk_state
    (app_id, user_id, state, reason_category, frozen_until, changed_by, changed_at)
    VALUES (${f.appId}, ${f.uid}, ${state}, ${state === 'normal' ? null : 'other'},
      ${until}, 'fixture', ${kit.clock.now()})
    ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state,
      reason_category = EXCLUDED.reason_category, frozen_until = EXCLUDED.frozen_until,
      row_version = app.user_risk_state.row_version + 1,
      changed_at = EXCLUDED.changed_at`.execute(kit.db);
}

export async function appeal(kit: Kit, f: Fixture, previous: 'banned' | 'frozen') {
  await sql`INSERT INTO app.appeals
    (id, app_id, user_id, target_type, target_id, prev_risk_state, status, content, deadline_at)
    VALUES (${randomUUID()}, ${f.appId}, ${f.uid}, 'account', ${f.uid}, ${previous},
      'processing', 'fixture', ${new Date('2035-01-01T00:00:00.000Z')})`.execute(kit.db);
}
