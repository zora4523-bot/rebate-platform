import {
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  type KeyObject,
} from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { hashAdminPassword } from '../../../../apps/api/src/modules/admin/application/bootstrap.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
  openFieldCrypto,
  type FieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type { DbHandles } from '../../../../apps/api/src/modules/platform/db/index.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import type { RedisHandle } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger, redisConnection } from '../../identity/sms-codes/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
export const AUTH = '/admin/v1/auth';
export const READ = '/admin/v1/me/permissions';
export const SUPER = '/admin/v1/admins';
export const ORIGIN = 'https://admin.example.invalid';
export const NOW = '2026-10-09T02:00:00.000Z';
export const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));

export interface Response {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  json<T = { code: number; data?: Record<string, unknown> }>(): T;
}
export interface Request {
  method: 'GET' | 'POST' | 'OPTIONS';
  url: string;
  headers?: Record<string, string>;
  payload?: string;
  remoteAddress?: string;
}
export interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(request: Request): Promise<Response>;
  get<T>(token: symbol): T;
  getHttpAdapter(): {
    getInstance(): {
      get(path: string, handler: () => object): unknown;
      hasRoute(options: { method: 'GET'; url: string }): boolean;
    };
  };
}
interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}
interface TestRedis {
  url: string;
  stop(): Promise<void>;
}
type CreateHttpApp = (
  entry: 'api' | 'admin' | 'stream',
  overrides: {
    config: ReturnType<typeof loadConfig>;
    clock: FixedClock;
    logger: RootLogger;
    dbHandles: DbHandles;
    redisUrl: ReturnType<typeof redisConnection>['redisUrl'];
  },
) => Promise<HttpApp>;

// Dynamic import keeps Nest decorators out of the rule-test project's erasable-only TS build.
export async function factory(): Promise<CreateHttpApp> {
  const module = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp: CreateHttpApp;
  };
  return module.createHttpApp;
}

export interface Harness {
  db: Kysely<DB>;
  redis: TestRedis;
  fields: FieldCrypto;
  env: Record<string, string>;
  password: string;
  passwordHash: string;
  appKey: { privateKey: KeyObject; publicKey: KeyObject };
  apps: HttpApp[];
}

