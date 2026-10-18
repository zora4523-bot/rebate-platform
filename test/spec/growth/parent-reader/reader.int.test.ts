import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  ParentRelation,
  ParentRelationReader,
  ParentRelationReaderOptions,
  ParentRelationSubject,
} from '../../../../apps/api/src/modules/growth/index.ts';

const { createParentRelationReader } =
  await import('../../../../apps/api/src/modules/growth/index.ts');
const { FixedClock } = await import('../../../../apps/api/src/modules/platform/clock/index.ts');

// B1-11n §9.2 defines the current-row projection; no historical log is required.
const clock = new FixedClock('2026-10-18T01:02:03.456Z');
const boundAt = new FixedClock('2026-10-17T23:59:59.123+08:00').now();
const reboundAt = new FixedClock('2026-10-18T00:00:00.789+08:00').now();
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

function newSubject(appId = `parent_reader_${randomUUID()}`): ParentRelationSubject {
  return { appId, userId: randomUUID() };
}

async function seedUser(
  subject: ParentRelationSubject,
  parentId: string | null = null,
  parentBoundAt: Date | null = null,
  status = 'normal',
): Promise<ParentRelationSubject> {
  await db
    .insertInto('users')
    .values({
      id: subject.userId,
      app_id: subject.appId,
      nickname: 'synthetic-private-nickname',
      avatar: 'https://example.invalid/private-avatar.png',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      phone_cipher: Buffer.from('synthetic-private-phone'),
      phone_hmac: randomUUID(),
      level: 'L1',
      status,
      parent_id: parentId,
      parent_bound_at: parentBoundAt,
      parent_bind_source: parentId === null ? null : 'landing',
      register_method: 'sms',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  return subject;
}

async function family(status = 'normal') {
  const parent = await seedUser(newSubject());
  const child = await seedUser(newSubject(parent.appId), parent.userId, boundAt, status);
  return { parent, child };
}

async function changeParent(
  subject: ParentRelationSubject,
  parentId: string | null,
  parentBoundAt: Date | null,
): Promise<void> {
  await db
    .updateTable('users')
    .set({ parent_id: parentId, parent_bound_at: parentBoundAt })
    .where('app_id', '=', subject.appId)
    .where('id', '=', subject.userId)
    .execute();
}

// Construct inside every test, outside rejection assertions: even error-path tests
// must fail on the synchronous NotImplemented factory in the test phase.
it('[AC-B1-11n#1] 有上级时返回 true 和原绑定时刻，保留毫秒且不依赖关系日志', async () => {
  const options: ParentRelationReaderOptions = { db };
  const reader: ParentRelationReader = createParentRelationReader(options);
  const { child } = await family();
  const result: ParentRelation | null = await reader.relationOf(child);
  expect(result).toStrictEqual({ has_parent: true, parent_bound_at: boundAt });
  expect(result?.parent_bound_at).toBeInstanceOf(Date);
});

it('[AC-B1-11n#2] 无上级的已存在用户返回 false 和 null，与查不到用户区分', async () => {
  const reader = createParentRelationReader({ db });
  const subject = await seedUser(newSubject());
  expect(await reader.relationOf(subject)).toStrictEqual({
    has_parent: false,
    parent_bound_at: null,
  });
});

it('[AC-B1-11n#3] 同应用有其他用户，指定 userId 不存在时返回 null', async () => {
  const reader = createParentRelationReader({ db });
  const { child } = await family();
  expect(await reader.relationOf(newSubject(child.appId))).toBeNull();
});

it('[AC-B1-11n#4] 同 id 在其他 app_id 下不可见，交替查询不串应用或用户', async () => {
  const reader = createParentRelationReader({ db });
  const { child } = await family();
  const other = await seedUser(newSubject());
  // users.id is globally unique; seed no impossible duplicate primary keys.
  const foreign = { appId: other.appId, userId: child.userId };
  expect(await reader.relationOf(foreign)).toBeNull();
  expect(await reader.relationOf(child)).toStrictEqual({
    has_parent: true,
    parent_bound_at: boundAt,
  });
  expect(await reader.relationOf(foreign)).toBeNull();
  expect(await reader.relationOf(other)).toStrictEqual({
    has_parent: false,
    parent_bound_at: null,
  });
});

it('[AC-B1-11n#5] parent_id 为空但绑定时刻非空的脏数据归一为 false 和 null', async () => {
  const reader = createParentRelationReader({ db });
  const subject = await seedUser(newSubject(), null, boundAt);
  expect(await reader.relationOf(subject)).toStrictEqual({
    has_parent: false,
    parent_bound_at: null,
  });
  // Normalization is a read projection, never a repair write.
  expect(
    await db
      .selectFrom('users')
      .select('parent_bound_at')
      .where('id', '=', subject.userId)
      .executeTakeFirstOrThrow(),
  ).toStrictEqual({ parent_bound_at: boundAt });
});

it('[AC-B1-11n#6] parent_id 非空而时刻为空时仍有上级，原样保留 null 时刻', async () => {
  const reader = createParentRelationReader({ db });
  const parent = await seedUser(newSubject());
  const child = await seedUser(newSubject(parent.appId), parent.userId, null);
  expect(await reader.relationOf(child)).toStrictEqual({
    has_parent: true,
    parent_bound_at: null,
  });
});

it('[AC-B1-11n#7] 返回对象恰有两个字段，不泄露上级或用户身份字段', async () => {
  const reader = createParentRelationReader({ db });
  const { parent, child } = await family();
  for (const subject of [child, parent]) {
    const result = await reader.relationOf(subject);
    expect(result).not.toBeNull();
    expect(Reflect.ownKeys(result!)).toEqual(
      expect.arrayContaining(['has_parent', 'parent_bound_at']),
    );
    expect(Reflect.ownKeys(result!)).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(parent.userId);
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
  }
});

it.each([
  { ac: 8, status: 'deleting' },
  { ac: 9, status: 'deleted' },
])('[AC-B1-11n#$ac] status=$status 仍返回当前关系', async ({ status }) => {
  const reader = createParentRelationReader({ db });
  const { child } = await family(status);
  expect(await reader.relationOf(child)).toStrictEqual({
    has_parent: true,
    parent_bound_at: boundAt,
  });
});

it.each([
  { ac: 10, state: 'banned' },
  { ac: 11, state: 'frozen' },
  { ac: 12, state: 'appealing' },
])('[AC-B1-11n#$ac] 风控状态 $state 不过滤当前关系', async ({ state }) => {
  const reader = createParentRelationReader({ db });
  const { child } = await family();
  await db
    .insertInto('user_risk_state')
    .values({
      user_id: child.userId,
      app_id: child.appId,
      state,
      reason_category: 'other',
      changed_by: 'synthetic-test',
      changed_at: clock.now(),
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  expect(await reader.relationOf(child)).toStrictEqual({
    has_parent: true,
    parent_bound_at: boundAt,
  });
});

it('[AC-B1-11n#13] 同一 reader 对绑定、换绑和解绑的下一次读取立即反映变化', async () => {
  const reader = createParentRelationReader({ db });
  const parent = await seedUser(newSubject());
  const secondParent = await seedUser(newSubject(parent.appId));
  const child = await seedUser(newSubject(parent.appId));
  expect(await reader.relationOf(child)).toStrictEqual({
    has_parent: false,
    parent_bound_at: null,
  });
  await changeParent(child, parent.userId, boundAt);
  expect(await reader.relationOf(child)).toStrictEqual({
    has_parent: true,
    parent_bound_at: boundAt,
  });
  await changeParent(child, secondParent.userId, reboundAt);
  expect(await reader.relationOf(child)).toStrictEqual({
    has_parent: true,
    parent_bound_at: reboundAt,
  });
  await changeParent(child, null, null);
  expect(await reader.relationOf(child)).toStrictEqual({
    has_parent: false,
    parent_bound_at: null,
  });
});

it('[AC-B1-11n#14] 缺失结果不缓存，新增和删除用户后下一次读取立即可见', async () => {
  const reader = createParentRelationReader({ db });
  const subject = newSubject();
  expect(await reader.relationOf(subject)).toBeNull();
  await seedUser(subject);
  expect(await reader.relationOf(subject)).toStrictEqual({
    has_parent: false,
    parent_bound_at: null,
  });
  await db
    .deleteFrom('users')
    .where('app_id', '=', subject.appId)
    .where('id', '=', subject.userId)
    .execute();
  expect(await reader.relationOf(subject)).toBeNull();
});

it('[AC-B1-11n#15] 只读事务中每次调用恰查询一次，重复查询也不使用缓存', async () => {
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
      const reader = createParentRelationReader({ db: trx.withPlugin(observer) });
      expect(queries).toBe(0);
      // Fixtures use the separate pool, outside the read-only transaction.
      const { child, parent } = await family();
      const dirty = await seedUser(newSubject(), null, boundAt);
      const cases = [
        { subject: child, expected: { has_parent: true, parent_bound_at: boundAt } },
        { subject: parent, expected: { has_parent: false, parent_bound_at: null } },
        { subject: dirty, expected: { has_parent: false, parent_bound_at: null } },
        { subject: newSubject(child.appId), expected: null },
      ];
      let calls = 0;
      for (const { subject, expected } of [...cases, ...cases]) {
        expect(await reader.relationOf(subject)).toStrictEqual(expected);
        calls += 1;
        expect(queries).toBe(calls);
      }
      // A swallowed write failure must not leave the transaction aborted.
      const probe = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(trx);
      expect(probe.rows).toEqual([{ ok: 1 }]);
    });
});

it('[AC-B1-11n#16] 数据访问错误按同一对象抛出，不吞错、包装或回退为无上级', async () => {
  const original = Object.assign(new Error('synthetic database failure'), { code: '08006' });
  const failure: KyselyPlugin = {
    transformQuery() {
      throw original;
    },
    async transformResult({ result }) {
      return result;
    },
  };
  const reader = createParentRelationReader({ db: db.withPlugin(failure) });
  await expect(reader.relationOf(newSubject())).rejects.toBe(original);
});
