import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

// Intercept the sanctioned application logger, including child bindings. The reader's public
// signature has only { db }, so no unused logger option is added just for this assertion.
const logging = vi.hoisted(() => {
  const write = vi.fn();
  const logger = {
    trace: write,
    debug: write,
    info: write,
    warn: write,
    error: write,
    fatal: write,
    child: vi.fn(),
  };
  logger.child.mockImplementation((...args: unknown[]) => {
    write(...args);
    return logger;
  });
  return { write, logger };
});
vi.mock('../../../../apps/api/src/modules/platform/logging/logger.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createRootLogger: vi.fn(() => logging.logger) };
});

// Same runtime index import as the existing identity reader suites: Nest decorators stay in
// the API TS project. The type query is erased; every call uses the public index export.
const { createAgentCallerReader } = (await import(
  new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/identity/ports/agent-caller.ts');

// BR-AI-12 supplies the phone-bound fact; the exact read interface and isolation/read-only
// requirements come from B1-02x §9. No token, quota or stream assembly behavior is tested here.
const clock = new FixedClock('2026-10-17T00:00:00.000Z');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const PRIVATE_PHONE = 'synthetic-phone-not-a-real-number';
let database: TestDatabase | undefined;
let db: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app') });
});

afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

function appId(): string {
  return `synthetic_agent_caller_${randomUUID()}`;
}

