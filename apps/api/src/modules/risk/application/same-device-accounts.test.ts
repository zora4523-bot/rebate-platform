// Unit tests of the same-device check's I/O shape without a database (B1-03k): Kysely runs on a
// scripted driver that records every compiled statement, to pin the window passed to the login
// reader, configuration read on the caller's handle, the fallback warnings, and the writes (rule
// row then hit rows with the Clock instant, both ON CONFLICT DO NOTHING; none when unmarked), the
// replay of an already marked withdrawal at its first instant, and the configuration savepoints
// inside a transaction (statement errors rolled back and defaulted, connection errors rethrown), and
// the per-withdrawal advisory lock taken first inside a transaction (before the prior-hit read).
// The SQL itself runs against PostgreSQL in the rule tests (test/spec/risk/same-device).
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import { createRootLogger, type Clock } from '../../platform/index.ts';
import {
  createSameDeviceAccountsCheck,
  sameDeviceAccountsCheckToken,
  sameDeviceLoginReaderToken,
  type SameDeviceFirstLogin,
} from './same-device-accounts.ts';

const H = 'a'.repeat(64);
const NOW = '2026-09-25T00:00:00.000Z';

/** A fixed instant, a fresh Date per read. */
const clock: Clock = { now: () => new Date(Date.parse(NOW)) };

/** Rows a scripted statement answers; by default one returned id for an insert into risk_hits. */
type Respond = (sql: string, index: number) => readonly unknown[];

const defaultRespond: Respond = (sql) =>
  sql.startsWith('insert into "app"."risk_hits"') ? [{ id: 1n }] : [];

function fakeDb(statements: string[], respond: Respond = defaultRespond): Kysely<DB> {
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled.sql);
      const rows = respond(compiled.sql, statements.length - 1);
      return Promise.resolve({ rows } as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

function login(user: string, at: string, id: number): SameDeviceFirstLogin {
  return {
    device_hash: H,
    user_id: user,
    first_login_at: new Date(at),
    login_log_id: BigInt(id),
    status: 'normal',
    deleted_reason: null,
    merged_into_user_id: null,
  };
}

interface SetupOptions {
  readonly failing?: readonly string[];
  /** The error a failing read rejects with (default a plain Error, no SQLSTATE). */
  readonly failure?: () => unknown;
  readonly respond?: Respond;
  readonly clock?: Clock;
}

function setup(values: Record<string, unknown>, opts: SetupOptions = {}) {
  const failing = opts.failing ?? [];
  const failure = opts.failure ?? (() => new Error('down'));
  const statements: string[] = [];
  const lines: string[] = [];
  const db = fakeDb(statements, opts.respond);
  const windows: { start: Date; end: Date; handle: unknown }[] = [];
  const configHandles: unknown[] = [];
  const service = createSameDeviceAccountsCheck({
    clock: opts.clock ?? clock,
    logger: createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      { write: (line: string) => void lines.push(line) },
    ),
    logins: {
      read: (handle, input) => {
        windows.push({ start: input.window_start, end: input.window_end, handle });
        return Promise.resolve([
          login('a', '2026-09-01T00:00:00Z', 1),
          login('b', '2026-09-10T00:00:00Z', 2),
          login('c', '2026-09-20T00:00:00Z', 3),
        ]);
      },
    },
    config: (handle) => {
      configHandles.push(handle);
      return {
        configValue: (_app, key) => {
          if (failing.includes(key)) return Promise.reject(failure());
          return Promise.resolve(key in values ? { value: values[key], version: 1 } : null);
        },
      };
    },
  });
  const input = (user: string) =>
    ({ app_id: 'couli', user_id: user, ref: { type: 'withdrawal', id: 'w1' } }) as const;
  const judge = (user: string) => service.judge(db, input(user));
  /** Judges inside a Kysely transaction (handle.isTransaction is true). */
  const judgeInTransaction = (user: string) =>
    db.transaction().execute((trx) => service.judge(trx, input(user)));
  const warns = () =>
    lines.map((line) => JSON.parse(line) as { level: number }).filter((l) => l.level === 40);
  /** Statements other than reads and savepoint control. */
  const writes = () => statements.filter((sql) => sql.startsWith('insert'));
  return { db, statements, windows, configHandles, judge, judgeInTransaction, warns, writes };
}

it('[AC-B1-03k#3] 窗口是 Clock 的 [now − 720h, now]，读写与配置都走传入 handle', async () => {
  const { db, windows, configHandles, judge } = setup({});
  await judge('a');
  expect(windows).toHaveLength(1);
  expect(windows[0]!.end.toISOString()).toBe(NOW);
  expect(Date.parse(NOW) - windows[0]!.start.getTime()).toBe(720 * 3600 * 1000);
  expect(windows[0]!.handle).toBe(db);
  expect(configHandles).toEqual([db]);
});

