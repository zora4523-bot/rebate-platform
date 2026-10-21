// BR-CALC-12 / 13：只测解析，不进入快照写入、月结或凭证路径。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { AFTER, BEFORE, PAID, chain, fixture, level, person, relation, user } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

// 工厂在每个测试体内、夹具写入及断言之前调用，骨架只能以 NotImplemented 先红。
it('[AC-B2-03p#1] BR-CALC-12 三层等级与关系都取 paidAt，忽略事后改级、改绑及当前用户字段', async () => {
  const f = fixture(db);
  const c = await chain(db);
  await level(db, c.appId, c.owner, 'L3', AFTER, 'L1');
  await level(db, c.appId, c.direct, 'L1', AFTER, 'L2');
  await level(db, c.appId, c.indirect, 'L2', AFTER, 'L3');
  await relation(db, c.appId, c.owner, c.ancestor, AFTER, c.direct);
  await relation(db, c.appId, c.direct, c.ancestor, AFTER, c.indirect);
  await db
    .withSchema('app')
    .updateTable('users')
    .set({ parent_id: c.ancestor })
    .where('app_id', '=', c.appId)
    .where('id', '=', c.owner)
    .execute();
  const result = await db.transaction().execute((trx) => f.resolver.resolve(trx, c.input));
  expect(result).toEqual(c.expected);
  expect(f.warn).not.toHaveBeenCalled();
});

it('[AC-B2-03p#2] BR-CALC-12 恰在 paidAt 的等级和绑定生效，三层都取新值', async () => {
  const f = fixture(db);
  const appId = randomUUID();
  const owner = await user(db, appId);
  const direct = await user(db, appId);
  const indirect = await user(db, appId);
  await level(db, appId, owner, 'L1');
  await level(db, appId, direct, 'L1');
  await level(db, appId, indirect, 'L2');
  await level(db, appId, owner, 'L2', PAID, 'L1');
  await level(db, appId, direct, 'L3', PAID, 'L1');
  await level(db, appId, indirect, 'L1', PAID, 'L2');
  await relation(db, appId, owner, direct, PAID);
  await relation(db, appId, direct, indirect, PAID);
  const result = await db.transaction().execute((trx) =>
    f.resolver.resolve(trx, {
      appId,
      ownerUserId: owner,
      paidAt: PAID,
    }),
  );
  expect(result).toEqual({
    owner: person(owner, 'L2'),
    direct: person(direct, 'L3'),
    indirect: person(indirect, 'L1'),
    warnings: [],
  });
});

it.each([
  { ac: 3, directAt: null, indirectAt: null },
  { ac: 4, directAt: AFTER, indirectAt: BEFORE },
  { ac: 5, directAt: BEFORE, indirectAt: null },
  { ac: 6, directAt: BEFORE, indirectAt: AFTER },
] as const)(
  '[AC-B2-03p#$ac] BR-CALC-12 任一层 paidAt 尚未绑定即为空，事后关系不补入',
  async ({ directAt, indirectAt }) => {
    const f = fixture(db);
    const appId = randomUUID();
    const owner = await user(db, appId);
    const direct = await user(db, appId);
    const indirect = await user(db, appId);
    await level(db, appId, owner, 'L1');
    await level(db, appId, direct, 'L2');
    await level(db, appId, indirect, 'L3');
    if (directAt !== null) await relation(db, appId, owner, direct, directAt);
    if (indirectAt !== null) await relation(db, appId, direct, indirect, indirectAt);
    const result = await db.transaction().execute((trx) =>
      f.resolver.resolve(trx, {
        appId,
        ownerUserId: owner,
        paidAt: PAID,
      }),
    );
    expect(result).toEqual({
      owner: person(owner, 'L1'),
      direct: directAt === BEFORE ? person(direct, 'L2') : null,
      indirect: null,
      warnings: [],
    });
    const ids = directAt === BEFORE ? [owner, direct] : [owner];
    expect(f.read).toHaveBeenCalledTimes(1);
    expect([...f.read.mock.calls[0]![1].user_ids].sort()).toEqual(ids.sort());
  },
);

