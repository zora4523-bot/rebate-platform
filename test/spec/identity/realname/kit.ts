// B1-13d §9.2: real AppModule/PG/Redis; only verifier and Redis failure seams are replaced.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb } from '@couli/db';
import { sql } from 'kysely';
import { expect, vi } from 'vitest';
import type * as Platform from '../../../../apps/api/src/modules/platform/index.ts';
import type * as Crypto from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type * as Validation from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type * as Sessions from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import type * as Tokens from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import type * as Verifier from '../../../../apps/api/src/modules/identity/infra/fake-realname-verifier.ts';
import type { RealnameReader } from '../../../../apps/api/src/modules/identity/infra/realname-reader.ts';
import type {
  RealnameVerificationInput,
  RealnameVerificationResult,
} from '../../../../apps/api/src/modules/identity/ports/realname-verifier.ts';

// @couli/db/testing is imported only by the integration test, never by this kit.
interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}
interface TestRedis {
  url: string;
  stop(): Promise<void>;
}
export const ROOT = new URL('../../../../', import.meta.url);
export const PATH = '/v1/me/realname';
export const NOW = '2026-09-29T15:59:00.000Z';
export const NAME = '欧阳小明';
export const ID = '11010519491231002X';
export const BODY = { name: NAME, id_no: ID };
// New storage's technical FieldCrypto domains, not business constants.
export const CONTEXT = {
  name_cipher: 'realname.name',
  id_no_cipher: 'realname.id_no',
  birth_date_cipher: 'realname.birth_date',
};
type Contract = {
  paths: Record<
    string,
    Record<
      string,
      {
        'x-implementation'?: string;
        responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
      }
    >
  >;
};
export interface Response {
  statusCode: number;
  body: string;
  json<T = Record<string, unknown>>(): T;
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
  overrides: Pick<
    Platform.PlatformOptions,
    'config' | 'clock' | 'logger' | 'dbHandles' | 'redisUrl'
  >,
) => Promise<HttpApp>;