it('[AC-B1-03k#1] 未命中不写任何行', async () => {
  const { writes, judge } = setup({});
  expect(await judge('b')).toEqual({ marked: false, devices: [{ device_hash: H, rank: 2 }] });
  expect(writes()).toEqual([]);
});

it('[AC-B1-03k#8][AC-B1-03k#10] 命中先登记规则再写命中行，都带 ON CONFLICT DO NOTHING', async () => {
  const { statements, judge } = setup({});
  expect(await judge('c')).toEqual({ marked: true, devices: [{ device_hash: H, rank: 3 }] });
  expect(statements).toHaveLength(3);
  expect(statements[0]).toMatch(/^select "created_at" from "app"\."risk_hits" where /);
  expect(statements[1]).toMatch(
    /^insert into "app"\."risk_rules".* on conflict \("app_id", "rule_id"\) do nothing$/,
  );
  expect(statements[2]).toMatch(
    /^insert into "app"\."risk_hits".* on conflict do nothing returning "id"$/,
  );
});

it('[AC-B1-03k#7] limit 坏值回 3 并打 warn；缺失不打 warn；读取失败回默认并打 warn', async () => {
  const bad = setup({ 'risk.device_login_accounts_limit': '2' });
  expect((await bad.judge('b')).marked).toBe(false);
  expect((await bad.judge('c')).marked).toBe(true);
  expect(bad.warns().length).toBeGreaterThan(0);
  const missing = setup({});
  await missing.judge('c');
  expect(missing.warns()).toEqual([]);
  const failing = setup(
    {},
    { failing: ['risk.device_login_accounts_limit', 'risk.merge_tombstone_dedupe'] },
  );
  expect((await failing.judge('c')).marked).toBe(true);
  expect(failing.warns()).toHaveLength(2);
});

it('[AC-B1-03k#7] 有效阈值生效', async () => {
  const two = setup({ 'risk.device_login_accounts_limit': 2 });
  expect((await two.judge('b')).marked).toBe(true);
  const four = setup({ 'risk.device_login_accounts_limit': 4 });
  expect((await four.judge('c')).marked).toBe(false);
});

it('[AC-B1-03k#8] 令牌是稳定的 symbol', () => {
  expect(typeof sameDeviceAccountsCheckToken()).toBe('symbol');
  expect(sameDeviceAccountsCheckToken()).toBe(sameDeviceAccountsCheckToken());
  expect(sameDeviceLoginReaderToken()).toBe(sameDeviceLoginReaderToken());
  expect(sameDeviceLoginReaderToken()).not.toBe(sameDeviceAccountsCheckToken());
});

const FIRST = '2026-09-25T00:00:00.000Z';
const LATER = '2026-10-15T00:00:00.000Z';

it('[AC-B1-03k#10] 同一提现单已命中：以首次判定时刻为判定时点重算，返回已标记，不再写行', async () => {
  const { statements, windows, writes, judge } = setup(
    {},
    {
      clock: { now: () => new Date(Date.parse(LATER)) },
      respond: (sql) =>
        sql.startsWith('select "created_at" from "app"."risk_hits"')
          ? [{ created_at: new Date(Date.parse(FIRST)) }]
          : [],
    },
  );
  expect(await judge('c')).toEqual({ marked: true, devices: [{ device_hash: H, rank: 3 }] });
  expect(windows).toHaveLength(1);
  expect(windows[0]!.end.toISOString()).toBe(FIRST);
  expect(Date.parse(FIRST) - windows[0]!.start.getTime()).toBe(720 * 3600 * 1000);
  expect(writes()).toEqual([]);
  expect(statements[0]).toMatch(
    /^select "created_at" from "app"\."risk_hits" where "app_id" = \$1 and "rule_id" = \$2 and "ref_type" = \$3 and "ref_id" = \$4 order by "created_at" limit \$5$/,
  );
});

it('[AC-B1-03k#10] 并发判定写入落败：取先提交那次的判定时刻重算并返回', async () => {
  let selects = 0;
  const { windows, writes, judge } = setup(
    {},
    {
      respond: (sql) => {
        if (sql.startsWith('select "created_at" from "app"."risk_hits"')) {
          selects += 1;
          return selects === 1 ? [] : [{ created_at: new Date(Date.parse(NOW) - 1000) }];
        }
        return [];
      },
    },
  );
  expect(await judge('c')).toEqual({ marked: true, devices: [{ device_hash: H, rank: 3 }] });
  expect(selects).toBe(2);
  expect(writes()).toHaveLength(2);
  expect(windows.map((w) => w.end.getTime())).toEqual([Date.parse(NOW), Date.parse(NOW) - 1000]);
});

