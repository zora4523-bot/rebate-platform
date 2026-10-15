import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type {
  AiConsentReader,
  AiConsentReaderOptions,
  AiConsentSubject,
  AiConsentVerdict,
} from '../../../../apps/api/src/modules/identity/ports/ai-consent.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

// As in identity/session/kit.ts: load the public index at runtime so Nest decorators
// stay in the API compilation project. Only erased port types use a direct import.
const { createAiConsentReader } = (await import(
  new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/identity/ports/ai-consent.ts');

// BR-AI-13: equality with the injected version, not a hard-coded policy version.
// These version numbers and instants are synthetic fixture values, not business defaults.
const VERSION = 3;
const INSTANT = '2026-10-15T01:00:00.000Z';
let database: TestDatabase | undefined;
let db: Kysely<DB>;
let seedDb: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app') });
  // The existing kit exposes business roles only. couli_app has INSERT permission;
  // direct fixture writes need neither a superuser nor a consent HTTP endpoint.
  seedDb = createDb({ connectionString: database.urlFor('couli_app') });
});
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
    if (seedDb) await destroyDb(seedDb);
  } finally {
    await database?.drop();
  }
});

async function fixture(): Promise<AiConsentSubject> {
  const appId = `ai_consent_${randomUUID()}`;
  const userId = randomUUID();
  const deviceId = randomUUID();
  const clock = new FixedClock(INSTANT);
  await seedDb
    .insertInto('users')
    .values({
      id: userId,
      app_id: appId,
      nickname: 'synthetic-ai-consent-user',
      avatar: 'https://example.invalid/avatar.png',
      invite_code: 'TEST01',
      attr_code: 'TEST0001',
      level: 'L1',
      register_method: 'sms',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  await seedDb
    .insertInto('devices')
    .values({
      id: deviceId,
      app_id: appId,
      user_id: userId,
      device_hash: 'a'.repeat(64),
      id_source: 'idfv',
      platform: 'ios',
      app_version: '0.0.0-test',
      install_secret_cipher: Buffer.from('synthetic-not-a-real-secret'),
      last_seen_at: clock.now(),
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  return { appId, userId, deviceId };
}

interface RecordInput {
  subjectType: 'user' | 'device';
  type: 'ai_third_party' | 'privacy' | 'personalization';
  accepted: boolean;
  version: number;
  serverTick: number;
  clientTick: number;
}

function at(tick: number): Date {
  const clock = new FixedClock(INSTANT);
  clock.advanceMs(tick * 1000);
  return clock.now();
}

async function record(subject: AiConsentSubject, changes: Partial<RecordInput> = {}) {
  const input: RecordInput = {
    subjectType: subject.userId === null ? 'device' : 'user',
    type: 'ai_third_party',
    accepted: true,
    version: VERSION,
    serverTick: 0,
    clientTick: 0,
    ...changes,
  };
  return seedDb
    .insertInto('consent_records')
    .values({
      app_id: subject.appId,
      subject_type: input.subjectType,
      // Device records may retain the logged-in user_id (as privacy withdrawal does).
      user_id: subject.userId,
      device_id: subject.deviceId,
      type: input.type,
      accepted: input.accepted,
      version: input.version,
      channel: 'agent_sheet',
      server_at: at(input.serverTick),
      client_at: at(input.clientTick),
      created_at: at(input.clientTick),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

function reader(options: Partial<AiConsentReaderOptions> = {}): AiConsentReader {
  // Always called inside the test, outside any rejection assertion: the skeleton's
  // synchronous NotImplemented must fail even tests expecting check() to reject.
  return createAiConsentReader({ db, currentVersion: async () => VERSION, ...options });
}

it('[AC-B1-02r#1][BR-AI-13] 登录用户没有 AI 同意记录时 missing', async () => {
  const subject = await fixture();
  expect(await reader().check(subject)).toEqual({ allowed: false, reason: 'missing' });
});

it('[AC-B1-02r#2][BR-AI-13] 最新同意有效时放行并返回当前版本', async () => {
  const subject = await fixture();
  await record(subject);
  expect(await reader().check(subject)).toEqual({ allowed: true, version: VERSION });
});

it.each([
  { ac: 3, version: VERSION - 1 },
  { ac: 4, version: VERSION + 1 },
])(
  '[AC-B1-02r#$ac][BR-AI-13] 已同意版本 $version 不等于当前版本时 outdated',
  async ({ version }) => {
    const subject = await fixture();
    await record(subject);
    await record(subject, { version, serverTick: 1 });
    expect(await reader().check(subject)).toEqual({ allowed: false, reason: 'outdated' });
  },
);

it('[AC-B1-02r#5][BR-AI-13] 同意后撤回，以较晚 server_at 判 withdrawn', async () => {
  const subject = await fixture();
  await record(subject, { accepted: false, serverTick: 2, clientTick: -1 });
  // Insert an older consent last: neither insertion order nor client_at/created_at wins.
  await record(subject, { serverTick: 1, clientTick: 9 });
  expect(await reader().check(subject)).toEqual({ allowed: false, reason: 'withdrawn' });
});

it('[AC-B1-02r#6][BR-AI-13] 撤回后重新同意放行，同一 reader 不缓存旧结论', async () => {
  const subject = await fixture();
  await record(subject, { accepted: false });
  const service = reader();
  expect(await service.check(subject)).toEqual({ allowed: false, reason: 'withdrawn' });
  await record(subject, { serverTick: 1 });
  expect(await service.check(subject)).toEqual({ allowed: true, version: VERSION });
  await record(subject, { accepted: false, serverTick: 2 });
  expect(await service.check(subject)).toEqual({ allowed: false, reason: 'withdrawn' });
});

it.each([
  { ac: 7, version: VERSION - 1 },
  { ac: 8, version: VERSION + 1 },
])(
  '[AC-B1-02r#$ac][BR-AI-13] 最新撤回版本 $version 不匹配仍优先返回 withdrawn',
  async ({ version }) => {
    const subject = await fixture();
    await record(subject);
    await record(subject, { accepted: false, version, serverTick: 1 });
    expect(await reader().check(subject)).toEqual({ allowed: false, reason: 'withdrawn' });
  },
);

it.each([
  { ac: 9, lastAccepted: false },
  { ac: 10, lastAccepted: true },
])(
  '[AC-B1-02r#$ac][BR-AI-13] server_at 相同，较大 id 的 accepted=$lastAccepted 决定结果',
  async ({ lastAccepted }) => {
    const subject = await fixture();
    const first = await record(subject, { accepted: !lastAccepted, clientTick: 9 });
    const last = await record(subject, { accepted: lastAccepted });
    expect(BigInt(last.id)).toBeGreaterThan(BigInt(first.id));
    expect(await reader().check(subject)).toEqual(
      lastAccepted ? { allowed: true, version: VERSION } : { allowed: false, reason: 'withdrawn' },
    );
  },
);

it('[AC-B1-02r#11][BR-AI-13] 登录用户不继承同设备的设备级 AI 同意', async () => {
  const subject = await fixture();
  await record({ ...subject, userId: null });
  expect(await reader().check(subject)).toEqual({ allowed: false, reason: 'missing' });
});

it('[AC-B1-02r#12][BR-AI-13] 登录用户已有用户级同意，设备级 AI 撤回不覆盖', async () => {
  const subject = await fixture();
  await record(subject);
  await record(subject, { subjectType: 'device', accepted: false, serverTick: 1 });
  expect(await reader().check(subject)).toEqual({ allowed: true, version: VERSION });
});

it('[AC-B1-02r#13][BR-AI-13] 登录用户换设备仍读取同一用户级同意', async () => {
  const subject = await fixture();
  await record(subject);
  expect(await reader().check({ ...subject, deviceId: randomUUID() })).toEqual({
    allowed: true,
    version: VERSION,
  });
});

it('[AC-B1-02r#14][BR-AI-13] 同 app 的其他用户级同意不算本用户同意', async () => {
  const subject = await fixture();
  await record(subject);
  expect(await reader().check({ ...subject, userId: randomUUID() })).toEqual({
    allowed: false,
    reason: 'missing',
  });
});

it('[AC-B1-02r#15][BR-AI-13] 游客只读取该设备的设备级同意', async () => {
  const subject = { ...(await fixture()), userId: null };
  await record(subject);
  expect(await reader().check(subject)).toEqual({ allowed: true, version: VERSION });
});

it('[AC-B1-02r#16][BR-AI-13] 游客不能使用带相同 device_id 的用户级同意', async () => {
  const subject = await fixture();
  await record(subject);
  expect(await reader().check({ ...subject, userId: null })).toEqual({
    allowed: false,
    reason: 'missing',
  });
});

it('[AC-B1-02r#17][BR-AI-13] 游客不能使用其他设备级同意', async () => {
  const subject = { ...(await fixture()), userId: null };
  await record(subject);
  expect(await reader().check({ ...subject, deviceId: randomUUID() })).toEqual({
    allowed: false,
    reason: 'missing',
  });
});

it('[AC-B1-02r#18][BR-AI-13] 游客设备级同意不受相同 device_id 用户级撤回影响', async () => {
  const subject = await fixture();
  await record({ ...subject, userId: null });
  await record(subject, { accepted: false, serverTick: 1 });
  expect(await reader().check({ ...subject, userId: null })).toEqual({
    allowed: true,
    version: VERSION,
  });
});

it.each([
  { ac: 19, guest: false },
  { ac: 20, guest: true },
])(
  '[AC-B1-02r#$ac][BR-AI-13] 其他 type 的较新记录不构成或覆盖 AI 同意（guest=$guest）',
  async ({ guest }) => {
    const loggedIn = await fixture();
    const subject = guest ? { ...loggedIn, userId: null } : loggedIn;
    await record(subject, { type: 'privacy', serverTick: 2 });
    await record(subject, { type: 'personalization', accepted: false, serverTick: 3 });
    await record(loggedIn, {
      subjectType: 'device',
      type: 'privacy',
      accepted: false,
      serverTick: 4,
    });
    const service = reader();
    expect(await service.check(subject)).toEqual({ allowed: false, reason: 'missing' });
    await record(subject);
    expect(await service.check(subject)).toEqual({ allowed: true, version: VERSION });
  },
);

it.each([
  { ac: 21, guest: false },
  { ac: 22, guest: true },
])(
  '[AC-B1-02r#$ac][BR-AI-13] 同一主体 ID 在另一个 appId 下不能放行（guest=$guest）',
  async ({ guest }) => {
    const loggedIn = await fixture();
    const subject = guest ? { ...loggedIn, userId: null } : loggedIn;
    await record(subject);
    const service = reader();
    expect(await service.check(subject)).toEqual({ allowed: true, version: VERSION });
    // IDs are globally unique and consent_records has composite tenant FKs. Query the
    // same IDs under another app instead of inserting impossible cross-tenant FK rows.
    expect(await service.check({ ...subject, appId: `other_${randomUUID()}` })).toEqual({
      allowed: false,
      reason: 'missing',
    });
  },
);

it('[AC-B1-02r#23][BR-AI-13] 版本源按每次调用的 appId 读取，升级后必须重新同意', async () => {
  const first = await fixture();
  const second = await fixture();
  await record(first);
  await record(second, { version: VERSION + 1 });
  const versions = new Map([
    [first.appId, VERSION],
    [second.appId, VERSION + 1],
  ]);
  const currentVersion = vi.fn(async (appId: string) => versions.get(appId)!);
  const service = reader({ currentVersion });
  expect(await service.check(first)).toEqual({ allowed: true, version: VERSION });
  expect(currentVersion).toHaveBeenLastCalledWith(first.appId);
  expect(await service.check(second)).toEqual({ allowed: true, version: VERSION + 1 });
  expect(currentVersion).toHaveBeenLastCalledWith(second.appId);
  versions.set(first.appId, VERSION + 1);
  expect(await service.check(first)).toEqual({ allowed: false, reason: 'outdated' });
  expect(currentVersion).toHaveBeenLastCalledWith(first.appId);
});

it('[AC-B1-02r#24][BR-AI-13] 版本源拒绝时 check 拒绝，不降级为业务判定', async () => {
  const subject = await fixture();
  await record(subject);
  const unavailable = new Error('synthetic version source unavailable');
  const service = reader({
    currentVersion: async () => {
      throw unavailable;
    },
  });
  await expect(service.check(subject)).rejects.toThrow();
});

it.each([
  { ac: 25, value: 0 },
  { ac: 26, value: -1 },
  { ac: 27, value: 1.5 },
  { ac: 28, value: NaN },
  { ac: 29, value: '3' },
  { ac: 30, value: null },
  { ac: 31, value: Infinity },
])(
  '[AC-B1-02r#$ac][BR-AI-13] 非法当前版本 $value 必须拒绝，不能放行或返回 missing',
  async ({ value }) => {
    const subject = await fixture();
    // Cast only at the deliberately broken external configuration boundary.
    const service = reader({ currentVersion: async () => value as number });
    await expect(service.check(subject)).rejects.toThrow();
    await record(subject);
    await expect(service.check(subject)).rejects.toThrow();
  },
);

it('[AC-B1-02r#32][BR-AI-13] 连接池关闭后 check 拒绝，不能伪装成 missing', async () => {
  const subject = await fixture();
  await record(subject);
  const closed = createDb({ connectionString: database!.urlFor('couli_app') });
  try {
    const service = reader({ db: closed });
    await destroyDb(closed);
    await expect(service.check(subject)).rejects.toThrow();
  } finally {
    await destroyDb(closed);
  }
});

async function snapshot() {
  // Full row contents (including multiplicity), not just counts. All business tables,
  // plus the queue, catch unintended writes. Read partitions through their parent:
  // couli_app has parent SELECT grants, not direct grants on every child partition.
  const tables = await sql<{ schemaname: string; tablename: string }>`
    SELECT n.nspname AS schemaname, c.relname AS tablename
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('app', 'pgboss') AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
    ORDER BY n.nspname, c.relname
  `.execute(seedDb);
  const result: Record<string, string[]> = {};
  for (const { schemaname, tablename } of tables.rows) {
    const rows = await sql<{ row: string }>`
      SELECT to_jsonb(t)::text AS row FROM ${sql.id(schemaname, tablename)} AS t
      ORDER BY to_jsonb(t)::text
    `.execute(seedDb);
    result[`${schemaname}.${tablename}`] = rows.rows.map(({ row }) => row);
  }
  return result;
}

it('[AC-B1-02r#33][BR-AI-13] 所有判定只读：同意历史及其他业务表内容、行数不变', async () => {
  const missing = await fixture();
  const allowed = await fixture();
  const withdrawn = await fixture();
  const outdated = await fixture();
  await record(allowed);
  await record(withdrawn);
  await record(withdrawn, { accepted: false, serverTick: 1 });
  await record(outdated, { version: VERSION - 1 });
  const before = await snapshot();
  const service = reader();
  expect(await service.check(missing)).toEqual({ allowed: false, reason: 'missing' });
  expect(await service.check(allowed)).toEqual({ allowed: true, version: VERSION });
  expect(await service.check(withdrawn)).toEqual({ allowed: false, reason: 'withdrawn' });
  expect(await service.check(outdated)).toEqual({ allowed: false, reason: 'outdated' });
  expect(await snapshot()).toEqual(before);
});

it('[AC-B1-02r#34][BR-AI-13] 随机历史按主体和类型过滤后，以 (server_at,id) 最新记录判定', async () => {
  let injectedVersion = VERSION;
  const service = reader({ currentVersion: async () => injectedVersion });
  await fc.assert(
    fc.asyncProperty(
      fc.boolean(),
      fc.integer({ min: 1, max: 5 }),
      fc.array(
        fc.record({
          subjectType: fc.constantFrom('user' as const, 'device' as const),
          type: fc.constantFrom(
            'ai_third_party' as const,
            'privacy' as const,
            'personalization' as const,
          ),
          accepted: fc.boolean(),
          version: fc.integer({ min: 1, max: 5 }),
          // Small range deliberately generates duplicate timestamps and out-of-order arrivals.
          serverTick: fc.integer({ min: 0, max: 3 }),
          clientTick: fc.integer({ min: 0, max: 9 }),
        }),
        { minLength: 0, maxLength: 16 },
      ),
      async (guest, current, history) => {
        const owner = await fixture();
        const subject = guest ? { ...owner, userId: null } : owner;
        const inserted = [];
        for (const entry of history) inserted.push(await record(owner, entry));
        const candidates = inserted.filter(
          (row) =>
            row.app_id === subject.appId &&
            row.type === 'ai_third_party' &&
            (guest
              ? row.subject_type === 'device' && row.device_id === subject.deviceId
              : row.subject_type === 'user' && row.user_id === subject.userId),
        );
        candidates.sort((a, b) => {
          const byTime = a.server_at.getTime() - b.server_at.getTime();
          if (byTime !== 0) return byTime;
          return BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
        });
        const latest = candidates.at(-1);
        const expected: AiConsentVerdict =
          latest === undefined
            ? { allowed: false, reason: 'missing' }
            : !latest.accepted
              ? { allowed: false, reason: 'withdrawn' }
              : latest.version !== current
                ? { allowed: false, reason: 'outdated' }
                : { allowed: true, version: current };
        injectedVersion = current;
        expect(await service.check(subject)).toEqual(expected);
      },
    ),
    propParams(),
  );
}, 600_000);
