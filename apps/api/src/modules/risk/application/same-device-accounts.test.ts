// Unit tests of the same-device check's I/O shape without a database (B1-03k): Kysely runs on a
// scripted driver that records every compiled statement, to pin the window passed to the login
// reader, configuration read on the caller's handle, the fallback warnings, and the writes (rule
// row then hit rows with the Clock instant, both ON CONFLICT DO NOTHING; none when unmarked). The
// SQL itself runs against PostgreSQL in the rule tests (test/spec/risk/same-device).
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

function fakeDb(statements: string[]): Kysely<DB> {
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled.sql);
      return Promise.resolve({ rows: [] } as QueryResult<R>);
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

function setup(values: Record<string, unknown>, failing: readonly string[] = []) {
  const statements: string[] = [];
  const lines: string[] = [];
  const db = fakeDb(statements);
  const windows: { start: Date; end: Date; handle: unknown }[] = [];
  const configHandles: unknown[] = [];
  const service = createSameDeviceAccountsCheck({
    clock,
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
          if (failing.includes(key)) return Promise.reject(new Error('down'));
          return Promise.resolve(key in values ? { value: values[key], version: 1 } : null);
        },
      };
    },
  });
  const judge = (user: string) =>
    service.judge(db, { app_id: 'couli', user_id: user, ref: { type: 'withdrawal', id: 'w1' } });
  const warns = () =>
    lines.map((line) => JSON.parse(line) as { level: number }).filter((l) => l.level === 40);
  return { db, statements, windows, configHandles, judge, warns };
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
  const { statements, judge } = setup({});
  expect(await judge('b')).toEqual({ marked: false, devices: [{ device_hash: H, rank: 2 }] });
  expect(statements).toEqual([]);
});

it('[AC-B1-03k#8][AC-B1-03k#10] 命中先登记规则再写命中行，都带 ON CONFLICT DO NOTHING', async () => {
  const { statements, judge } = setup({});
  expect(await judge('c')).toEqual({ marked: true, devices: [{ device_hash: H, rank: 3 }] });
  expect(statements).toHaveLength(2);
  expect(statements[0]).toMatch(
    /^insert into "app"\."risk_rules".* on conflict \("app_id", "rule_id"\) do nothing$/,
  );
  expect(statements[1]).toMatch(/^insert into "app"\."risk_hits".* on conflict do nothing$/);
});

it('[AC-B1-03k#7] limit 坏值回 3 并打 warn；缺失不打 warn；读取失败回默认并打 warn', async () => {
  const bad = setup({ 'risk.device_login_accounts_limit': '2' });
  expect((await bad.judge('b')).marked).toBe(false);
  expect((await bad.judge('c')).marked).toBe(true);
  expect(bad.warns().length).toBeGreaterThan(0);
  const missing = setup({});
  await missing.judge('c');
  expect(missing.warns()).toEqual([]);
  const failing = setup({}, ['risk.device_login_accounts_limit', 'risk.merge_tombstone_dedupe']);
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
