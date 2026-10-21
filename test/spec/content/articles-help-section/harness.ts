// F1-02zs：独立 HTTP 夹具；数据库工具由 *.int.test.ts 传入。
import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
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
import {
  loadConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';

const ROOT = new URL('../../../../', import.meta.url);
export const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
export const NOW = '2026-10-21T02:00:00.000Z';
export interface Response {
  statusCode: number;
  json<T = { code: number; data?: Record<string, unknown> }>(): T;
}
export interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: {
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<Response>;
  getHttpAdapter(): {
    getInstance(): { hasRoute(input: { method: string; url: string }): boolean };
  };
}
interface TestDatabase {
  urlFor(role: 'couli_app' | 'couli_readonly'): string;
  drop(): Promise<void>;
}
interface TestRedis {
  url: string;
  stop(): Promise<void>;
}
interface Testing {
  createTestDatabase(): Promise<TestDatabase>;
  acquireTestRedis(): Promise<TestRedis>;
}
export interface Harness {
  db: Kysely<DB>;
  fields: FieldCrypto;
  env: Record<string, string>;
  apps: HttpApp[];
  password: string;
  passwordHash: string;
}

export function useHarness(load: () => Promise<Testing>): Harness {
  const h = {} as Harness;
  let database: TestDatabase | undefined;
  let redis: TestRedis | undefined;
  let directory: string | undefined;
  beforeAll(async () => {
    h.apps = [];
    const testing = await load();
    database = await testing.createTestDatabase();
    redis = await testing.acquireTestRedis();
    h.db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 }).withSchema('app');
    const base = fileURLToPath(new URL('.tmp/', ROOT));
    mkdirSync(base, { recursive: true });
    directory = mkdtempSync(join(base, 'f1_02zs_'));
    const master = randomBytes(32);
    const provider = new LocalKeyProvider(master);
    const wrapped = await createWrappedKeyring(provider);
    h.fields = await openFieldCrypto(wrapped, provider);
    const masterFile = join(directory, 'synthetic-master.hex');
    const keyringFile = join(directory, 'synthetic-keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(wrapped), { mode: 0o600 });
    const jwt = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    h.env = {
      APP_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: database.urlFor('couli_app'),
      DATABASE_READ_URL: database.urlFor('couli_readonly'),
      REDIS_URL: redis.url,
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: masterFile,
      FIELD_KEYRING_FILE: keyringFile,
      ADMIN_TOKEN_SIGNING_KEY: randomBytes(32).toString('base64url'),
      ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
      ADMIN_CORS_ORIGIN: 'https://admin.example.invalid',
      JWT_KEY_ID: 'f1_02zs',
      JWT_PRIVATE_KEY_PEM: jwt.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      MEDIA_PUBLIC_BASE_URL: 'https://media.example.test/assets',
    };
    h.password = 'Aaaaaaaaaaaaaaa1!';
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
        await redis?.stop();
        if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
      }
    }
  });
  return h;
}

export async function fixture(
  h: Harness,
  entry: 'admin' | 'api' = 'admin',
  clock = new FixedClock(NOW),
) {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'admin' | 'api',
      overrides: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: ReturnType<typeof createRootLogger>;
        dbHandles: DbHandles;
        redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const app = await createHttpApp(entry, {
    config: loadConfig(h.env),
    clock,
    logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }),
    dbHandles: { db: h.db, dbRead: null, close: async () => undefined },
    redisUrl: loadConnectionConfig('admin', h.env).redisUrl,
  });
  h.apps.push(app);
  await app.init();
  return { app, clock };
}

function base32(bytes: Buffer): string {
  const bits = [...bytes].map((b) => b.toString(2).padStart(8, '0')).join('');
  return (bits.match(/.{1,5}/g) ?? [])
    .map((g) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(g.padEnd(5, '0'), 2)])
    .join('');
}
export async function seed(h: Harness, appId: string, isSuper = false) {
  const id = randomUUID();
  const username = `article-${id}`;
  const secret = randomBytes(20);
  await h.db
    .insertInto('admin_users')
    .values({
      id,
      app_id: appId,
      login_name: username,
      password_hash: h.passwordHash,
      is_super: isSuper,
      status: 'active',
      password_must_change: false,
      totp_secret_cipher: Buffer.from(
        h.fields.encrypt(base32(secret), `admin_users.totp_secret:${appId}:${id}`),
      ),
      totp_bound_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
  return { id, appId, username, secret };
}
export type Actor = Awaited<ReturnType<typeof seed>>;
export async function grant(
  h: Harness,
  actor: Actor,
  owner: Actor,
  permissions: readonly string[],
) {
  if (permissions.length === 0) return;
  await h.db
    .insertInto('admin_permissions')
    .values(
      permissions.map((permission_key) => ({
        app_id: actor.appId,
        admin_id: actor.id,
        permission_key,
        granted_by: owner.id,
        granted_at: NOW,
        created_at: NOW,
      })),
    )
    .execute();
}
export async function signedIn(h: Harness, f: Awaited<ReturnType<typeof fixture>>, actor: Actor) {
  const post = (suffix: string, body: object) =>
    f.app.inject({
      method: 'POST',
      url: `/admin/v1/auth/${suffix}`,
      remoteAddress: '127.0.0.1',
      headers: { 'content-type': 'application/json', 'x-trace-id': randomUUID() },
      payload: JSON.stringify(body),
    });
  const login = await post('login', { username: actor.username, password: h.password });
  expect(login.statusCode).toBe(200);
  expect(login.json()).toMatchObject({ code: 0, data: { next: 'totp' } });
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(f.clock.now().getTime() / 30_000)));
  const mac = createHmac('sha1', actor.secret).update(counter).digest();
  const code = String((mac.readUInt32BE(mac[19]! & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
  const session = await post('totp', {
    login_ticket: login.json<{ data: { login_ticket: string } }>().data.login_ticket,
    code,
  });
  expect(session.statusCode).toBe(200);
  expect(session.json()).toMatchObject({ code: 0, data: { admin_token: expect.any(String) } });
  return session.json<{ data: { admin_token: string } }>().data.admin_token;
}
