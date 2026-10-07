// Unit tests of the registration service without a database: Kysely runs on a scripted driver
// that answers each compiled statement from an in-memory registry (device records, phones held)
// and records every statement, to pin the time base of the registration source record (Codex
// money review S1), the isolation guard, the phone check before the device limit, the RELEASE
// failure of a port, the error fields logged, and the command checks. The SQL itself (locks,
// savepoints, constraints) runs against PostgreSQL in the rule tests
// (test/spec/identity/registration).
import { randomBytes } from 'node:crypto';
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
import { expect, it, vi } from 'vitest';
import { FixedClock, createRootLogger, type FieldCrypto } from '../../platform/index.ts';
import type { DeviceRegistrationRecord } from '../domain/registration.ts';
import {
  bindResultOf,
  checkCommand,
  createRegistrationService,
  errorFields,
  REGISTRATION_CONFIG_KEYS,
  snapshotRegistrationConfig,
  type RegistrationCommand,
  type RegistrationOptions,
} from './registration.ts';

const PHONE = '13912345678';
const DB_NOW = new Date('2026-10-06T02:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}
type Reply = (statement: Statement) => readonly unknown[] | Error | undefined;

/** Column → parameter of an `insert into "t" ("a", "b") values ($1, $2)` statement. */
function insertedRow(statement: Statement): Record<string, unknown> {
  const columns = /\(([^)]*)\) values/.exec(statement.sql)?.[1];
  if (columns === undefined) throw new Error('not an insert');
  const row: Record<string, unknown> = {};
  columns
    .split(',')
    .map((column) => column.trim().replaceAll('"', ''))
    .forEach((column, index) => {
      row[column] = statement.parameters[index];
    });
  return row;
}

