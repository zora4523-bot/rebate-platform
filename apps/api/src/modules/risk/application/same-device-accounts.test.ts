// Unit tests of the same-device check's I/O shape without a database (B1-03k, B1-03n): Kysely runs
// on a scripted driver that records every compiled statement, to pin the window passed to the
// login reader, configuration read on the judging transaction, the fallback warnings, the isolation
// refusal, the per-withdrawal advisory lock, the stored-judgement lookup and verbatim replay, the
// writes (rule row, judgement row, then hit rows, all ON CONFLICT DO NOTHING; a judgement row even
// when unmarked), the unique-conflict re-read, and the configuration savepoints (statement errors
// rolled back and defaulted, connection errors rethrown). The SQL itself runs against PostgreSQL in
// the rule tests (test/spec/risk/same-device, test/spec/risk/same-device-replay).
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
  SameDeviceIsolationError,
  createSameDeviceAccountsCheck,
  sameDeviceAccountsCheckToken,
  sameDeviceLoginReaderToken,
  type SameDeviceFirstLogin,
} from './same-device-accounts.ts';

const H = 'a'.repeat(64);
const NOW = '2026-09-25T00:00:00.000Z';

/** A fixed instant, a fresh Date per read. */
const clock: Clock = { now: () => new Date(Date.parse(NOW)) };

/** Rows a scripted statement answers. */
type Respond = (sql: string, index: number) => readonly unknown[];

const ISOLATION_SQL = "SELECT current_setting('transaction_isolation') AS isolation";
const LOOKUP = 'select "result" from "app"."risk_judgements" where ';
const JUDGEMENT_INSERT = 'insert into "app"."risk_judgements"';

/** Read committed, an empty lookup, and one returned id for the judgement insert. */
const defaultRespond: Respond = (sql) => {
  if (sql === ISOLATION_SQL) return [{ isolation: 'read committed' }];
  if (sql.startsWith(JUDGEMENT_INSERT)) return [{ id: 1n }];
  return [];
};

interface Recorder {
  readonly statements: string[];
  readonly parameters: (readonly unknown[])[];
  /** The isolation level each transaction judge() began itself was opened with. */
  readonly begun: unknown[];
}

