import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, expectTypeOf, it, vi } from 'vitest';
import type { DeletionStage } from '../../../../apps/api/src/modules/identity/ports/deletion-stage.ts';
import { cancel, identity, observe, request, user } from './kit.ts';

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
vi.mock('../../../../apps/api/src/modules/platform/logging/logger.ts', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createRootLogger: vi.fn(() => logging.logger),
}));

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 120_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

// Explicit independent expectations: no production mapping function computes the oracle.
it.each([
  { status: 'normal', expected: ['none', 'cooling', 'processing', 'done', 'none'] },
  {
    status: 'deleting',
    expected: ['processing', 'processing', 'processing', 'done', 'processing'],
  },
  { status: 'deleted', expected: ['done', 'done', 'done', 'done', 'done'] },
  { status: 'synthetic_other', expected: ['none', 'cooling', 'processing', 'done', 'none'] },
] as const)(
  '[AC-B1-15c#1] users=$status 与无单及四种注销单的完整组合',
  async ({ status, expected }) => {
    const reader = (await identity()).createDeletionStageReader({ db });
    const appId = randomUUID();
    const ids: string[] = [];
    for (const stage of [null, 'cooling', 'processing', 'done', 'cancelled'] as const) {
      const id = await user(db, appId, status);
      ids.push(id);
      if (stage !== null) await request(db, appId, id, stage);
    }
    const result = await reader.read(db, { appId, userIds: ids });
    expectTypeOf(result).toEqualTypeOf<ReadonlyMap<string, DeletionStage>>();
    expectTypeOf<DeletionStage>().toEqualTypeOf<'none' | 'cooling' | 'processing' | 'done'>();
    expect(result).toEqual(new Map(ids.map((id, i) => [id, expected[i]])));
  },
);

it('[AC-B1-15c#2] 历史取消不遮盖新单；未结束单优先于历史 done，否则 done 不被较新的取消遮盖', async () => {
  const reader = (await identity()).createDeletionStageReader({ db });
  const appId = randomUUID();
  const ids = [];
  for (const stages of [
    ['cancelled', 'cooling'],
    ['done', 'cooling'],
    ['done', 'processing'],
    ['done', 'cancelled'],
    ['cancelled', 'cancelled'],
  ] as const) {
    const id = await user(db, appId);
    ids.push(id);
    for (const [i, stage] of stages.entries()) {
      await request(db, appId, id, stage, new Date(`2026-09-${i === 0 ? '01' : '10'}T00:00:00Z`));
    }
  }
  expect(await reader.read(db, { appId, userIds: ids })).toEqual(
    new Map(ids.map((id, i) => [id, ['cooling', 'cooling', 'processing', 'done', 'none'][i]])),
  );
});

it('[AC-B1-15c#3] 空数组零查询，重复 ID 去重，缺失及未请求用户不出现在结果中', async () => {
  const factory = observe(db);
  const reader = (await identity()).createDeletionStageReader({ db: factory.executor });
  const appId = randomUUID();
  const id = await user(db, appId);
  await request(db, appId, id, 'cooling');
  const unused = await user(db, appId, 'deleted');
  const missing = randomUUID();
  const caller = observe(db);
  expect(await reader.read(caller.executor, { appId, userIds: [] })).toEqual(new Map());
  expect(caller.statements).toEqual([]);
  const ids = Object.freeze([id, missing, id, missing]);
  const result = await reader.read(caller.executor, { appId, userIds: ids });
  expect(result).toEqual(new Map([[id, 'cooling']]));
  expect(result.size).toBe(1);
  expect(result.has(unused)).toBe(false);
  expect(caller.statements).toHaveLength(1);
  expect(await reader.read(caller.executor, { appId, userIds: [missing] })).toEqual(new Map());
  expect(factory.statements).toEqual([]);
});

it('[AC-B1-15c#4] 同一个查询 ID 换 app 不可见，批量交错读取不串用户或注销单', async () => {
  const reader = (await identity()).createDeletionStageReader({ db });
  const a = randomUUID();
  const b = randomUUID();
  // users.id is globally unique (users_pkey); duplicate rows with the same id are invalid.
  // Query the SAME id under both app IDs instead of violating that schema constraint.
  const aId = await user(db, a);
  const bId = await user(db, b);
  await request(db, a, aId, 'cooling');
  await request(db, b, bId, 'done');
  expect(await reader.read(db, { appId: a, userIds: [aId, bId] })).toEqual(
    new Map([[aId, 'cooling']]),
  );
  expect(await reader.read(db, { appId: b, userIds: [aId, bId] })).toEqual(
    new Map([[bId, 'done']]),
  );
  expect(await reader.read(db, { appId: b, userIds: [aId] })).toEqual(new Map());
  expect(await reader.read(db, { appId: a, userIds: [bId] })).toEqual(new Map());
});