it.each(['owner', 'direct'] as const)(
  '[AC-B2-03p#7] BR-CALC-12 %s 的上级恰在 paidAt 解除，不沿用旧绑定',
  async (role) => {
    const f = fixture(db);
    const c = await chain(db);
    await relation(db, c.appId, c[role], null, PAID, role === 'owner' ? c.direct : c.indirect);
    const result = await db.transaction().execute((trx) => f.resolver.resolve(trx, c.input));
    expect(result).toEqual({
      ...c.expected,
      direct: role === 'owner' ? null : c.expected.direct,
      indirect: null,
    });
  },
);

it.each([
  { role: 'owner', future: false },
  { role: 'direct', future: false },
  { role: 'indirect', future: false },
  { role: 'owner', future: true },
  { role: 'direct', future: true },
  { role: 'indirect', future: true },
] as const)(
  '[AC-B2-03p#8] BR-CALC-12 $role 缺有效等级日志（只有未来日志=$future）取 L1 并保留 growth 告警',
  async ({ role, future }) => {
    const f = fixture(db);
    const appId = randomUUID();
    const ids = {
      owner: await user(db, appId),
      direct: await user(db, appId),
      indirect: await user(db, appId),
    };
    for (const name of ['owner', 'direct', 'indirect'] as const) {
      if (name !== role) await level(db, appId, ids[name], 'L2');
      else if (future) await level(db, appId, ids[name], 'L3', AFTER);
    }
    await relation(db, appId, ids.owner, ids.direct);
    await relation(db, appId, ids.direct, ids.indirect);
    const result = await db.transaction().execute((trx) =>
      f.resolver.resolve(trx, {
        appId,
        ownerUserId: ids.owner,
        paidAt: PAID,
      }),
    );
    expect(result).toEqual({
      owner: person(ids.owner, role === 'owner' ? 'L1' : 'L2'),
      direct: person(ids.direct, role === 'direct' ? 'L1' : 'L2'),
      indirect: person(ids.indirect, role === 'indirect' ? 'L1' : 'L2'),
      warnings: [{ code: 'growth_level_log_missing', userId: ids[role] }],
    });
    expect(f.warn).toHaveBeenCalledWith(
      { app_id: appId, user_id: ids[role] },
      'growth_level_log_missing',
    );
  },
);

it('[AC-B2-03p#9] BR-CALC-12 多人缺日志时每个人的告警都保留，不只报告本人', async () => {
  const f = fixture(db);
  const appId = randomUUID();
  const owner = await user(db, appId);
  const direct = await user(db, appId);
  const indirect = await user(db, appId);
  await relation(db, appId, owner, direct);
  await relation(db, appId, direct, indirect);
  const result = await db.transaction().execute((trx) =>
    f.resolver.resolve(trx, {
      appId,
      ownerUserId: owner,
      paidAt: PAID,
    }),
  );
  expect(result.owner).toEqual(person(owner, 'L1'));
  expect(result.direct).toEqual(person(direct, 'L1'));
  expect(result.indirect).toEqual(person(indirect, 'L1'));
  expect(result.warnings).toHaveLength(3);
  expect(result.warnings).toEqual(
    expect.arrayContaining(
      [owner, direct, indirect].map((userId) => ({ code: 'growth_level_log_missing', userId })),
    ),
  );
});