async function user(app: string, phoneHmac: string | null): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('users')
    .values({
      id,
      app_id: app,
      phone_hmac: phoneHmac,
      // Deliberately present even with null HMAC: phoneBound must not inspect phone_cipher.
      phone_cipher: Buffer.from(PRIVATE_PHONE),
      nickname: 'synthetic-agent-caller',
      avatar: 'https://example.invalid/avatar.png',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      register_method: 'sms',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  return id;
}

async function device(
  app: string,
  hash: string,
  options: { userId?: string; revoked?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('devices')
    .values({
      id,
      app_id: app,
      user_id: options.userId ?? null,
      device_hash: hash,
      id_source: 'idfv',
      platform: 'ios',
      app_version: '0.0.0-test',
      install_secret_cipher: Buffer.from('synthetic-install-secret'),
      revoked_at: options.revoked ? clock.now() : null,
      last_seen_at: clock.now(),
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  return id;
}

it('[AC-B1-02x#1][BR-AI-12] phone_hmac 非空的用户已绑手机', async () => {
  const app = appId();
  const uid = await user(app, 'synthetic-phone-hmac');
  // The port's fact is defined by phone_hmac, independently of cipher presence.
  await db.updateTable('users').set({ phone_cipher: null }).where('id', '=', uid).execute();
  const reader = createAgentCallerReader({ db });
  expect(await reader.phoneBound(app, uid)).toBe(true);
});

it('[AC-B1-02x#2][BR-AI-12] phone_hmac 为 null 时未绑手机，即使有 phone_cipher', async () => {
  const app = appId();
  const uid = await user(app, null);
  const reader = createAgentCallerReader({ db });
  expect(await reader.phoneBound(app, uid)).toBe(false);
});

it('[AC-B1-02x#3][BR-AI-12] 同 uid 跨 app 不可见，交错读取不串应用', async () => {
  const owner = appId();
  const foreign = appId();
  const uid = await user(owner, 'synthetic-phone-hmac');
  await user(foreign, 'synthetic-other-phone-hmac');
  // users.id is globally unique: seed distinct users, query the owner's id in both apps.
  const reader = createAgentCallerReader({ db });
  expect(await reader.phoneBound(foreign, uid)).toBe(false);
  expect(await reader.phoneBound(owner, uid)).toBe(true);
  expect(await reader.phoneBound(foreign, uid)).toBe(false);
});

it('[AC-B1-02x#4][BR-AI-12] 同 app 有已绑用户，但指定 uid 不存在仍返回 false', async () => {
  const app = appId();
  await user(app, 'synthetic-phone-hmac');
  const reader = createAgentCallerReader({ db });
  expect(await reader.phoneBound(app, randomUUID())).toBe(false);
});

it('[AC-B1-02x#5][BR-AI-12] 同一 reader 即时反映绑定、换绑、解绑和重新绑定', async () => {
  const app = appId();
  const uid = await user(app, null);
  const reader = createAgentCallerReader({ db });
  expect(await reader.phoneBound(app, uid)).toBe(false);
  for (const [hmac, expected] of [
    ['synthetic-first-phone-hmac', true],
    ['synthetic-replacement-phone-hmac', true],
    [null, false],
    ['synthetic-rebound-phone-hmac', true],
  ] as const) {
    await db
      .updateTable('users')
      .set({ phone_hmac: hmac })
      .where('app_id', '=', app)
      .where('id', '=', uid)
      .execute();
    expect(await reader.phoneBound(app, uid)).toBe(expected);
  }
});

it('[AC-B1-02x#6][BR-AI-12] 游客设备无用户或注册记录也返回存储的 device_hash', async () => {
  const app = appId();
  const id = await device(app, HASH_A);
  const reader = createAgentCallerReader({ db });
  // Fixed expected hash catches returning the device UUID or its login-log blind index.
  expect(await reader.deviceHash(app, id)).toBe(HASH_A);
});

it('[AC-B1-02x#7][BR-AI-12] 同 app 存在其他设备，指定设备不存在返回 null', async () => {
  const app = appId();
  await device(app, HASH_A);
  const reader = createAgentCallerReader({ db });
  expect(await reader.deviceHash(app, randomUUID())).toBeNull();
});

it('[AC-B1-02x#8][BR-AI-12] 设备 ID 跨 app 不可见，交错读取不串应用', async () => {
  const owner = appId();
  const foreign = appId();
  const id = await device(owner, HASH_A);
  await device(foreign, HASH_B);
  const reader = createAgentCallerReader({ db });
  expect(await reader.deviceHash(foreign, id)).toBeNull();
  expect(await reader.deviceHash(owner, id)).toBe(HASH_A);
  expect(await reader.deviceHash(foreign, id)).toBeNull();
});

it('[AC-B1-02x#9][BR-AI-12] revoked_at 非空返回 null，即使同 hash 有有效设备', async () => {
  const app = appId();
  const revoked = await device(app, HASH_A, { revoked: true });
  const active = await device(app, HASH_A);
  const reader = createAgentCallerReader({ db });
  expect(await reader.deviceHash(app, active)).toBe(HASH_A);
  expect(await reader.deviceHash(app, revoked)).toBeNull();
});

it('[AC-B1-02x#10][BR-AI-12] 不同设备不串，同 hash 不同设备 ID 返回相同索引', async () => {
  const app = appId();
  const uid = await user(app, 'synthetic-phone-hmac');
  const first = await device(app, HASH_A, { userId: uid });
  const second = await device(app, HASH_B, { userId: uid });
  const sameHash = await device(app, HASH_A);
  const reader = createAgentCallerReader({ db });
  expect(await reader.deviceHash(app, first)).toBe(HASH_A);
  expect(await reader.deviceHash(app, second)).toBe(HASH_B);
  expect(await reader.deviceHash(app, sameHash)).toBe(HASH_A);
  expect(await reader.deviceHash(app, first)).toBe(HASH_A);
});

it('[AC-B1-02x#11][BR-AI-12] 读取后撤销设备，后续读取不返回旧 hash', async () => {
  const app = appId();
  const id = await device(app, HASH_A);
  const reader = createAgentCallerReader({ db });
  expect(await reader.deviceHash(app, id)).toBe(HASH_A);
  await db
    .updateTable('devices')
    .set({ revoked_at: clock.now() })
    .where('app_id', '=', app)
    .where('id', '=', id)
    .execute();
  expect(await reader.deviceHash(app, id)).toBeNull();
});

async function snapshot() {
  // Whole-table sorted rows include row counts and all fields, including timestamps/version.
  return {
    users: await db.selectFrom('users').selectAll().orderBy('id').execute(),
    devices: await db.selectFrom('devices').selectAll().orderBy('id').execute(),
    registrations: await db
      .selectFrom('device_registrations')
      .selectAll()
      .orderBy('app_id')
      .orderBy('device_hash')
      .orderBy('user_id')
      .execute(),
    logins: await db
      .selectFrom('login_logs')
      .selectAll()
      .orderBy('created_at')
      .orderBy('id')
      .execute(),
  };
}

it('[AC-B1-02x#12][BR-AI-12] 所有读取分支不写表，相关表行数及完整内容不变', async () => {
  const app = appId();
  const bound = await user(app, 'synthetic-phone-hmac');
  const unbound = await user(app, null);
  const active = await device(app, HASH_A);
  const revoked = await device(app, HASH_B, { revoked: true });
  const before = await snapshot();
  await db
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      // PostgreSQL forbids writes to ANY persistent table, including audit/queue tables.
      const reader = createAgentCallerReader({ db: trx });
      expect(await reader.phoneBound(app, bound)).toBe(true);
      expect(await reader.phoneBound(app, unbound)).toBe(false);
      expect(await reader.phoneBound(app, randomUUID())).toBe(false);
      expect(await reader.phoneBound(appId(), bound)).toBe(false);
      expect(await reader.deviceHash(app, active)).toBe(HASH_A);
      expect(await reader.deviceHash(app, revoked)).toBeNull();
      expect(await reader.deviceHash(app, randomUUID())).toBeNull();
      expect(await reader.deviceHash(appId(), active)).toBeNull();
      // A swallowed write error must not pass silently with an aborted transaction.
      const probe = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(trx);
      expect(probe.rows).toEqual([{ ok: 1 }]);
    });
  expect(await snapshot()).toEqual(before);
});

it('[AC-B1-02x#13][BR-AI-12] 日志替身不接收手机号、手机号密文或原始设备 ID', async () => {
  const app = appId();
  const uid = await user(app, 'synthetic-sensitive-phone-hmac');
  const id = await device(app, HASH_A, { userId: uid });
  const revoked = await device(app, HASH_B, { revoked: true });
  const missing = randomUUID();
  logging.write.mockClear();
  const reader = createAgentCallerReader({ db });
  expect(await reader.phoneBound(app, uid)).toBe(true);
  expect(await reader.phoneBound(appId(), uid)).toBe(false);
  expect(await reader.phoneBound(app, missing)).toBe(false);
  expect(await reader.deviceHash(app, id)).toBe(HASH_A);
  expect(await reader.deviceHash(appId(), id)).toBeNull();
  expect(await reader.deviceHash(app, revoked)).toBeNull();
  expect(await reader.deviceHash(app, missing)).toBeNull();
  const logged = JSON.stringify(logging.write.mock.calls);
  for (const secret of [
    PRIVATE_PHONE,
    'synthetic-sensitive-phone-hmac',
    Buffer.from(PRIVATE_PHONE).toString('hex'),
    JSON.stringify(Buffer.from(PRIVATE_PHONE)),
    id,
    revoked,
    missing,
  ]) {
    expect(logged).not.toContain(secret);
  }
});