it('[AC-B1-15c#5] 事务未提交的注销申请和用户插入可见，回滚后恢复；工厂 db 不查询', async () => {
  const factory = observe(db);
  const reader = (await identity()).createDeletionStageReader({ db: factory.executor });
  const appId = randomUUID();
  const id = await user(db, appId);
  const rollback = new Error('caller rollback');
  let inserted = '';
  await expect(
    db.transaction().execute(async (trx) => {
      await request(trx, appId, id, 'cooling');
      inserted = await user(trx, appId, 'deleting');
      const input = { appId, userIds: [id, inserted] };
      expect(await reader.read(db, input)).toEqual(new Map([[id, 'none']]));
      expect(await reader.read(trx, input)).toEqual(
        new Map([
          [id, 'cooling'],
          [inserted, 'processing'],
        ]),
      );
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await reader.read(db, { appId, userIds: [id, inserted] })).toEqual(
    new Map([[id, 'none']]),
  );
  expect(factory.statements).toEqual([]);
});

it('[AC-B1-15c#6] 同一个读口看见事务内注销单及 users 状态更新，回滚后不缓存中间阶段', async () => {
  const reader = (await identity()).createDeletionStageReader({ db });
  const appId = randomUUID();
  const id = await user(db, appId);
  const requestId = await request(db, appId, id, 'cooling');
  const input = { appId, userIds: [id] };
  const rollback = new Error('caller rollback');
  await expect(
    db.transaction().execute(async (trx) => {
      await trx
        .withSchema('app')
        .updateTable('deletion_requests')
        .set({ status: 'processing' })
        .where('id', '=', requestId)
        .execute();
      expect(await reader.read(trx, input)).toEqual(new Map([[id, 'processing']]));
      expect(await reader.read(db, input)).toEqual(new Map([[id, 'cooling']]));
      await trx
        .withSchema('app')
        .updateTable('users')
        .set({ status: 'deleted' })
        .where('id', '=', id)
        .execute();
      expect(await reader.read(trx, input)).toEqual(new Map([[id, 'done']]));
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await reader.read(db, input)).toEqual(new Map([[id, 'cooling']]));
});

it('[AC-B1-15c#7] 一条只读 SQL 左连接，不加锁，不取标识或时间列，不记录日志', async () => {
  const module = await identity();
  const appId = randomUUID();
  const ids = [await user(db, appId), await user(db, appId)];
  await request(db, appId, ids[0]!, 'cooling');
  logging.write.mockClear();
  const factory = observe(db);
  const reader = module.createDeletionStageReader({ db: factory.executor });
  await db
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      const caller = observe(trx);
      expect(await reader.read(caller.executor, { appId, userIds: ids })).toEqual(
        new Map([
          [ids[0], 'cooling'],
          [ids[1], 'none'],
        ]),
      );
      expect(caller.statements).toHaveLength(1);
      const query = caller.statements[0]!.replaceAll('"', '').replace(/\s+/g, ' ').trim();
      expect(query).toMatch(/\bleft(?: outer)? join app\.deletion_requests\b/i);
      expect(query).toMatch(/\bfrom app\.users\b/i);
      expect(query).not.toMatch(/\b(?:insert|update|delete|merge|for\s+(?:share|key|no))\b/i);
      expect(query).not.toMatch(
        /\b(?:phone_hmac|phone_cipher|nickname|avatar|invite_code|attr_code|apply_at|cooling_until|now)\b/i,
      );
      // Allow aliases / grouping / aggregate CASE expressions, but no wildcard projection.
      const projection = /^select (.*?) from /i.exec(query)?.[1];
      expect(projection).toBeDefined();
      expect(projection).not.toContain('*');
      expect((await sql<{ ok: number }>`SELECT 1 AS ok`.execute(trx)).rows).toEqual([{ ok: 1 }]);
    });
  expect(await reader.read(db, { appId, userIds: [] })).toEqual(new Map());
  expect(await reader.read(db, { appId, userIds: [randomUUID()] })).toEqual(new Map());
  expect(factory.statements).toEqual([]);
  expect(logging.write).not.toHaveBeenCalled();
});

it('[AC-B1-15c#8] 冷静期已过仍读 cooling；取消后 none；资金口对 cooling 始终是 none', async () => {
  const module = await identity();
  const reader = module.createDeletionStageReader({ db });
  const funds = module.createUserDeletionStatusReader({ db });
  const appId = randomUUID();
  const id = await user(db, appId);
  const at = new Date('2000-01-01T00:00:00Z');
  const requestId = await request(db, appId, id, 'cooling', at);
  expect(await reader.read(db, { appId, userIds: [id] })).toEqual(new Map([[id, 'cooling']]));
  expect(await funds.read(db, { app_id: appId, user_ids: [id] })).toEqual(new Map([[id, 'none']]));
  // Synthetic historical cancellation inside its original window, not an expiry command.
  await cancel(db, requestId, at);
  expect(await reader.read(db, { appId, userIds: [id] })).toEqual(new Map([[id, 'none']]));
  expect(await funds.read(db, { app_id: appId, user_ids: [id] })).toEqual(new Map([[id, 'none']]));
});