it.each([
  { role: 'owner', status: 'deleting' },
  { role: 'direct', status: 'deleting' },
  { role: 'indirect', status: 'deleting' },
  { role: 'owner', status: 'deleted' },
  { role: 'direct', status: 'deleted' },
  { role: 'indirect', status: 'deleted' },
] as const)(
  '[AC-B2-03p#10] BR-CALC-13 $role 注销状态 $status 只剥夺本人，原因 deleted，不顺延或切断间推',
  async ({ role, status }) => {
    const f = fixture(db);
    const c = await chain(db);
    await db
      .withSchema('app')
      .updateTable('users')
      .set({ status, updated_at: AFTER })
      .where('app_id', '=', c.appId)
      .where('id', '=', c[role])
      .execute();
    // 注销后当前关系已解除；paidAt 的历史仍存在。
    if (role === 'direct') {
      await relation(db, c.appId, c.owner, null, AFTER, c.direct);
      await relation(db, c.appId, c.direct, null, AFTER, c.indirect);
    }
    const result = await db.transaction().execute((trx) => f.resolver.resolve(trx, c.input));
    expect(result).toEqual({
      ...c.expected,
      [role]: { ...c.expected[role], status: 'forfeited', forfeitReason: 'deleted' },
    });
  },
);

it('[AC-B2-03p#11] BR-CALC-13 直推与间推均失效时分别 forfeited，不把间推改派给更高祖先', async () => {
  const f = fixture(db);
  const c = await chain(db);
  await db
    .withSchema('app')
    .updateTable('users')
    .set({ status: 'deleted' })
    .where('app_id', '=', c.appId)
    .where('id', 'in', [c.direct, c.indirect])
    .execute();
  const result = await db.transaction().execute((trx) => f.resolver.resolve(trx, c.input));
  expect(result).toEqual({
    ...c.expected,
    direct: person(c.direct, 'L2', true),
    indirect: person(c.indirect, 'L3', true),
  });
});

it.each(['banned', 'frozen', 'appealing'] as const)(
  '[AC-B2-03p#12] BR-CALC-13 三层风控状态为 %s 仍 active，不在快照剥夺或暂缓',
  async (state) => {
    const f = fixture(db);
    const c = await chain(db);
    for (const userId of [c.owner, c.direct, c.indirect]) {
      await db
        .withSchema('app')
        .insertInto('user_risk_state')
        .values({
          app_id: c.appId,
          user_id: userId,
          state,
          reason_category: 'other',
          changed_by: 'synthetic-test',
          changed_at: AFTER,
          created_at: AFTER,
          updated_at: AFTER,
        })
        .execute();
    }
    const result = await db.transaction().execute((trx) => f.resolver.resolve(trx, c.input));
    expect(result).toEqual(c.expected);
  },
);

it('[AC-B2-03p#13] BR-CALC-13 注销冷静期不属于失效，三层仍 active', async () => {
  const f = fixture(db);
  const c = await chain(db);
  for (const userId of [c.owner, c.direct, c.indirect]) {
    await db
      .withSchema('app')
      .insertInto('deletion_requests')
      .values({
        id: randomUUID(),
        app_id: c.appId,
        user_id: userId,
        status: 'cooling',
        apply_at: PAID,
        cooling_until: new Date('2026-10-27T10:00:00+08:00'),
        balance_snapshot_fen: 0n,
        created_at: PAID,
        updated_at: PAID,
      })
      .execute();
  }
  const result = await db.transaction().execute((trx) => f.resolver.resolve(trx, c.input));
  expect(result).toEqual(c.expected);
});

it('[AC-B2-03p#14] BR-CALC-13 用户不存在时保留归属 ID 并 forfeited，不伪造 active 用户', async () => {
  const f = fixture(db);
  const appId = randomUUID();
  const ownerUserId = randomUUID();
  const result = await db.transaction().execute((trx) =>
    f.resolver.resolve(trx, {
      appId,
      ownerUserId,
      paidAt: PAID,
    }),
  );
  expect(result).toEqual({
    owner: person(ownerUserId, 'L1', true),
    direct: null,
    indirect: null,
    warnings: [{ code: 'growth_level_log_missing', userId: ownerUserId }],
  });
});

