import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  UserLevel,
  UserLevelSubject,
} from '../../../../apps/api/src/modules/identity/ports/user-level.ts';

// Runtime URL import keeps the API's Nest decorators out of the test TS project,
// while exercising the public module export. Type-only imports are erased.
const { createUserLevelReader } = (await import(
  new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/identity/ports/user-level.ts');
const { FixedClock } = await import('../../../../apps/api/src/modules/platform/clock/index.ts');

const clock = new FixedClock('2026-10-16T00:00:00.000Z');
const PRIVATE_NICKNAME = 'synthetic-private-nickname';
const PRIVATE_PHONE = 'synthetic-phone-cipher';
const PRIVATE_HMAC = 'synthetic-phone-hmac';
let database: TestDatabase | undefined;
let db: Kysely<DB>;

beforeAll(async () => {
  // The integration global setup supplies the admin connection; each file gets a fresh clone.
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

async function fixture(
  level: string,
  status = 'normal',
  subject: UserLevelSubject = { appId: `user_level_${randomUUID()}`, userId: randomUUID() },
): Promise<UserLevelSubject> {
  await db
    .insertInto('users')
    .values({
      id: subject.userId,
      app_id: subject.appId,
      nickname: PRIVATE_NICKNAME,
      avatar: 'https://example.invalid/avatar.png',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      phone_cipher: Buffer.from(PRIVATE_PHONE),
      phone_hmac: `${PRIVATE_HMAC}_${subject.userId}`,
      level,
      status,
      register_method: 'sms',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  return subject;
}

// Construct inside each test and outside rejection assertions: the synchronous
// NotImplemented factory must also make the error-path tests red.
it.each([
  { ac: 1, level: 'L1' },
  { ac: 2, level: 'L2' },
  { ac: 3, level: 'L3' },
] as const)('[AC-B1-02u#$ac] $level 按契约等级原样返回', async ({ level }) => {
  const subject = await fixture(level);
  const reader = createUserLevelReader({ db });
  const result: UserLevel | null = await reader.levelOf(subject);
  expect(result).toBe(level);
});

it('[AC-B1-02u#4] 同 app 有其他用户时，查不到指定 userId 返回 null', async () => {
  const other = await fixture('L3');
  const reader = createUserLevelReader({ db });
  expect(await reader.levelOf({ ...other, userId: randomUUID() })).toBeNull();
});

it('[AC-B1-02u#5] 同一个 userId 在别的 app 不可见，查询顺序不造成串租户', async () => {
  const owner = await fixture('L2');
  const other = await fixture('L3');
  const reader = createUserLevelReader({ db });
  const foreign = { ...owner, appId: other.appId };
  // users.id is globally unique: do not seed impossible duplicate primary keys.
  expect(await reader.levelOf(foreign)).toBeNull();
  expect(await reader.levelOf(owner)).toBe('L2');
  expect(await reader.levelOf(foreign)).toBeNull();
  expect(await reader.levelOf(other)).toBe('L3');
});

it.each([
  { ac: 6, status: 'deleting' },
  { ac: 7, status: 'deleted' },
])('[AC-B1-02u#$ac] status=$status 仍返回等级', async ({ status }) => {
  const subject = await fixture('L3', status);
  const reader = createUserLevelReader({ db });
  expect(await reader.levelOf(subject)).toBe('L3');
});

it('[AC-B1-02u#8] 风控封禁用户仍返回等级，是否报价由调用方决定', async () => {
  const subject = await fixture('L2');
  // Bans live in user_risk_state, not users.status (0005 identity baseline).
  await db
    .insertInto('user_risk_state')
    .values({
      user_id: subject.userId,
      app_id: subject.appId,
      state: 'banned',
      reason_category: 'other',
      changed_by: 'synthetic-test',
      changed_at: clock.now(),
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  const reader = createUserLevelReader({ db });
  expect(await reader.levelOf(subject)).toBe('L2');
});

it.each([
  { ac: 9, invalid: 'L4' },
  { ac: 10, invalid: 'l1' },
  { ac: 11, invalid: ' L2 ' },
  { ac: 12, invalid: '' },
  { ac: 13, invalid: 'logged_in' },
])('[AC-B1-02u#$ac] 非法等级 "$invalid" 抛错且不回落、不泄漏用户字段', async ({ invalid }) => {
  const subject = await fixture(invalid);
  const reader = createUserLevelReader({ db });
  const error: unknown = await reader.levelOf(subject).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain(invalid);
  expect(message).not.toContain(PRIVATE_NICKNAME);
  expect(message).not.toContain(PRIVATE_PHONE);
  expect(message).not.toContain(Buffer.from(PRIVATE_PHONE).toString('hex'));
  expect(message).not.toContain(PRIVATE_HMAC);
});

it('[AC-B1-02u#14] 数据库连接关闭后仍抛原始错误，不转成 null 或默认等级', async () => {
  const subject = await fixture('L1');
  const closed = createDb({ connectionString: database!.urlFor('couli_app') });
  try {
    const reader = createUserLevelReader({ db: closed });
    await sql`SELECT 1`.execute(closed);
    await destroyDb(closed);
    // Compare to this installed driver's actual failure, not a hard-coded message.
    const original: unknown = await closed
      .selectFrom('users')
      .select('level')
      .execute()
      .catch((cause: unknown) => cause);
    expect(original).toBeInstanceOf(Error);
    await expect(reader.levelOf(subject)).rejects.toThrow((original as Error).message);
  } finally {
    await destroyDb(closed);
  }
});

it('[AC-B1-02u#15] 同一 reader 每次读取最新等级，非法新值也不能使用旧缓存', async () => {
  const subject = await fixture('L1');
  const reader = createUserLevelReader({ db });
  expect(await reader.levelOf(subject)).toBe('L1');
  for (const level of ['L3', 'L2', 'L1', 'invalid-after-update']) {
    await db
      .updateTable('users')
      .set({ level })
      .where('app_id', '=', subject.appId)
      .where('id', '=', subject.userId)
      .execute();
    if (level === 'invalid-after-update') {
      await expect(reader.levelOf(subject)).rejects.toThrow(level);
    } else {
      expect(await reader.levelOf(subject)).toBe(level);
    }
  }
});

it('[AC-B1-02u#16] 不缓存缺失结果或已删除用户的等级', async () => {
  const subject = { appId: `user_level_${randomUUID()}`, userId: randomUUID() };
  const reader = createUserLevelReader({ db });
  expect(await reader.levelOf(subject)).toBeNull();
  await fixture('L2', 'normal', subject);
  expect(await reader.levelOf(subject)).toBe('L2');
  await db
    .deleteFrom('users')
    .where('app_id', '=', subject.appId)
    .where('id', '=', subject.userId)
    .execute();
  expect(await reader.levelOf(subject)).toBeNull();
});

it('[AC-B1-02u#17] 存在、缺失和非法等级均只查一次，在只读事务中不写任何表', async () => {
  const valid = await fixture('L3');
  const invalid = await fixture('invalid-readonly');
  const missing = { ...valid, userId: randomUUID() };
  await db
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      let queries = 0;
      const observer: KyselyPlugin = {
        transformQuery({ node }) {
          queries += 1;
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      };
      const reader = createUserLevelReader({ db: trx.withPlugin(observer) });
      expect(queries).toBe(0);
      expect(await reader.levelOf(valid)).toBe('L3');
      expect(queries).toBe(1);
      expect(await reader.levelOf(missing)).toBeNull();
      expect(queries).toBe(2);
      await expect(reader.levelOf(invalid)).rejects.toThrow('invalid-readonly');
      expect(queries).toBe(3);
      // A swallowed write error would leave the read-only transaction aborted.
      const probe = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(trx);
      expect(probe.rows).toEqual([{ ok: 1 }]);
    });
});