function setup(
  overrides: {
    isolation?: string;
    phoneHeld?: boolean;
    reply?: Reply;
    clock?: FixedClock;
    ports?: Partial<RegistrationOptions>;
    config?: Record<string, unknown>;
  } = {},
) {
  const statements: Statement[] = [];
  const records: DeviceRegistrationRecord[] = [];
  function answer(statement: Statement): readonly unknown[] {
    const scripted = overrides.reply?.(statement);
    if (scripted instanceof Error) throw scripted;
    if (scripted !== undefined) return scripted;
    const text = statement.sql;
    if (text.includes("current_setting('transaction_isolation')")) {
      return [{ isolation: overrides.isolation ?? 'read committed' }];
    }
    if (text.startsWith('select') && text.includes('from "users"')) {
      return overrides.phoneHeld === true ? [{ id: 'held' }] : [];
    }
    if (text.startsWith('select') && text.includes('from "device_registrations"')) {
      // The window is applied again by countDeviceRegistrations; the fake returns every record.
      return records;
    }
    if (text.startsWith('insert into "device_registrations"')) {
      const row = insertedRow(statement);
      records.push({
        app_id: row.app_id as string,
        device_hash: row.device_hash as string,
        user_id: row.user_id as string,
        created_at: row.created_at as Date,
        merged_into_user_id: null,
      });
    }
    return [];
  }
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const statement = { sql: compiled.sql, parameters: compiled.parameters };
      statements.push(statement);
      try {
        return Promise.resolve({ rows: answer(statement) as R[] });
      } catch (error) {
        return Promise.reject(error as Error);
      }
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
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const lines: string[] = [];
  const clock = overrides.clock ?? new FixedClock(DB_NOW);
  const crypto = {
    encrypt: (plaintext: string) => `v1.1.${Buffer.from(plaintext).toString('base64url')}`,
    blindIndex: () => 'b'.repeat(64),
  } as unknown as FieldCrypto;
  const config = overrides.config ?? {};
  const options: RegistrationOptions = {
    clock,
    crypto,
    config: {
      configValue: async (_app: string, key: string) =>
        key in config ? { value: config[key], version: 1 } : null,
    },
    logger: createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      { write: (line: string) => void lines.push(line) },
    ),
    sensitiveWords: { matches: () => false },
    ...overrides.ports,
  };
  const service = createRegistrationService(options);
  const deviceHash = randomBytes(32).toString('hex');
  const command: RegistrationCommand = {
    app_id: 'couli',
    phone: PHONE,
    register_method: 'sms',
    device_hash: deviceHash,
    client_ip: '192.0.2.7',
  };
  return {
    statements,
    records,
    lines,
    clock,
    command,
    /** `withoutDevice`: the command carries no device_hash (landing page, admin, a caller bug). */
    register: (changes: Partial<RegistrationCommand> = {}, withoutDevice = false) => {
      const { device_hash, ...rest } = { ...command, ...changes };
      const final: RegistrationCommand = withoutDevice
        ? rest
        : { ...rest, ...(device_hash === undefined ? {} : { device_hash }) };
      return db.transaction().execute((trx) => service.register(trx, final));
    },
    logged: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

it('[S1][BR-ID-05] 时钟领先库时间 40 天，来源记录 created_at 取建号同一 Clock 时刻，连续建号第 4 次仍 44001', async () => {
  const clock = new FixedClock(new Date(DB_NOW.getTime() + 40 * DAY));
  const ctx = setup({ clock });
  const written: Date[] = [];
  for (let i = 0; i < 3; i++) {
    const result = await ctx.register({ phone: `1391234567${i}` });
    expect(result).toMatchObject({ code: 0 });
    written.push(clock.now());
    clock.advanceMs(60_000);
  }
  expect(ctx.records.map((record) => record.created_at)).toEqual(written);
  expect(await ctx.register({ phone: '13912345673' })).toMatchObject({
    code: 44001,
    count: 3,
    limit: 3,
  });
  expect(ctx.records).toHaveLength(3);
});

it('[S1] 来源记录 created_at 与 users.created_at、计数窗口终点是同一个时刻', async () => {
  const ctx = setup();
  expect(await ctx.register()).toMatchObject({ code: 0 });
  const now = ctx.clock.now();
  const user = insertedRow(ctx.statements.find((s) => s.sql.startsWith('insert into "users"'))!);
  const registration = insertedRow(
    ctx.statements.find((s) => s.sql.startsWith('insert into "device_registrations"'))!,
  );
  const window = ctx.statements.find(
    (s) => s.sql.startsWith('select') && s.sql.includes('from "device_registrations"'),
  )!;
  expect(registration.created_at).toEqual(now);
  expect(user.created_at).toEqual(now);
  expect(window.parameters).toContainEqual(now);
});

it('[S3-1] 带设备建号时事务隔离级别为快照级（repeatable read / serializable）→ 50001，不加锁不写入', async () => {
  for (const isolation of ['repeatable read', 'serializable']) {
    const ctx = setup({ isolation });
    expect(await ctx.register()).toEqual({ code: 50001 });
    expect(ctx.statements.some((s) => s.sql.includes('pg_advisory_xact_lock'))).toBe(false);
    expect(ctx.statements.some((s) => s.sql.startsWith('insert'))).toBe(false);
    expect(ctx.logged()).toContainEqual(
      expect.objectContaining({
        msg: 'registration_failed',
        error_class: 'RegistrationIsolationError',
      }),
    );
  }
});

it('[S3-1] read committed 带设备照常建号；落地页无设备不查隔离级别', async () => {
  expect(await setup().register()).toMatchObject({ code: 0 });
  const landing = setup({ isolation: 'serializable' });
  expect(await landing.register({ register_method: 'h5_landing' }, true)).toMatchObject({
    code: 0,
  });
  expect(landing.statements.some((s) => s.sql.includes('transaction_isolation'))).toBe(false);
});

it('[S3-2][BR-ID-05] 手机号已有未注销账号，设备已满也返回 phone_taken，不判上限、不调放行端口', async () => {
  const allow = vi.fn(async () => true);
  const ctx = setup({ phoneHeld: true, ports: { allowBlockedRegistration: allow } });
  for (let i = 0; i < 3; i++) {
    ctx.records.push({
      app_id: 'couli',
      device_hash: ctx.command.device_hash!,
      user_id: `seed-${i}`,
      created_at: ctx.clock.now(),
      merged_into_user_id: null,
    });
  }
  expect(await ctx.register()).toEqual({ outcome: 'phone_taken' });
  expect(allow).not.toHaveBeenCalled();
  const lock = ctx.statements.findIndex((s) => s.sql.includes('pg_advisory_xact_lock'));
  const held = ctx.statements.findIndex(
    (s) => s.sql.startsWith('select') && s.sql.includes('from "users"'),
  );
  expect(lock).toBeGreaterThanOrEqual(0);
  expect(held).toBeGreaterThan(lock);
  expect(ctx.statements.some((s) => s.sql.startsWith('insert'))).toBe(false);
  expect(ctx.records).toHaveLength(3);
});

it('[S3-2] 第三方无手机号不查手机号占用', async () => {
  const ctx = setup({ phoneHeld: true });
  expect(await ctx.register({ phone: null, register_method: 'wechat' })).toMatchObject({ code: 0 });
  expect(
    ctx.statements.some((s) => s.sql.startsWith('select') && s.sql.includes('from "users"')),
  ).toBe(false);
});

it('[S3-3][BR-INV-06] 绑定端口吞掉自身 SQL 失败后返回 bound：RELEASE 失败 → 回滚到绑定 savepoint，账号照常、{failed, 50001}', async () => {
  const bindInvite = vi.fn(async () => ({ result: 'bound' as const, code: null }));
  let failed = false;
  const ctx = setup({
    ports: { bindInvite },
    reply: (s) => {
      // Only the first RELEASE fails (the one after the port); the rollback's own RELEASE succeeds.
      if (s.sql === 'RELEASE SAVEPOINT identity_registration_invite_bind' && !failed) {
        failed = true;
        return Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
      }
      return undefined;
    },
  });
  const result = await ctx.register({ invite_code: 'ABCDEF' });
  expect(result).toMatchObject({ code: 0, invite_bind: { result: 'failed', code: 50001 } });
  expect(ctx.statements.map((s) => s.sql)).toContain(
    'ROLLBACK TO SAVEPOINT identity_registration_invite_bind',
  );
  expect(ctx.statements.map((s) => s.sql)).toContain('RELEASE SAVEPOINT identity_registration');
  expect(ctx.logged()).toContainEqual(
    expect.objectContaining({
      msg: 'registration_invite_bind_failed',
      sqlstate: '25P02',
      level: 40,
    }),
  );
});

it('[S3-3] B1-03g 端口吞掉自身 SQL 失败：RELEASE 失败 → 回滚到其 savepoint，建号成功', async () => {
  let failed = false;
  const ctx = setup({
    ports: { afterRegistered: async () => undefined },
    reply: (s) => {
      if (s.sql === 'RELEASE SAVEPOINT identity_registration_after' && !failed) {
        failed = true;
        return Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
      }
      return undefined;
    },
  });
  expect(await ctx.register()).toMatchObject({ code: 0 });
  expect(ctx.statements.map((s) => s.sql)).toContain(
    'ROLLBACK TO SAVEPOINT identity_registration_after',
  );
  expect(ctx.logged()).toContainEqual(
    expect.objectContaining({ msg: 'registration_after_registered_failed', sqlstate: '25P02' }),
  );
});

it('[S3-4] 意外数据库异常 → 50001，日志带 SQLSTATE、constraint、table，不带 message / detail 与手机号', async () => {
  const ctx = setup({
    reply: (s) =>
      s.sql.startsWith('insert into "users"')
        ? Object.assign(new Error(`violates check for ${PHONE}`), {
            code: '23514',
            constraint: 'users_level_check',
            table: 'users',
            detail: `Failing row contains (${PHONE}).`,
          })
        : undefined,
  });
  expect(await ctx.register()).toEqual({ code: 50001 });
  expect(ctx.logged()).toContainEqual(
    expect.objectContaining({
      msg: 'registration_failed',
      sqlstate: '23514',
      constraint: 'users_level_check',
      table: 'users',
      level: 50,
    }),
  );
  expect(ctx.lines.join('')).not.toContain(PHONE);
  expect(ctx.lines.join('')).not.toContain('Failing row');
});

it('[S3-4] errorFields 只取类名与格式正确的 SQLSTATE、标识符', () => {
  expect(errorFields(new TypeError('x 13912345678'))).toEqual({ error_class: 'TypeError' });
  expect(
    errorFields(
      Object.assign(new Error('m'), {
        code: '23505',
        constraint: 'users_attr_code_key',
        table: 'users',
      }),
    ),
  ).toEqual({
    error_class: 'Error',
    sqlstate: '23505',
    constraint: 'users_attr_code_key',
    table: 'users',
  });
  expect(
    errorFields(Object.assign(new Error('m'), { code: 'ECONNRESET', constraint: 'a b', table: 3 })),
  ).toEqual({ error_class: 'Error' });
  expect(errorFields(null)).toEqual({ error_class: 'null' });
  expect(errorFields('boom')).toEqual({ error_class: 'string' });
});

it('[S3-8][BR-ID-05] App 端注册方式不带 device_hash 打 warn；落地页与 admin 不打', async () => {
  for (const register_method of ['sms', 'wechat', 'apple', 'huawei'] as const) {
    const ctx = setup();
    const phone = register_method === 'sms' ? PHONE : null;
    expect(await ctx.register({ register_method, phone }, true)).toMatchObject({
      code: 0,
    });
    expect(ctx.logged()).toContainEqual(
      expect.objectContaining({
        msg: 'registration_device_hash_missing',
        level: 40,
        register_method,
      }),
    );
  }
  for (const register_method of ['h5_landing', 'admin'] as const) {
    const ctx = setup();
    expect(await ctx.register({ register_method }, true)).toMatchObject({
      code: 0,
    });
    expect(ctx.logged().some((line) => line.msg === 'registration_device_hash_missing')).toBe(
      false,
    );
  }
});

const VALID: RegistrationCommand = {
  app_id: 'couli',
  phone: PHONE,
  register_method: 'sms',
  device_hash: 'a'.repeat(64),
  client_ip: '192.0.2.7',
};

it('[S3-6] checkCommand 接受合法命令与可缺省字段', () => {
  expect(() => checkCommand(VALID)).not.toThrow();
  expect(() =>
    checkCommand({ ...VALID, phone: null, register_method: 'wechat', third_party_digest: null }),
  ).not.toThrow();
  expect(() =>
    checkCommand({
      ...VALID,
      channel: 'c',
      device_id: 'd',
      invite_code: '',
      third_party_digest: 'x',
    }),
  ).not.toThrow();
  expect(() =>
    checkCommand({ app_id: 'couli', phone: PHONE, register_method: 'h5_landing', client_ip: '' }),
  ).not.toThrow();
});

it('[S3-6] checkCommand 拒绝调用方错误', () => {
  const bad: unknown[] = [
    { ...VALID, app_id: '' },
    { ...VALID, app_id: 1 },
    { ...VALID, register_method: 'email' },
    { ...VALID, phone: null },
    { ...VALID, phone: null, register_method: 'h5_landing' },
    { ...VALID, phone: '+8613912345678' },
    { ...VALID, phone: '1391234567' },
    { ...VALID, phone: 13912345678 },
    { ...VALID, device_hash: 'A'.repeat(64) },
    { ...VALID, device_hash: 'a'.repeat(63) },
    { ...VALID, channel: 1 },
    { ...VALID, device_id: null },
    { ...VALID, invite_code: 5 },
    { ...VALID, third_party_digest: 7 },
    { ...VALID, client_ip: undefined },
    { ...VALID, config: {} },
  ];
  for (const command of bad) {
    expect(() => checkCommand(command as RegistrationCommand)).toThrow(TypeError);
  }
});

it('[S3-6][BR-INV-06] bindResultOf 只接受契约形状的绑定结果', () => {
  expect(bindResultOf({ result: 'bound', code: null })).toEqual({ result: 'bound', code: null });
  expect(bindResultOf({ result: 'bound' })).toEqual({ result: 'bound', code: null });
  expect(bindResultOf({ result: 'ignored_existing_user', code: null })).toEqual({
    result: 'ignored_existing_user',
    code: null,
  });
  for (const code of [30401, 30403, 30408, 42901, 50001]) {
    expect(bindResultOf({ result: 'failed', code })).toEqual({ result: 'failed', code });
  }
  const invalid: unknown[] = [
    null,
    undefined,
    'bound',
    {},
    { result: 'bound', code: 30401 },
    { result: 'failed' },
    { result: 'failed', code: null },
    { result: 'failed', code: 40001 },
    { result: 'failed', code: '30401' },
    { result: 'unknown', code: null },
  ];
  for (const value of invalid) expect(bindResultOf(value)).toBeNull();
});

it('[S1][BR-ID-05] 按调用传入的配置快照优先于 options.config：快照上限 1 时同设备第 2 次建号 44001，默认读取器零调用', async () => {
  const fallback = vi.fn(async () => ({ value: 3, version: 1 }));
  const ctx = setup({ ports: { config: { configValue: fallback } } });
  const source = vi.fn(async (_app: string, key: string) =>
    key === 'risk.device_register_limit' ? { value: 1, version: 7 } : null,
  );
  const config = await snapshotRegistrationConfig({ configValue: source }, 'couli');
  expect(source.mock.calls.map(([, key]) => key)).toEqual([...REGISTRATION_CONFIG_KEYS]);
  expect(await ctx.register({ config })).toMatchObject({ code: 0 });
  expect(await ctx.register({ phone: '13912345670', config })).toMatchObject({
    code: 44001,
    count: 1,
    limit: 1,
  });
  expect(source).toHaveBeenCalledTimes(REGISTRATION_CONFIG_KEYS.length);
  expect(fallback).not.toHaveBeenCalled();
});

it('[S1] 配置快照只读一次：之后的读取不再调用来源；别的 app 或快照外的键直接报错', async () => {
  const source = vi.fn(async (_app: string, key: string) => ({ value: key, version: 2 }));
  const snapshot = await snapshotRegistrationConfig({ configValue: source }, 'couli');
  expect(source).toHaveBeenCalledTimes(3);
  expect(REGISTRATION_CONFIG_KEYS).toEqual([
    'level.default',
    'risk.merge_tombstone_dedupe',
    'risk.device_register_limit',
  ]);
  expect(await snapshot.configValue('couli', 'level.default')).toEqual({
    value: 'level.default',
    version: 2,
  });
  await expect(snapshot.configValue('other', 'level.default')).rejects.toThrow(/snapshot/);
  await expect(snapshot.configValue('couli', 'risk.other')).rejects.toThrow(/snapshot/);
  expect(source).toHaveBeenCalledTimes(3);
});

it('[S1] 按调用传入的 config 不转给绑定端口与 B1-03g 端口', async () => {
  const afterRegistered = vi.fn<NonNullable<RegistrationOptions['afterRegistered']>>(
    async () => undefined,
  );
  const ctx = setup({ ports: { afterRegistered } });
  const config = await snapshotRegistrationConfig({ configValue: async () => null }, 'couli');
  expect(await ctx.register({ config })).toMatchObject({ code: 0 });
  expect(afterRegistered).toHaveBeenCalledTimes(1);
  expect(afterRegistered.mock.calls[0]![1]).not.toHaveProperty('config');
});
