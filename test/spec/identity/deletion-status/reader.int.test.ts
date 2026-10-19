import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely, type KyselyPlugin, type Transaction } from 'kysely';
import { afterAll, beforeAll, expect, expectTypeOf, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

// Observe the sanctioned logger, including child bindings, without adding a logger parameter
// to the public port. All database reads below still execute against real PostgreSQL.
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

// Exercise identity/index.ts at runtime; the URL import keeps Nest decorators out of the
// test TS project, as in the other identity reader suites. The type query is erased.
const { createUserDeletionStatusReader } = (await import(
  new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/identity/ports/user-deletion-status.ts');

// Scope: task B1-02ze §9.2 with §10's corrected mapping: users.status=deleting is processing.
// No deletion_requests fixture is invented before B1-15.
const clock = new FixedClock('2026-10-20T00:00:00.000Z');
let database: TestDatabase | undefined;
let db: Kysely<DB>;

beforeAll(async () => {
  // Shared integration globalSetup reads TEST_PG_ADMIN_URL and supplies a migrated template.
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
  return `deletion_status_${randomUUID()}`;
}

async function user(
  executor: Kysely<DB> | Transaction<DB>,
  app: string,
  status: string,
): Promise<string> {
  const id = randomUUID();
  await executor
    .withSchema('app')
    .insertInto('users')
    .values({
      id,
      app_id: app,
      nickname: 'synthetic-private-nickname',
      avatar: 'https://example.invalid/avatar.png',
      phone_cipher: Buffer.from('synthetic-private-phone'),
      phone_hmac: `synthetic-private-hmac_${id}`,
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      status,
      register_method: 'sms',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  return id;
}

function observe(executor: Kysely<DB> | Transaction<DB>) {
  const statements: string[] = [];
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      // Compile through the underlying executor without recursively invoking this observer.
      statements.push(executor.getExecutor().compileQuery(node, queryId).sql);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
  return { executor: executor.withPlugin(plugin), statements };
}

// Every test constructs the real factory inside its body (outside rejection assertions),
// so the test-phase skeleton fails with NotImplemented rather than passing an error-path test.
it.each([
  { ac: 1, status: 'normal', expected: 'none' },
  { ac: 2, status: 'deleted', expected: 'done' },
  { ac: 3, status: 'deleting', expected: 'processing' },
  { ac: 15, status: 'synthetic_other_status', expected: 'none' },
] as const)(
  '[AC-B1-02ze#$ac] users.status=$status 映射为 $expected',
  async ({ status, expected }) => {
    const reader = createUserDeletionStatusReader({ db });
    const app = appId();
    const id = await user(db, app, status);
    const result = await reader.read(db, { app_id: app, user_ids: [id] });
    expectTypeOf(result).toEqualTypeOf<ReadonlyMap<string, 'none' | 'processing' | 'done'>>();
    expect(result).toEqual(new Map([[id, expected]]));
  },
);

it.each([
  { ac: 13, state: 'banned' },
  { ac: 14, state: 'frozen' },
] as const)('[AC-B1-02ze#$ac] 风控状态 $state 不属于注销，返回 none', async ({ state }) => {
  const reader = createUserDeletionStatusReader({ db });
  const app = appId();
  const id = await user(db, app, 'normal');
  // Risk writes bans and freezes to user_risk_state, leaving users.status normal.
  await db
    .withSchema('app')
    .insertInto('user_risk_state')
    .values({
      user_id: id,
      app_id: app,
      state,
      reason_category: 'other',
      changed_by: 'synthetic-test',
      changed_at: clock.now(),
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  expect(await reader.read(db, { app_id: app, user_ids: [id] })).toEqual(new Map([[id, 'none']]));
});

it('[AC-B1-02ze#4] 批量结果只含命中的请求 ID，缺失项不补 none 或 done', async () => {
  const reader = createUserDeletionStatusReader({ db });
  const app = appId();
  const normal = await user(db, app, 'normal');
  const deleted = await user(db, app, 'deleted');
  const unrequested = await user(db, app, 'normal');
  const missing = randomUUID();
  const result = await reader.read(db, {
    app_id: app,
    user_ids: [missing, deleted, normal],
  });
  expect(result).toEqual(
    new Map([
      [normal, 'none'],
      [deleted, 'done'],
    ]),
  );
  expect(result.has(missing)).toBe(false);
  expect(result.has(unrequested)).toBe(false);
  expect(await reader.read(db, { app_id: app, user_ids: [missing] })).toEqual(new Map());
});

it('[AC-B1-02ze#5] 同一 ID 在其他 app 不可见，交错批量查询不串应用', async () => {
  const reader = createUserDeletionStatusReader({ db });
  const a = appId();
  const b = appId();
  // users.id is globally unique; query each existing ID under both apps instead of duplicating PKs.
  const aId = await user(db, a, 'normal');
  const bId = await user(db, b, 'deleted');
  const user_ids = [aId, bId];
  expect(await reader.read(db, { app_id: a, user_ids })).toEqual(new Map([[aId, 'none']]));
  expect(await reader.read(db, { app_id: b, user_ids })).toEqual(new Map([[bId, 'done']]));
  expect(await reader.read(db, { app_id: a, user_ids: [bId] })).toEqual(new Map());
  expect(await reader.read(db, { app_id: b, user_ids: [aId] })).toEqual(new Map());
  expect(await reader.read(db, { app_id: a, user_ids })).toEqual(new Map([[aId, 'none']]));
});

it('[AC-B1-02ze#6] 重复 ID 只出现一次，接受只读 ID 数组', async () => {
  const reader = createUserDeletionStatusReader({ db });
  const app = appId();
  const normal = await user(db, app, 'normal');
  const deleted = await user(db, app, 'deleted');
  const missing = randomUUID();
  const user_ids = Object.freeze([normal, deleted, normal, missing, deleted, missing]);
  expect(await reader.read(db, { app_id: app, user_ids })).toEqual(
    new Map([
      [normal, 'none'],
      [deleted, 'done'],
    ]),
  );
});

it('[AC-B1-02ze#7] 空数组返回空 Map，构造和读取均不向 db 或 executor 发 SQL', async () => {
  const factory = observe(db);
  const caller = observe(db);
  const reader = createUserDeletionStatusReader({ db: factory.executor });
  expect(await reader.read(caller.executor, { app_id: appId(), user_ids: [] })).toEqual(new Map());
  expect(factory.statements).toEqual([]);
  expect(caller.statements).toEqual([]);
});

it('[AC-B1-02ze#8] 普通 Kysely executor 执行一条批量查询，构造参数 db 不执行查询', async () => {
  const app = appId();
  const normal = await user(db, app, 'normal');
  const deleted = await user(db, app, 'deleted');
  const factory = observe(db);
  const caller = observe(db);
  const reader = createUserDeletionStatusReader({ db: factory.executor });
  expect(await reader.read(caller.executor, { app_id: app, user_ids: [normal, deleted] })).toEqual(
    new Map([
      [normal, 'none'],
      [deleted, 'done'],
    ]),
  );
  expect(factory.statements).toEqual([]);
  expect(caller.statements).toHaveLength(1);
});

it('[AC-B1-02ze#9] 看得见调用方事务未提交的插入，回滚后用户消失', async () => {
  const reader = createUserDeletionStatusReader({ db });
  const app = appId();
  const rollback = new Error('synthetic caller rollback');
  let inserted = '';
  await expect(
    db.transaction().execute(async (trx) => {
      inserted = await user(trx, app, 'normal');
      // An independent connection cannot see this row yet.
      expect(
        await db.selectFrom('users').select('id').where('id', '=', inserted).execute(),
      ).toEqual([]);
      expect(await reader.read(trx, { app_id: app, user_ids: [inserted] })).toEqual(
        new Map([[inserted, 'none']]),
      );
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await reader.read(db, { app_id: app, user_ids: [inserted] })).toEqual(new Map());
});

it('[AC-B1-02ze#10] 同一 reader 看得见事务未提交的状态更新，回滚后重新读到 none', async () => {
  const reader = createUserDeletionStatusReader({ db });
  const app = appId();
  const id = await user(db, app, 'normal');
  const input = { app_id: app, user_ids: [id] };
  expect(await reader.read(db, input)).toEqual(new Map([[id, 'none']]));
  const rollback = new Error('synthetic caller rollback');
  await expect(
    db.transaction().execute(async (trx) => {
      await trx.updateTable('users').set({ status: 'deleted' }).where('id', '=', id).execute();
      expect(await reader.read(db, input)).toEqual(new Map([[id, 'none']]));
      expect(await reader.read(trx, input)).toEqual(new Map([[id, 'done']]));
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await reader.read(db, input)).toEqual(new Map([[id, 'none']]));
});

it('[AC-B1-02ze#11] 只读事务中每次只查一次 app.users 的 id、status，不写表也不加锁', async () => {
  const app = appId();
  const normal = await user(db, app, 'normal');
  const deleted = await user(db, app, 'deleted');
  const factory = observe(db);
  const reader = createUserDeletionStatusReader({ db: factory.executor });
  await db
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      const caller = observe(trx);
      const cases = [
        {
          app_id: app,
          user_ids: [normal, deleted],
          expected: new Map([
            [normal, 'none'],
            [deleted, 'done'],
          ]),
        },
        { app_id: app, user_ids: [randomUUID()], expected: new Map() },
        { app_id: appId(), user_ids: [normal, deleted], expected: new Map() },
      ];
      for (const { expected, ...input } of cases) {
        expect(await reader.read(caller.executor, input)).toEqual(expected);
      }
      expect(caller.statements).toHaveLength(cases.length);
      for (const statement of caller.statements) {
        const query = statement.replaceAll('"', '').replace(/\s+/g, ' ').trim();
        // Allow either column order and optional table qualification, but no SELECT * or PII.
        const projection = /^select (.*?) from app\.users\b/i.exec(query)?.[1];
        expect(projection).toBeDefined();
        expect(
          projection
            ?.split(',')
            .map((column) => column.trim().split('.').at(-1))
            .sort(),
        ).toEqual(['id', 'status']);
        expect(query).not.toMatch(/\b(?:insert|update|delete|merge|for\s+(?:share|key|no))\b/i);
      }
      // Detect a swallowed write / row-lock error that left PostgreSQL's transaction aborted.
      expect((await sql<{ ok: number }>`SELECT 1 AS ok`.execute(trx)).rows).toEqual([{ ok: 1 }]);
    });
  expect(factory.statements).toEqual([]);
});

it('[AC-B1-02ze#12] 构造和各读取分支均不写应用日志', async () => {
  const app = appId();
  const normal = await user(db, app, 'normal');
  const deleted = await user(db, app, 'deleted');
  logging.write.mockClear();
  const reader = createUserDeletionStatusReader({ db });
  expect(await reader.read(db, { app_id: app, user_ids: [normal, deleted] })).toEqual(
    new Map([
      [normal, 'none'],
      [deleted, 'done'],
    ]),
  );
  expect(await reader.read(db, { app_id: app, user_ids: [randomUUID()] })).toEqual(new Map());
  expect(await reader.read(db, { app_id: appId(), user_ids: [normal] })).toEqual(new Map());
  expect(await reader.read(db, { app_id: app, user_ids: [] })).toEqual(new Map());
  expect(logging.write).not.toHaveBeenCalled();
});
