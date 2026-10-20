import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, expect, expectTypeOf, it, vi } from 'vitest';
import {
  assertDeduplicated,
  assertReadProjection,
  clock,
  normalized,
  observe,
  probeLock,
  realname,
  riskState,
  user,
} from './kit.ts';

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

// Real public exports at runtime. Erased type queries avoid pulling Nest parameter decorators
// into the test TS project, matching the existing identity reader suites.
const { lockUsersForUpdate, createRealnameStatusBatchReader } = (await import(
  new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/identity/ports/lock-users.ts') &
  typeof import('../../../../apps/api/src/modules/identity/ports/realname-status-batch.ts');
const { createRiskStateBatchReader } = (await import(
  new URL('../../../../apps/api/src/modules/risk/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/risk/application/risk-state-reader.ts');

// Scope: B1-02zf §9.2 only (refs is empty). No funds calculations or expiry decisions here.
let database: TestDatabase | undefined;
let db: Kysely<DB>;
let other: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app') });
  other = createDb({ connectionString: database.urlFor('couli_app') });
});
afterAll(async () => {
  try {
    await Promise.all([db && destroyDb(db), other && destroyDb(other)]);
  } finally {
    await database?.drop();
  }
});

it('[AC-B1-02zf#1] 锁结果去重，只含本 app 请求且存在的用户，不按业务状态过滤', async () => {
  const appId = randomUUID();
  const a = await user(db, appId);
  const b = await user(db, appId);
  await db.updateTable('users').set({ status: 'deleted' }).where('id', '=', b).execute();
  const unrequested = await user(db, appId);
  const foreign = await user(db, randomUUID());
  const missing = randomUUID();
  const userIds = Object.freeze([b, missing, a, foreign, a, b, missing]);
  const before = [...userIds];
  await db.transaction().execute(async (trx) => {
    const result = await lockUsersForUpdate(trx, { appId, userIds });
    expectTypeOf(result).toEqualTypeOf<ReadonlySet<string>>();
    expect(result).toEqual(new Set([a, b]));
    expect(result.has(unrequested)).toBe(false);
    expect(await lockUsersForUpdate(trx, { appId, userIds: [foreign, missing] })).toEqual(
      new Set(),
    );
  });
  expect(userIds).toEqual(before);
});

it('[AC-B1-02zf#2] 锁入口接受普通 Kysely，空数组不查库', async () => {
  const caller = observe(db);
  expect(await lockUsersForUpdate(caller.executor, { appId: randomUUID(), userIds: [] })).toEqual(
    new Set(),
  );
  expect(caller.statements).toEqual([]);
});

it('[AC-B1-02zf#3] 单条 SQL 仅选 id，按 id 升序 FOR NO KEY UPDATE，绑定 ID 去重', async () => {
  const appId = randomUUID();
  const ids = [await user(db, appId), await user(db, appId)].sort().reverse();
  await db.transaction().execute(async (trx) => {
    const caller = observe(trx);
    expect(await lockUsersForUpdate(caller.executor, { appId, userIds: [...ids, ...ids] })).toEqual(
      new Set(ids),
    );
    expect(caller.statements).toHaveLength(1);
    const statement = caller.statements[0]!;
    const query = normalized(statement);
    expect(query).toMatch(/^select (?:\w+\.)?id from app\.users\b/);
    expect(query).toMatch(/\border by (?:\w+\.)?id(?: asc)? for no key update(?: of \w+)?$/);
    expect(query).toMatch(/\bid\s*=\s*any\s*\(/);
    expect(query).not.toMatch(/\b(?:skip locked|nowait|limit)\b/);
    assertDeduplicated(statement, ids);
  });
});

it('[AC-B1-02zf#4] 请求行互斥、未请求与跨 app 行不锁、兼容 KEY SHARE，提交后释放', async () => {
  const appId = randomUUID();
  const a = await user(db, appId);
  const b = await user(db, appId);
  const unrequested = await user(db, appId);
  const foreignApp = randomUUID();
  const foreign = await user(db, foreignApp);
  await db.transaction().execute(async (trx) => {
    expect(await lockUsersForUpdate(trx, { appId, userIds: [b, a, foreign] })).toEqual(
      new Set([a, b]),
    );
    for (const id of [a, b]) {
      await expect(probeLock(other, appId, id)).rejects.toMatchObject({ code: '55P03' });
      expect(await probeLock(other, appId, id, 'key share')).toEqual([{ id }]);
    }
    expect(await probeLock(other, appId, unrequested)).toEqual([{ id: unrequested }]);
    expect(await probeLock(other, foreignApp, foreign)).toEqual([{ id: foreign }]);
  });
  expect(await probeLock(other, appId, a)).toEqual([{ id: a }]);
  expect(await probeLock(other, appId, b)).toEqual([{ id: b }]);
});

it('[AC-B1-02zf#5] 调用方回滚释放锁，不另开事务或提前提交', async () => {
  const appId = randomUUID();
  const id = await user(db, appId);
  const rollback = new Error('synthetic rollback');
  await expect(
    db.transaction().execute(async (trx) => {
      expect(await lockUsersForUpdate(trx, { appId, userIds: [id] })).toEqual(new Set([id]));
      await expect(probeLock(other, appId, id)).rejects.toMatchObject({ code: '55P03' });
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await probeLock(other, appId, id)).toEqual([{ id }]);
});

it('[AC-B1-02zf#6] 锁入口看见调用方尚未提交的用户插入', async () => {
  const appId = randomUUID();
  await db.transaction().execute(async (trx) => {
    const id = await user(trx, appId);
    expect(await lockUsersForUpdate(trx, { appId, userIds: [id] })).toEqual(new Set([id]));
    expect(await lockUsersForUpdate(other, { appId, userIds: [id] })).toEqual(new Set());
  });
});

it('[AC-B1-02zf#7] 实名批量返回三种状态，无实名行补 none，未请求和不存在的用户不返回', async () => {
  const reader = createRealnameStatusBatchReader({ db });
  const appId = randomUUID();
  const expected = new Map<string, 'none' | 'verified' | 'failed'>();
  for (const status of ['none', 'verified', 'failed'] as const) {
    const id = await user(db, appId);
    await realname(db, appId, id, status);
    expected.set(id, status);
  }
  expected.set(await user(db, appId), 'none');
  await user(db, appId);
  const ids = [...expected.keys()];
  const userIds = Object.freeze([...ids, randomUUID(), ...ids]);
  const result = await reader.read(db, { appId, userIds });
  expectTypeOf(result).toEqualTypeOf<ReadonlyMap<string, 'none' | 'verified' | 'failed'>>();
  expect(result).toEqual(expected);
});

it('[AC-B1-02zf#8] 风控四种状态及空记录，已过期/未来/空截止时间均原样返回', async () => {
  const reader = createRiskStateBatchReader({ db });
  const appId = randomUUID();
  const past = new Date('2020-01-01T00:00:00.123Z');
  const future = new Date('2099-12-31T23:59:59.987Z');
  const expected = new Map<
    string,
    { state: 'normal' | 'frozen' | 'appealing' | 'banned'; frozen_until: Date | null }
  >();
  for (const [state, frozen_until] of [
    ['normal', null],
    ['frozen', past],
    ['frozen', future],
    ['frozen', null],
    ['appealing', past],
    ['appealing', future],
    ['appealing', null],
    ['banned', null],
  ] as const) {
    const id = await user(db, appId);
    await riskState(db, appId, id, state, frozen_until);
    expected.set(id, { state, frozen_until });
  }
  expected.set(await user(db, appId), { state: 'normal', frozen_until: null });
  await user(db, appId);
  const ids = [...expected.keys()];
  const result = await reader.read(db, {
    appId,
    userIds: Object.freeze([...ids, randomUUID(), ...ids]),
  });
  expectTypeOf(result).toEqualTypeOf<
    ReadonlyMap<
      string,
      {
        readonly state: 'normal' | 'frozen' | 'appealing' | 'banned';
        readonly frozen_until: Date | null;
      }
    >
  >();
  expect(result).toEqual(expected);
});

// Factories are called inside each test and outside rejection assertions: the skeleton cannot
// accidentally satisfy a negative test merely by throwing NotImplemented.
const readers = [
  {
    label: '实名',
    create: createRealnameStatusBatchReader,
    seed: (executor: Kysely<DB>, app: string, id: string) => realname(executor, app, id, 'failed'),
    value: 'failed',
    table: 'realname',
    fields: ['status'],
  },
  {
    label: '风控',
    create: createRiskStateBatchReader,
    seed: (executor: Kysely<DB>, app: string, id: string) => riskState(executor, app, id, 'banned'),
    value: { state: 'banned', frozen_until: null },
    table: 'user_risk_state',
    fields: ['state', 'frozen_until'],
  },
] as const;

it.each(readers)('[AC-B1-02zf#9] $label：跨 app 同 ID 不可见，缺失 ID 不补默认值', async (port) => {
  const reader = port.create({ db });
  const appId = randomUUID();
  const foreignApp = randomUUID();
  const a = await user(db, appId);
  const b = await user(db, foreignApp);
  await port.seed(db, appId, a);
  await port.seed(db, foreignApp, b);
  const userIds = [a, b, randomUUID()];
  expect(await reader.read(db, { appId, userIds })).toEqual(new Map([[a, port.value]]));
  expect(await reader.read(db, { appId: foreignApp, userIds })).toEqual(new Map([[b, port.value]]));
  expect(await reader.read(db, { appId, userIds: [b, randomUUID()] })).toEqual(new Map());
  expect(await reader.read(db, { appId: foreignApp, userIds: [a] })).toEqual(new Map());
  expect(await reader.read(db, { appId, userIds })).toEqual(new Map([[a, port.value]]));
});

it.each(readers)(
  '[AC-B1-02zf#10] $label：空数组与构造均不向 db 或 executor 发 SQL',
  async (port) => {
    const factory = observe(db);
    const caller = observe(other);
    const reader = port.create({ db: factory.executor });
    expect(await reader.read(caller.executor, { appId: randomUUID(), userIds: [] })).toEqual(
      new Map(),
    );
    expect(factory.statements).toEqual([]);
    expect(caller.statements).toEqual([]);
  },
);

it.each(readers)(
  '[AC-B1-02zf#11] $label：仅调用方执行一条左连接批量只读 SQL，不读敏感列、不加锁',
  async (port) => {
    const factory = observe(db);
    const reader = port.create({ db: factory.executor });
    const appId = randomUUID();
    const a = await user(db, appId);
    const b = await user(db, appId);
    await port.seed(db, appId, a);
    await port.seed(db, appId, b);
    await db
      .transaction()
      .setAccessMode('read only')
      .execute(async (trx) => {
        const caller = observe(trx);
        const userIds = Object.freeze([b, a, b, a]);
        expect(await reader.read(caller.executor, { appId, userIds })).toEqual(
          new Map([
            [a, port.value],
            [b, port.value],
          ]),
        );
        expect(caller.statements).toHaveLength(1);
        const statement = caller.statements[0]!;
        const query = normalized(statement);
        expect(query).toMatch(new RegExp(`\\bleft(?: outer)? join app\\.${port.table}\\b`));
        expect(query).not.toMatch(/\b(?:insert|update|delete|merge|for\s+(?:share|key|no))\b/);
        assertReadProjection(query, port.fields);
        assertDeduplicated(statement, userIds);
        expect((await sql<{ ok: number }>`SELECT 1 AS ok`.execute(trx)).rows).toEqual([{ ok: 1 }]);
        expect(await probeLock(other, appId, a)).toEqual([{ id: a }]);
      });
    expect(factory.statements).toEqual([]);
  },
);

it.each(readers)(
  '[AC-B1-02zf#12] $label：调用方未提交的用户与状态插入可见，回滚后消失',
  async (port) => {
    const reader = port.create({ db });
    const appId = randomUUID();
    const rollback = new Error('synthetic rollback');
    let id = '';
    await expect(
      db.transaction().execute(async (trx) => {
        id = await user(trx, appId);
        await port.seed(trx, appId, id);
        const input = { appId, userIds: [id] };
        expect(await reader.read(other, input)).toEqual(new Map());
        expect(await reader.read(trx, input)).toEqual(new Map([[id, port.value]]));
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await reader.read(db, { appId, userIds: [id] })).toEqual(new Map());
  },
);

it('[AC-B1-02zf#13] 实名重读未提交的状态更新，回滚不污染后续读取', async () => {
  const reader = createRealnameStatusBatchReader({ db });
  const appId = randomUUID();
  const id = await user(db, appId);
  await realname(db, appId, id, 'none');
  const input = { appId, userIds: [id] };
  expect(await reader.read(db, input)).toEqual(new Map([[id, 'none']]));
  const rollback = new Error('synthetic rollback');
  await expect(
    db.transaction().execute(async (trx) => {
      await trx
        .updateTable('realname')
        .set({ status: 'failed' })
        .where('user_id', '=', id)
        .execute();
      expect(await reader.read(other, input)).toEqual(new Map([[id, 'none']]));
      expect(await reader.read(trx, input)).toEqual(new Map([[id, 'failed']]));
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await reader.read(db, input)).toEqual(new Map([[id, 'none']]));
});

it('[AC-B1-02zf#14] 风控重读未提交的状态和截止时间更新，回滚不缓存', async () => {
  const reader = createRiskStateBatchReader({ db });
  const appId = randomUUID();
  const id = await user(db, appId);
  await riskState(db, appId, id, 'normal');
  const input = { appId, userIds: [id] };
  const normal = new Map([[id, { state: 'normal', frozen_until: null }]]);
  expect(await reader.read(db, input)).toEqual(normal);
  const rollback = new Error('synthetic rollback');
  await expect(
    db.transaction().execute(async (trx) => {
      await trx
        .updateTable('user_risk_state')
        .set({
          state: 'frozen',
          reason_category: 'other',
          frozen_until: clock.now(),
        })
        .where('user_id', '=', id)
        .execute();
      expect(await reader.read(other, input)).toEqual(normal);
      expect(await reader.read(trx, input)).toEqual(
        new Map([[id, { state: 'frozen', frozen_until: clock.now() }]]),
      );
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await reader.read(db, input)).toEqual(normal);
});

it('[AC-B1-02zf#15] 实名非法状态按库损坏拒绝，不降为 none', async () => {
  const reader = createRealnameStatusBatchReader({ db });
  const appId = randomUUID();
  const id = await user(db, appId);
  await realname(db, appId, id, 'verified');
  expect(await reader.read(db, { appId, userIds: [id] })).toEqual(new Map([[id, 'verified']]));
  // PostgreSQL CHECK prevents a corrupt fixture. Execute the real query, then corrupt only
  // the returned status at the driver boundary, without DDL or elevated credentials.
  const corrupt: KyselyPlugin = {
    transformQuery({ node }) {
      return node;
    },
    async transformResult({ result }) {
      return {
        ...result,
        rows: result.rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value === 'verified' ? 'corrupt_status' : value,
            ]),
          ),
        ),
      };
    },
  };
  await expect(reader.read(db.withPlugin(corrupt), { appId, userIds: [id] })).rejects.toThrow();
});

it('[AC-B1-02zf#16] 三个端口在命中、缺失、跨 app、空数组分支均不写应用日志', async () => {
  const appId = randomUUID();
  const id = await user(db, appId);
  logging.write.mockClear();
  const realnames = createRealnameStatusBatchReader({ db });
  const risks = createRiskStateBatchReader({ db });
  await db.transaction().execute(async (trx) => {
    for (const input of [
      { appId, userIds: [id] },
      { appId, userIds: [randomUUID()] },
      { appId: randomUUID(), userIds: [id] },
      { appId, userIds: [] },
    ]) {
      await lockUsersForUpdate(trx, input);
      await realnames.read(trx, input);
      await risks.read(trx, input);
    }
  });
  expect(logging.write).not.toHaveBeenCalled();
});