function fakeDb(recorder: Recorder, respond: Respond = defaultRespond): Kysely<DB> {
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      recorder.statements.push(compiled.sql);
      recorder.parameters.push(compiled.parameters);
      const rows = respond(compiled.sql, recorder.statements.length - 1);
      return Promise.resolve({ rows } as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async (_connection, settings) => {
      recorder.begun.push(settings.isolationLevel);
    },
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
  const recorder: Recorder = { statements: [], parameters: [], begun: [] };
  const { statements } = recorder;
  const lines: string[] = [];
  const db = fakeDb(recorder, opts.respond);
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
  return {
    db,
    recorder,
    statements,
    windows,
    configHandles,
    judge,
    judgeInTransaction,
    warns,
    writes,
  };
}

/** A respond that answers the stored-judgement lookup with `stored` (after `empty` misses). */
function storedRespond(stored: unknown, empty = 0): Respond {
  let lookups = 0;
  return (sql) => {
    if (sql.startsWith(LOOKUP)) {
      lookups += 1;
      return lookups > empty ? [{ result: stored }] : [];
    }
    if (sql.startsWith(JUDGEMENT_INSERT)) return [];
    return defaultRespond(sql, 0);
  };
}

it('[AC-B1-03k#3] 窗口是 Clock 的 [now − 720h, now]，配置与登录读取都走同一判定事务', async () => {
  const { db, windows, configHandles, judge } = setup({});
  await judge('a');
  expect(windows).toHaveLength(1);
  expect(windows[0]!.end.toISOString()).toBe(NOW);
  expect(Date.parse(NOW) - windows[0]!.start.getTime()).toBe(720 * 3600 * 1000);
  const trx = windows[0]!.handle as Kysely<DB>;
  expect(trx).not.toBe(db);
  expect(trx.isTransaction).toBe(true);
  expect(configHandles).toEqual([trx]);
});

it('[AC-B1-03n#1] 未命中：登记规则并写一行判定（marked=false、完整结果、Clock 时刻），不写命中行', async () => {
  const { statements, recorder, writes, judge } = setup({});
  const result = await judge('b');
  expect(result).toEqual({ marked: false, devices: [{ device_hash: H, rank: 2 }] });
  expect(writes()).toHaveLength(2);
  expect(writes()[0]).toMatch(/^insert into "app"\."risk_rules"/);
  const index = statements.findIndex((sql) => sql.startsWith(JUDGEMENT_INSERT));
  expect(statements[index]).toMatch(
    /on conflict \("app_id", "rule_id", "ref_type", "ref_id"\) do nothing returning "id"$/,
  );
  const params = recorder.parameters[index]!;
  expect(params).toContain('couli');
  expect(params).toContain('SAME_DEVICE_MULTI_ACCOUNT');
  expect(params).toContain('withdrawal');
  expect(params).toContain('w1');
  expect(params).toContain('b');
  expect(params).toContain(false);
  expect(params).toContain(JSON.stringify(result));
  expect(params.some((value) => value instanceof Date && value.toISOString() === NOW)).toBe(true);
});

it('[AC-B1-03k#8][AC-B1-03n#1] 命中：先登记规则，再写判定行，最后写命中行', async () => {
  const { statements, writes, judge } = setup({});
  expect(await judge('c')).toEqual({ marked: true, devices: [{ device_hash: H, rank: 3 }] });
  expect(writes()).toHaveLength(3);
  expect(writes()[0]).toMatch(
    /^insert into "app"\."risk_rules".* on conflict \("app_id", "rule_id"\) do nothing$/,
  );
  expect(writes()[1]!.startsWith(JUDGEMENT_INSERT)).toBe(true);
  expect(writes()[2]).toMatch(/^insert into "app"\."risk_hits".* on conflict do nothing$/);
  expect(statements.at(-1)).toBe(writes()[2]);
});

it('[AC-B1-03n#2][AC-B1-03n#3] 已有判定：原样返回存储结果，不读配置、不读登录、不写行', async () => {
  const stored = { marked: true, devices: [{ device_hash: H, rank: 7 }] };
  const { windows, configHandles, writes, statements, judge } = setup(
    { 'risk.device_login_accounts_limit': 4 },
    { respond: storedRespond(stored) },
  );
  expect(await judge('b')).toEqual(stored);
  expect(windows).toEqual([]);
  expect(configHandles).toEqual([]);
  expect(writes()).toEqual([]);
  expect(statements.at(-1)).toMatch(
    /^select "result" from "app"\."risk_judgements" where "app_id" = \$1 and "rule_id" = \$2 and "ref_type" = \$3 and "ref_id" = \$4$/,
  );
});

it('[AC-B1-03n#5] 判定行唯一冲突：重读先提交的结论返回，不写命中行', async () => {
  const winner = { marked: false, devices: [{ device_hash: H, rank: 2 }] };
  const { writes, judge } = setup({}, { respond: storedRespond(winner, 1) });
  expect(await judge('c')).toEqual(winner);
  expect(writes().some((sql) => sql.startsWith('insert into "app"."risk_hits"'))).toBe(false);
});

it('[AC-B1-03n#5] 唯一冲突后读不到判定行时报错，不当作未命中', async () => {
  const { judge } = setup(
    {},
    {
      respond: (sql) => (sql.startsWith(JUDGEMENT_INSERT) ? [] : defaultRespond(sql, 0)),
    },
  );
  await expect(judge('c')).rejects.toThrow(/conflicting row unread/);
});

it.each([
  null,
  [],
  { marked: 'yes', devices: [] },
  { marked: true },
  { marked: true, devices: [{ device_hash: H }] },
  { marked: true, devices: [{ device_hash: H, rank: 1.5 }] },
  { marked: true, devices: [null] },
])('[AC-B1-03n#2] 存储结果畸形 %j 时报错，不重算', async (stored) => {
  const { windows, judge } = setup({}, { respond: storedRespond(stored) });
  await expect(judge('c')).rejects.toThrow(/stored result malformed/);
  expect(windows).toEqual([]);
});

it.each(['repeatable read', 'serializable'])(
  '[AC-B1-03n#7] %s 事务拒绝判定（错误提示 read committed），不取锁、不读、不写',
  async (isolation) => {
    const { statements, windows, configHandles, judgeInTransaction } = setup(
      {},
      {
        respond: (sql) => (sql === ISOLATION_SQL ? [{ isolation }] : defaultRespond(sql, 0)),
      },
    );
    const failure = judgeInTransaction('c');
    await expect(failure).rejects.toBeInstanceOf(SameDeviceIsolationError);
    await expect(failure).rejects.toThrow(/read committed/i);
    expect(statements).toEqual([ISOLATION_SQL]);
    expect(windows).toEqual([]);
    expect(configHandles).toEqual([]);
  },
);

it('[AC-B1-03n#7] 读不到隔离级别时报错，不判定', async () => {
  const { windows, judge } = setup(
    {},
    { respond: (sql) => (sql === ISOLATION_SQL ? [] : defaultRespond(sql, 0)) },
  );
  await expect(judge('c')).rejects.toThrow(/transaction_isolation unread/);
  expect(windows).toEqual([]);
});

it('[AC-B1-03n#6] 连接池 handle：自开 read committed 事务，先查隔离级别、取锁、查判定，再计算写入', async () => {
  const { db, recorder, statements, windows, judge } = setup({});
  expect((await judge('c')).marked).toBe(true);
  expect(recorder.begun).toEqual(['read committed']);
  expect(statements[0]).toBe(ISOLATION_SQL);
  expect(statements[1]).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
  expect(statements[2]!.startsWith(LOOKUP)).toBe(true);
  expect(windows[0]!.handle).not.toBe(db);
});

it('[AC-B1-03n#5] 事务 handle：照用调用方事务，不另开事务；顺序同连接池', async () => {
  const { recorder, statements, windows, judgeInTransaction } = setup({});
  expect((await judgeInTransaction('c')).marked).toBe(true);
  expect(recorder.begun).toEqual([undefined]);
  expect(statements[0]).toBe(ISOLATION_SQL);
  expect(statements[1]).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
  expect(statements[2]!.startsWith(LOOKUP)).toBe(true);
  expect(statements.filter((sql) => sql.includes('pg_advisory_xact_lock'))).toHaveLength(1);
  expect((windows[0]!.handle as Kysely<DB>).isTransaction).toBe(true);
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

it('[AC-B1-03n#4] 配置读取失败按默认 3 判定，结论照常写进判定行', async () => {
  const { recorder, statements, judge } = setup(
    { 'risk.device_login_accounts_limit': 2 },
    { failing: ['risk.device_login_accounts_limit'] },
  );
  const result = await judge('b');
  expect(result).toEqual({ marked: false, devices: [{ device_hash: H, rank: 2 }] });
  const index = statements.findIndex((sql) => sql.startsWith(JUDGEMENT_INSERT));
  expect(recorder.parameters[index]).toContain(JSON.stringify(result));
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

it.each([false, true])(
  '[AC-B1-03k#7] 配置读取各在保存点里，成功后释放（事务 handle=%s）',
  async (inTransaction) => {
    const ctx = setup({});
    expect((await (inTransaction ? ctx.judgeInTransaction('c') : ctx.judge('c'))).marked).toBe(
      true,
    );
    const control = ctx.statements.filter((sql) => /SAVEPOINT/.test(sql));
    expect(control).toEqual([
      'SAVEPOINT same_device_config',
      'RELEASE SAVEPOINT same_device_config',
      'SAVEPOINT same_device_config',
      'RELEASE SAVEPOINT same_device_config',
    ]);
  },
);

it('[AC-B1-03k#7] 语句级错误（57014）回滚到保存点、用默认值并打 warn，事务可继续用', async () => {
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
  expect(writes()).toHaveLength(3);
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

it('[AC-B1-03k#10][AC-B1-03n#8] 锁键按 app_id、ref_type、ref_id 区分', async () => {
  const keys: unknown[] = [];
  const db = fakeDb({ statements: [], parameters: [], begun: [] }, (sql) =>
    sql === ISOLATION_SQL
      ? [{ isolation: 'read committed' }]
      : sql.startsWith(JUDGEMENT_INSERT)
        ? [{ id: 1n }]
        : [],
  );
  const recorded = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => ({
        init: async () => undefined,
        acquireConnection: async () => ({
          async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
            if (compiled.sql.includes('pg_advisory_xact_lock')) keys.push(compiled.parameters[0]);
            return db.executeQuery<R>(compiled);
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
    await service.judge(recorded, {
      app_id: 'couli',
      user_id: 'c',
      ref: { type: 'withdrawal', id },
    });
  }
  expect(keys).toEqual([
    'risk.same_device:couli:withdrawal:w1',
    'risk.same_device:couli:withdrawal:w2',
  ]);
});