it('[AC-B1-03k#7] 事务内配置读取各在保存点里，成功后释放', async () => {
  const { statements, judgeInTransaction } = setup({});
  expect((await judgeInTransaction('c')).marked).toBe(true);
  const control = statements.filter((sql) => /SAVEPOINT/.test(sql));
  expect(control).toEqual([
    'SAVEPOINT same_device_config',
    'RELEASE SAVEPOINT same_device_config',
    'SAVEPOINT same_device_config',
    'RELEASE SAVEPOINT same_device_config',
  ]);
});

it('[AC-B1-03k#7] 事务内语句级错误（57014）回滚到保存点、用默认值并打 warn，事务可继续用', async () => {
  const { statements, warns, writes, judgeInTransaction } = setup(
    {},
    {
      failing: ['risk.device_login_accounts_limit'],
      failure: () => Object.assign(new Error('canceling statement'), { code: '57014' }),
    },
  );
  expect(await judgeInTransaction('c')).toEqual({
    marked: true,
    devices: [{ device_hash: H, rank: 3 }],
  });
  const control = statements.filter((sql) => /SAVEPOINT/.test(sql));
  expect(control).toEqual([
    'SAVEPOINT same_device_config',
    'ROLLBACK TO SAVEPOINT same_device_config',
    'RELEASE SAVEPOINT same_device_config',
    'SAVEPOINT same_device_config',
    'RELEASE SAVEPOINT same_device_config',
  ]);
  expect(warns()).toHaveLength(1);
  expect(writes()).toHaveLength(2);
});

it('[AC-B1-03k#7] 连接级错误（08006、57P01）照常抛出，不写行', async () => {
  for (const code of ['08006', '57P01']) {
    const { writes, judgeInTransaction, judge } = setup(
      {},
      {
        failing: ['risk.device_login_accounts_limit'],
        failure: () => Object.assign(new Error('connection'), { code }),
      },
    );
    await expect(judgeInTransaction('c')).rejects.toMatchObject({ code });
    await expect(judge('c')).rejects.toMatchObject({ code });
    expect(writes()).toEqual([]);
  }
});

it('[AC-B1-03k#7] 不在事务里时不发保存点语句', async () => {
  const { statements, judge } = setup({}, { failing: ['risk.merge_tombstone_dedupe'] });
  expect((await judge('c')).marked).toBe(true);
  expect(statements.filter((sql) => /SAVEPOINT/.test(sql))).toEqual([]);
});

it('[AC-B1-03k#10] 事务内先对提现单取事务级咨询锁，再查已有命中、计算、写入', async () => {
  const { statements, writes, judgeInTransaction } = setup({});
  expect((await judgeInTransaction('c')).marked).toBe(true);
  expect(statements[0]).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
  expect(statements[1]).toMatch(/^select "created_at" from "app"\."risk_hits" where /);
  expect(statements.filter((sql) => sql.includes('pg_advisory_xact_lock'))).toHaveLength(1);
  expect(writes()).toHaveLength(2);
});

it('[AC-B1-03k#10] 锁键按 app_id、ref_type、ref_id 区分', async () => {
  const keys: unknown[] = [];
  const statements: string[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => ({
        init: async () => undefined,
        acquireConnection: async () => ({
          executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
            statements.push(compiled.sql);
            if (compiled.sql.includes('pg_advisory_xact_lock')) keys.push(compiled.parameters[0]);
            return Promise.resolve({ rows: [] } as QueryResult<R>);
          },
          async *streamQuery() {
            throw new Error('not used');
          },
        }),
        beginTransaction: async () => undefined,
        commitTransaction: async () => undefined,
        rollbackTransaction: async () => undefined,
        releaseConnection: async () => undefined,
        destroy: async () => undefined,
      }),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const service = createSameDeviceAccountsCheck({
    clock,
    logger: createRootLogger({ level: 'fatal', entry: 'api', appEnv: 'test' }, { write: () => {} }),
    logins: { read: () => Promise.resolve([]) },
    config: () => ({ configValue: () => Promise.resolve(null) }),
  });
  for (const id of ['w1', 'w2']) {
    await db
      .transaction()
      .execute((trx) =>
        service.judge(trx, { app_id: 'couli', user_id: 'c', ref: { type: 'withdrawal', id } }),
      );
  }
  expect(keys).toEqual([
    'risk.same_device:couli:withdrawal:w1',
    'risk.same_device:couli:withdrawal:w2',
  ]);
});

it('[AC-B1-03k#10] 不在事务里时不发咨询锁语句', async () => {
  const { statements, judge } = setup({});
  expect((await judge('c')).marked).toBe(true);
  expect(statements.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(false);
});