/** All connections belong to the container runner; never invoked by host-side static checks. */
export function useHarness(): Harness {
  const h = {} as Harness;
  let database: TestDatabase | undefined;
  let dir: string | undefined;
  beforeAll(async () => {
    h.apps = [];
    const testing = (await import(new URL('packages/db/src/testing/index.ts', ROOT).href)) as {
      createTestDatabase(): Promise<TestDatabase>;
      acquireTestRedis(): Promise<TestRedis>;
    };
    database = await testing.createTestDatabase();
    h.db = createDb({ connectionString: database.urlFor('couli_app') }).withSchema('app');
    h.redis = await testing.acquireTestRedis();
    const base = fileURLToPath(new URL('.tmp/', ROOT));
    mkdirSync(base, { recursive: true });
    dir = mkdtempSync(join(base, 'f1-06k-'));
    const master = randomBytes(32);
    const provider = new LocalKeyProvider(master);
    const wrapped = await createWrappedKeyring(provider);
    h.fields = await openFieldCrypto(wrapped, provider);
    const masterFile = join(dir, 'master.hex');
    const keyringFile = join(dir, 'keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(wrapped), { mode: 0o600 });
    h.appKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    h.env = {
      APP_ENV: 'test',
      LOG_LEVEL: 'silent',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: masterFile,
      FIELD_KEYRING_FILE: keyringFile,
      ADMIN_TOKEN_SIGNING_KEY: randomBytes(32).toString('base64url'),
      ADMIN_IP_ALLOWLIST: '127.0.0.1,::1,192.0.2.0/24,2001:db8::/32',
      ADMIN_CORS_ORIGIN: ORIGIN,
      JWT_KEY_ID: 'f1-06k-app',
      JWT_PRIVATE_KEY_PEM: h.appKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
    h.password = randomBytes(24).toString('base64url');
    h.passwordHash = await hashAdminPassword(h.password);
  }, 180_000);
  afterEach(async () => {
    for (const app of h.apps.splice(0)) await app.close();
  });
  afterAll(async () => {
    try {
      if (h.db !== undefined) await destroyDb(h.db);
    } finally {
      try {
        await database?.drop();
      } finally {
        await h.redis?.stop();
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  return h;
}

export async function fixture(
  h: Harness,
  options: {
    probes?: boolean;
    env?: Record<string, string>;
    entry?: 'admin' | 'api' | 'stream';
  } = {},
) {
  const clock = new FixedClock(NOW);
  const { logger, lines } = memoryLogger();
  const overrides = {
    config: loadConfig({ ...h.env, ...options.env }),
    clock,
    logger,
    dbHandles: { db: h.db, dbRead: null, close: async () => undefined },
    redisUrl: redisConnection(h.redis.url).redisUrl,
  };
  const app = await (await factory())(options.entry ?? 'admin', overrides);
  h.apps.push(app);
  await expect(app.init()).resolves.toBeDefined();
  if (options.probes === true) {
    // After Nest registers its routes, fill only missing probes using real contract auth metadata.
    // A registration refusal must be an assertion failure, never an uncaught infrastructure error.
    expect(() => {
      const server = app.getHttpAdapter().getInstance();
      if (!server.hasRoute({ method: 'GET', url: READ })) {
        server.get(READ, () => ({ code: 0, data: {} }));
      }
      if (!server.hasRoute({ method: 'GET', url: SUPER })) {
        server.get(SUPER, () => ({ code: 0, data: {} }));
      }
    }).not.toThrow();
  }
  const post = (
    suffix: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = {},
    ip = '127.0.0.1',
  ) =>
    app.inject({
      method: 'POST',
      url: `${AUTH}${suffix}`,
      payload: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
      remoteAddress: ip,
    });
  const read = (
    token: string,
    url = READ,
    headers: Record<string, string> = {},
    ip = '127.0.0.1',
  ) =>
    app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}`, ...headers },
      remoteAddress: ip,
    });
  return {
    app,
    clock,
    lines,
    overrides,
    post,
    read,
    closeRedis: async () => {
      const { REDIS } = (await import(
        new URL('apps/api/src/modules/platform/platform.module.ts', ROOT).href
      )) as { REDIS: symbol };
      await app.get<RedisHandle>(REDIS).close();
    },
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function account(h: Harness, patch: Partial<Insertable<DB['admin_users']>> = {}) {
  const id = randomUUID();
  const username = `auth-${id}`;
  const secret = base32(randomBytes(20));
  await h.db
    .insertInto('admin_users')
    .values({
      id,
      app_id: 'couli',
      login_name: username,
      password_hash: h.passwordHash,
      is_super: false,
      status: 'active',
      password_must_change: false,
      totp_secret_cipher: Buffer.from(
        h.fields.encrypt(secret, `admin_users.totp_secret:couli:${id}`),
      ),
      totp_bound_at: NOW,
      ...patch,
    })
    .execute();
  return { id, username, secret, password: h.password };
}
export type Account = Awaited<ReturnType<typeof account>>;
export const row = (h: Harness, a: Account) =>
  h.db.selectFrom('admin_users').selectAll().where('id', '=', a.id).executeTakeFirstOrThrow();
export const audits = (h: Harness, a: Account) =>
  h.db.selectFrom('audit_logs').selectAll().where('admin_id', '=', a.id).orderBy('id').execute();

export interface Step {
  next: 'totp' | 'change_password' | 'bind_totp';
  login_ticket: string;
  ticket_expires_at: string;
}
export interface Session {
  admin_token: string;
  expires_at: string;
  idle_timeout_sec: number;
}
export interface Binding {
  totp_secret: string;
  otpauth_uri: string;
}

export async function login(f: Fixture, a: Account, next: Step['next'] = 'totp'): Promise<Step> {
  const response = await f.post('/login', { username: a.username, password: a.password });
  const step = await success<Step>(response, '/login');
  expect(step.next).toBe(next);
  expect(step.ticket_expires_at).toBe(new Date(f.clock.now().getTime() + 300_000).toISOString());
  expect(step).not.toHaveProperty('admin_token');
  return step;
}
export async function signedIn(f: Fixture, a: Account): Promise<Session> {
  const ticket = await login(f, a);
  return success<Session>(
    await f.post('/totp', { login_ticket: ticket.login_ticket, code: totp(a.secret, f.clock) }),
    '/totp',
  );
}
export async function binding(f: Fixture, ticket: string): Promise<Binding> {
  return success<Binding>(await f.post('/totp/secret', { login_ticket: ticket }), '/totp/secret');
}

// Independently implement RFC 4648 / RFC 6238 for expected codes; never call the verifier.
export function base32(bytes: Buffer): string {
  const bits = [...bytes].map((b) => b.toString(2).padStart(8, '0')).join('');
  return (bits.match(/.{1,5}/g) ?? [])
    .map((g) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(g.padEnd(5, '0'), 2)])
    .join('');
}
export function totp(secret: string, clock: FixedClock, delta = 0): string {
  const bits = [...secret.replace(/=+$/, '')]
    .map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0'))
    .join('');
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(clock.now().getTime() / 30_000) + delta));
  const mac = createHmac('sha1', bytes).update(counter).digest();
  return String((mac.readUInt32BE(mac[19]! & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
export function wrongCode(secret: string, clock: FixedClock): string {
  const valid = [-1, 0, 1].map((delta) => totp(secret, clock, delta));
  let candidate = 0;
  while (valid.includes(String(candidate).padStart(6, '0'))) candidate += 1;
  return String(candidate).padStart(6, '0');
}

type Check = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let validators: Promise<Map<string, Check>> | undefined;
function responseValidators(): Promise<Map<string, Check>> {
  validators ??= (async () => {
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(
        path: string,
        options: object,
      ): Promise<{
        paths: Record<
          string,
          {
            post: {
              responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
            };
          }
        >;
      }>;
    };
    const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    });
    const result = new Map<string, Check>();
    const compile = createValidatorCompiler();
    for (const suffix of [
      '/login',
      '/password',
      '/totp/secret',
      '/totp/bind',
      '/totp',
      '/logout',
    ]) {
      for (const status of ['200', '4XX', '5XX']) {
        const schema =
          doc.paths[`${AUTH}${suffix}`]!.post.responses[status]!.content['application/json']!
            .schema;
        result.set(`${suffix}:${status}`, compile({ schema, httpPart: 'body' }));
      }
    }
    return result;
  })();
  return validators;
}
export async function validate(response: Response, suffix: string): Promise<void> {
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const check = (await responseValidators()).get(`${suffix}:${status}`)!;
  expect(check(response.json())).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}
export async function success<T>(response: Response, suffix: string): Promise<T> {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response, suffix);
  expect(response.headers['set-cookie']).toBeUndefined();
  return response.json<{ data: T }>().data;
}
export async function failure(
  response: Response,
  suffix: string,
  code: number,
  data?: object,
): Promise<void> {
  expect(response.statusCode).toBe(
    code === 10403 || code === 10009 ? 403 : code === 20001 || code === 20002 ? 400 : 401,
  );
  expect(response.json()).toMatchObject({ code });
  if (data === undefined) expect(response.json()).not.toHaveProperty('data');
  else expect(response.json<{ data: object }>().data).toEqual(data);
  await validate(response, suffix);
}
export const expiredTicket = (response: Response, suffix: string) =>
  failure(response, suffix, 10001, { reason: 'login_ticket_expired' });