it('[AC-B2-03p#15] BR-CALC-12/13 同一用户 ID 换 app 不得读到其他 app 的等级、关系或有效身份', async () => {
  const f = fixture(db);
  const c = await chain(db);
  await db.transaction().execute(async (trx) => {
    expect(await f.resolver.resolve(trx, c.input)).toEqual(c.expected);
    const otherApp = randomUUID();
    const result = await f.resolver.resolve(trx, { ...c.input, appId: otherApp });
    expect(result).toEqual({
      owner: person(c.owner, 'L1', true),
      direct: null,
      indirect: null,
      warnings: [{ code: 'growth_level_log_missing', userId: c.owner }],
    });
    expect(f.read).toHaveBeenLastCalledWith(trx, { app_id: otherApp, user_ids: [c.owner] });
  });
});

it('[AC-B2-03p#16] BR-CALC-12/13 三层读取均使用调用方事务，注销一次批量读，未提交夹具可见', async () => {
  const f = fixture(db);
  await db.transaction().execute(async (trx) => {
    const c = await chain(trx);
    await trx
      .withSchema('app')
      .updateTable('users')
      .set({ status: 'deleting' })
      .where('app_id', '=', c.appId)
      .where('id', '=', c.direct)
      .execute();
    const result = await f.resolver.resolve(trx, c.input);
    expect(result).toEqual({ ...c.expected, direct: person(c.direct, 'L2', true) });
    expect(f.read).toHaveBeenCalledTimes(1);
    const [executor, request] = f.read.mock.calls[0]!;
    expect(executor).toBe(trx);
    expect(request.app_id).toBe(c.appId);
    expect([...request.user_ids].sort()).toEqual([c.owner, c.direct, c.indirect].sort());
    expect(
      f.levelAt.mock.calls
        .map(([, query]) => query)
        .sort((a, b) => a.user_id.localeCompare(b.user_id)),
    ).toEqual(
      [c.owner, c.direct, c.indirect].sort().map((user_id) => ({
        app_id: c.appId,
        user_id,
        at: PAID,
      })),
    );
    expect(
      f.parentAt.mock.calls
        .map(([, query]) => query)
        .sort((a, b) => a.user_id.localeCompare(b.user_id)),
    ).toEqual(
      [c.owner, c.direct].sort().map((user_id) => ({ app_id: c.appId, user_id, at: PAID })),
    );
    for (const [handle] of [...f.levelAt.mock.calls, ...f.parentAt.mock.calls]) {
      expect(handle).toBe(trx);
    }
  });
});

it('[AC-B2-03p#17] BR-CALC-12 同一用户不同 paidAt 分别重放，改绑后沿新直推取间推，旧订单仍取旧链', async () => {
  const f = fixture(db);
  const c = await chain(db);
  const newDirect = await user(db, c.appId);
  const newIndirect = await user(db, c.appId);
  await level(db, c.appId, newDirect, 'L3');
  await level(db, c.appId, newIndirect, 'L2');
  await level(db, c.appId, c.owner, 'L2', PAID, 'L1');
  await level(db, c.appId, newDirect, 'L1', PAID, 'L3');
  await level(db, c.appId, newIndirect, 'L3', PAID, 'L2');
  await relation(db, c.appId, c.owner, newDirect, PAID, c.direct);
  await relation(db, c.appId, newDirect, newIndirect, PAID);
  await db.transaction().execute(async (trx) => {
    const earlier = { ...c.input, paidAt: BEFORE };
    expect(await f.resolver.resolve(trx, earlier)).toEqual(c.expected);
    expect(await f.resolver.resolve(trx, c.input)).toEqual({
      owner: person(c.owner, 'L2'),
      direct: person(newDirect, 'L1'),
      indirect: person(newIndirect, 'L3'),
      warnings: [],
    });
    expect(await f.resolver.resolve(trx, earlier)).toEqual(c.expected);
  });
});