export async function open(database: TestDatabase, server: TestRedis, verifierAbsent = false) {
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as typeof Platform;
  const cryptoModule = (await import(
    new URL('apps/api/src/modules/platform/crypto/index.ts', ROOT).href
  )) as typeof Crypto;
  const validation = (await import(
    new URL('apps/api/src/modules/platform/validation/index.ts', ROOT).href
  )) as typeof Validation;
  const vendorModule = (await import(
    new URL('apps/api/src/modules/identity/infra/fake-realname-verifier.ts', ROOT).href
  )) as typeof Verifier;
  const sessions = (await import(
    new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
  )) as typeof Sessions;
  const tokens = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as typeof Tokens;
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-13d-'));
  const master = randomBytes(32);
  const keyring = await cryptoModule.createWrappedKeyring(
    new cryptoModule.LocalKeyProvider(master),
  );
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const clock = new platform.FixedClock(NOW);
  const lines: string[] = [];
  const logger = platform.createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const vendor = vi
    .fn<(input: RealnameVerificationInput) => Promise<RealnameVerificationResult>>()
    .mockResolvedValue({ outcome: 'mismatch', provider: 'test-two-elements' });
  const faults = { redis: false };
  const namespaces = new Set<string>();
  const attemptKeys: string[] = [];
  const vendorSpy = vi
    .spyOn(vendorModule, 'createRealnameVerifier')
    .mockImplementation(() => (verifierAbsent ? null : { verify: vendor }));
  const originalPlatform = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
  const redisSpy = vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = originalPlatform(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) => {
        if (
          typeof provider !== 'object' ||
          provider === null ||
          !('provide' in provider) ||
          provider.provide !== platform.REDIS ||
          !('useFactory' in provider)
        )
          return provider;
        const factory = provider.useFactory as () => Promise<Platform.RedisHandle>;
        return {
          provide: platform.REDIS,
          useFactory: async () => {
            const handle = await factory();
            return {
              ...handle,
              namespace(name: string) {
                namespaces.add(name);
                const ns = handle.namespace(name);
                const record = (keys: readonly string[]) => {
                  if (name.includes('realname')) attemptKeys.push(...keys);
                };
                const fail = () =>
                  Promise.reject(new platform.RedisUnavailableError('command_failed'));
                const broken = () => faults.redis && name.includes('realname');
                return {
                  get: (key: string) => {
                    record([key]);
                    return broken() ? fail() : ns.get(key);
                  },
                  set: (key: string, value: string, ttl: number) => {
                    record([key]);
                    return broken() ? fail() : ns.set(key, value, ttl);
                  },
                  eval: (
                    script: string,
                    options: Parameters<Platform.RedisNamespace['eval']>[1],
                  ) => {
                    record(options.keys);
                    return broken() ? fail() : ns.eval(script, options);
                  },
                };
              },
            };
          },
        };
      }),
    };
  });
  let app: HttpApp | undefined;
  try {
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
    const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
    const parser = requireApi('@readme/openapi-parser') as {
      dereference(path: string, options: object): Promise<Contract>;
    };
    const document = await parser.dereference(
      fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
      { resolve: { external: false } },
    );
    return {
      app,
      db,
      database,
      server,
      dir,
      clock,
      lines,
      vendor,
      faults,
      namespaces,
      attemptKeys,
      document,
      compile: validation.createValidatorCompiler(),
      crypto: app.get<Platform.FieldCrypto>(platform.FIELD_CRYPTO),
      redis: app.get<Platform.RedisHandle>(platform.REDIS),
      tokens: app.get<Parameters<typeof sessions.createSession>[2]['tokens']>(tokens.TOKEN_SERVICE),
      createSession: sessions.createSession,
    };
  } catch (error) {
    await app?.close();
    await destroyDb(db);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    vendorSpy.mockRestore();
    redisSpy.mockRestore();
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
export function reset(kit: Kit) {
  kit.clock.set(NOW);
  kit.vendor.mockReset().mockResolvedValue({ outcome: 'mismatch', provider: 'test-two-elements' });
  kit.faults.redis = false;
  kit.lines.length = 0;
  kit.attemptKeys.length = 0;
}
export async function fixture(
  kit: Kit,
  options: { appId?: string; phone?: boolean; consent?: boolean } = {},
) {
  const appId = options.appId ?? `rn_${randomBytes(10).toString('hex')}`;
  const uid = randomUUID();
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  if (options.appId === undefined) {
    await sql`INSERT INTO app.app_versions (id, app_id, platform, channel, latest_version, min_supported_version, update_title, update_notes, store_url, default_store, store_listings)
      VALUES (${randomUUID()}, ${appId}, 'ios', 'appstore', '2.0.0', '2.0.0', 'fixture', 'fixture', 'https://example.test/app', 'appstore', '[]'::jsonb)`.execute(
      kit.db,
    );
  }
  const created = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(created.statusCode).toBe(200);
  const device = created.json<{ data: { device_id: string; install_secret: string } }>().data;
  await sql`INSERT INTO app.users (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, phone_hmac)
    VALUES (${uid}, ${appId}, 'fixture', 'https://example.test/avatar.png', ${randomUUID()}, ${randomUUID()}, 'L1', 'wechat', ${options.phone === false ? null : randomBytes(32).toString('hex')})`.execute(
    kit.db,
  );
  const consent = async (
    accepted: boolean,
    offset = 0,
    subject: 'user' | 'device' = 'user',
    version = 1,
    type = 'id_verification',
  ) => {
    const at = new Date(kit.clock.now().getTime() + offset);
    await sql`INSERT INTO app.consent_records (app_id, subject_type, user_id, device_id, type, version, channel, accepted, client_at, server_at, created_at)
      VALUES (${appId}, ${subject}, ${subject === 'user' ? uid : null}, ${subject === 'device' ? device.device_id : null}, ${type}, ${version}, 'realname_sheet', ${accepted}, ${at}, ${at}, ${at})`.execute(
      kit.db,
    );
  };
  if (options.consent !== false) await consent(true, -1000);
  // Renew the test session after Clock moves; no real-time waits or expired JWT fixtures.
  const request = async (
    method: 'POST' | 'GET',
    path: string,
    body?: unknown,
    key: string = randomUUID(),
  ) => {
    const session = await kit.db
      .withSchema('app')
      .transaction()
      .execute((trx) =>
        kit.createSession(
          trx,
          { uid, app_id: appId, device_id: device.device_id, scp: 'full' },
          { clock: kit.clock, tokens: kit.tokens },
        ),
      );
    const raw = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const text = [
      method,
      path,
      timestamp,
      nonce,
      createHash('sha256').update(raw).digest('hex'),
    ].join('\n');
    return kit.app.inject({
      method,
      url: path,
      ...(body === undefined ? {} : { payload: raw }),
      headers: {
        ...headers,
        authorization: `Bearer ${session.access_token}`,
        'x-device-id': device.device_id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': createHmac('sha256', device.install_secret).update(text).digest('hex'),
        'idempotency-key': key,
        'x-trace-id': randomUUID(),
      },
    });
  };
  const rows = async () =>
    (
      await sql<
        Record<string, unknown>
      >`SELECT * FROM app.realname WHERE app_id = ${appId} AND user_id = ${uid}`.execute(kit.db)
    ).rows;
  return {
    appId,
    uid,
    deviceId: device.device_id,
    consent,
    request,
    rows,
    submit: (body: unknown = BODY, key?: string) => request('POST', PATH, body, key),
    me: () => request('GET', '/v1/me'),
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export async function seedVerified(kit: Kit, f: Fixture, id = ID, birth = '1949-12-31') {
  const encrypted = (value: string, context: string) =>
    Buffer.from(kit.crypto.encrypt(value, context));
  await sql`INSERT INTO app.realname (id, app_id, user_id, status, name_cipher, id_no_cipher, id_no_hmac, birth_date_cipher, provider, verified_at)
    VALUES (${randomUUID()}, ${f.appId}, ${f.uid}, 'verified', ${encrypted(NAME, CONTEXT.name_cipher)}, ${encrypted(id, CONTEXT.id_no_cipher)}, ${kit.crypto.blindIndex(id, CONTEXT.id_no_cipher)}, ${encrypted(birth, CONTEXT.birth_date_cipher)}, 'test-two-elements', ${kit.clock.now()})`.execute(
    kit.db,
  );
}
export function envelope(kit: Kit, response: Response, code: number, path = PATH) {
  const statuses: Record<number, number> = {
    0: 200,
    10004: 403,
    10005: 403,
    20001: 400,
    50001: 500,
    50301: 503,
    50401: 504,
  };
  expect(response.statusCode).toBe(statuses[code] ?? 422);
  const body = response.json<{
    code: number;
    msg: string;
    trace_id: string;
    data?: Record<string, unknown>;
  }>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  const operation = kit.document.paths[path]![path === PATH ? 'post' : 'get']!;
  const schema =
    operation.responses[code === 0 ? '200' : code >= 50000 ? '5XX' : '4XX']!.content[
      'application/json'
    ]!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body;
}
export function privateDataAbsent(kit: Kit, responses: Response[], extras: string[] = []) {
  const text = kit.lines.join('\n') + responses.map((r) => r.body).join('\n');
  for (const secret of [NAME, ID, ...extras]) expect(text.includes(secret)).toBe(false);
}
export async function reader(kit: Kit) {
  const identity = (await import(new URL('apps/api/src/modules/identity/index.ts', ROOT).href)) as {
    createRealnameReader(crypto: Platform.FieldCrypto): RealnameReader;
  };
  return identity.createRealnameReader(kit.crypto);
}
export function residentId(birth: string, serial = '002') {
  const prefix = `110105${birth.replaceAll('-', '')}${serial}`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = [...prefix].reduce((n, char, i) => n + Number(char) * weights[i]!, 0);
  return prefix + '10X98765432'[sum % 11];
}
