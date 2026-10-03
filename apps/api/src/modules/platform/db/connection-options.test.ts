import { inspect } from 'node:util';
import type { createDb } from '@couli/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConfigError } from '../config/index.ts';
import { createRootLogger } from '../logging/index.ts';
import { createDbHandles, loadConnectionConfig } from './index.ts';

type PoolConfig = Parameters<NonNullable<Parameters<typeof createDb>[0]['poolFactory']>>[0];

const driver = vi.hoisted(() => ({
  pools: [] as PoolConfig[],
  parseError: undefined as Error | undefined,
  parameters: undefined as unknown as (config: PoolConfig) => PoolConfig,
  connect: vi.fn(() => {
    throw new Error('Unit tests must not connect to PostgreSQL');
  }),
}));

// Like shutdown.test.ts, keep pg's parser and pool but replace the client transport.
// Even an accidental query fails locally, before a socket can connect.
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<{
    default: {
      Client: new (config: PoolConfig) => { connectionParameters: PoolConfig };
      Pool: new (config: PoolConfig) => object;
    };
  }>();
  class Client extends actual.default.Client {
    constructor(config: PoolConfig) {
      if (driver.parseError) throw driver.parseError;
      super(config);
    }
    connect = driver.connect;
  }
  class Pool extends actual.default.Pool {
    constructor(config: PoolConfig) {
      super(config);
      driver.pools.push(config);
    }
  }
  driver.parameters = (config) => new Client(config).connectionParameters;
  return { ...actual, default: { ...actual.default, Client, Pool } };
});

beforeEach(() => {
  driver.pools = [];
  driver.parseError = undefined;
  driver.connect.mockClear();
});

afterEach(() => vi.restoreAllMocks());

const suffix = '-c default_transaction_read_only=on';
// pg's TypeId declaration omits array OIDs, though its runtime supports them.
const int8ArrayOid = 1016 as Parameters<NonNullable<PoolConfig['types']>['getTypeParser']>[0];

it.each(['p%word', 'p@word', 'p:word', 'p#word', 'p word', 'p\\word'])(
  '[AC-B1-01f#8] 密码 %s 的解析与直接交给 pg 相同，保留连接参数且不暴露密码',
  async (password) => {
    const url = new URL('postgres://couli_readonly@db.example:5434/couli');
    url.password = password;
    // Keep the original equals signs: pg re-encodes the entire URL for a literal %.
    const readUrl = `${url.href}?options=-c%20statement_timeout=12345&sslmode=disable`;
    const config = loadConnectionConfig('admin', {
      DATABASE_URL: readUrl.replace('couli_readonly', 'couli_app'),
      DATABASE_READ_URL: readUrl,
      REDIS_URL: 'redis://127.0.0.1:1/0',
    });
    const direct = driver.parameters({ connectionString: config.dbRead!.url.reveal() });
    const logger = createRootLogger({ entry: 'admin', appEnv: 'test', level: 'silent' });
    const error = vi.spyOn(logger, 'error');
    const handles = createDbHandles(config, { logger });
    try {
      expect(driver.pools).toHaveLength(2);
      const supplied = driver.pools[1]!;
      expect(supplied.connectionString).toBeUndefined();
      const actual = driver.parameters(supplied);
      expect(actual.password).toBe(direct.password);
      expect({ ...actual, password: actual.password }).toEqual({
        ...direct,
        password: direct.password,
        options: `${direct.options} ${suffix}`,
        application_name: 'couli-admin-read',
        keepalives: 1,
      });
      expect(actual.options).toBe(`-c statement_timeout=12345 ${suffix}`);
      expect(supplied.max).toBe(5);
      const primary = driver.pools[0]!;
      expect(primary.connectionString).toBeUndefined();
      expect(driver.parameters(primary)).toEqual({
        ...direct,
        user: 'couli_app',
        application_name: 'couli-admin',
        keepalives: 1,
      });
      expect(driver.parameters(primary).password).toBe(direct.password);
      for (const pool of driver.pools) {
        expect(pool).not.toHaveProperty('binary');
        expect(pool).not.toHaveProperty('client_encoding');
        expect(pool.types?.getTypeParser(20, 'text')('9007199254740993')).toBe(9007199254740993n);
        expect(pool.types?.getTypeParser(int8ArrayOid, 'text')('{9007199254740993,-1}')).toEqual([
          9007199254740993n,
          -1n,
        ]);
      }
      expect(driver.connect).not.toHaveBeenCalled();
      for (const value of [
        inspect(handles, { showHidden: true, depth: null }),
        JSON.stringify(handles),
      ]) {
        expect(value).not.toContain(password);
        expect(value).not.toContain(String(direct.password));
      }
      expect(error).not.toHaveBeenCalled();
    } finally {
      await handles.close();
    }
  },
);

it.each([
  ['', suffix],
  ['-c search_path=x', `-c search_path=x ${suffix}`],
  ['-c search_path=x\\', `-c search_path=x ${suffix}`],
  ['-c search_path=x\\\\', `-c search_path=x\\\\ ${suffix}`],
  ['-c search_path=x\\\\\\', `-c search_path=x\\\\ ${suffix}`],
  ['-c search_path=x\\\\\\\\', `-c search_path=x\\\\\\\\ ${suffix}`],
  ['-c default_transaction_read_only=off', `-c default_transaction_read_only=off ${suffix}`],
])(
  '[AC-B1-01f#9] 原 options=%j 只追加只读参数，去掉末尾未配对的反斜杠',
  async (original, expected) => {
    const config = loadConnectionConfig('admin', {
      DATABASE_URL: 'postgres://couli_app@db.example/couli',
      DATABASE_READ_URL: `postgres://couli_readonly@db.example/couli?options=${encodeURIComponent(original)}`,
      REDIS_URL: 'redis://127.0.0.1:1/0',
    });
    const handles = createDbHandles(config, {
      logger: createRootLogger({ entry: 'admin', appEnv: 'test', level: 'silent' }),
    });
    try {
      expect(driver.parameters(driver.pools[1]!).options).toBe(expected);
      expect(driver.pools[0]!.connectionString).toBeUndefined();
    } finally {
      await handles.close();
    }
  },
);

it('[AC-B1-01f#10] pg 解析连接参数失败时错误不带 URL、口令或原始 cause', () => {
  const secret = 'parse-secret-value';
  const config = loadConnectionConfig('admin', {
    DATABASE_URL: 'postgres://couli_app@db.example/couli',
    DATABASE_READ_URL: `postgres://couli_readonly:${secret}@db.example/couli`,
    REDIS_URL: 'redis://127.0.0.1:1/0',
  });
  let error: unknown;
  driver.parseError = new Error(`Driver error containing ${secret}`);
  try {
    createDbHandles(config, {
      logger: createRootLogger({ entry: 'admin', appEnv: 'test', level: 'silent' }),
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ConfigError);
  expect(error).not.toHaveProperty('cause');
  expect(inspect(error, { showHidden: true, depth: null })).not.toContain(secret);
  expect(JSON.stringify(error)).not.toContain(secret);
});

it.each(['DATABASE_URL', 'DATABASE_READ_URL'] as const)(
  '[AC-B1-01f#11] %s 拒绝改变结果解析的参数、重复参数和无等号参数，不回显值',
  (name) => {
    const secret = 'query-secret-value';
    for (const query of [
      'binary=false',
      `types=${secret}`,
      'client_encoding=SQL_ASCII',
      'sslmode=require&%73slmode=disable',
      'options',
    ]) {
      let error: unknown;
      try {
        loadConnectionConfig('admin', {
          DATABASE_URL: 'postgres://couli_app@db.example/couli',
          DATABASE_READ_URL: 'postgres://couli_readonly@db.example/couli',
          REDIS_URL: 'redis://127.0.0.1:1/0',
          [name]: `postgres://couli_app:${secret}@db.example/couli?${query}`,
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toEqual([
        `${name}: query parameters may only be sslmode (disable, prefer, require, verify-ca or verify-full), sslrootcert, options, password or sslpassword, each at most once`,
      ]);
      expect(error).not.toHaveProperty('cause');
      expect(inspect(error, { showHidden: true, depth: null })).not.toContain(secret);
    }
    expect(driver.pools).toHaveLength(0);
  },
);

it('[AC-B1-01f#12] 编码后的白名单参数名可用，两个池都保留解码后的 options', async () => {
  const url =
    'postgres://couli_app@db.example/couli?%73slmode=disable&%6Fptions=-c%20statement_timeout=7000';
  const config = loadConnectionConfig('admin', {
    DATABASE_URL: url,
    DATABASE_READ_URL: url,
    REDIS_URL: 'redis://127.0.0.1:1/0',
  });
  const handles = createDbHandles(config, {
    logger: createRootLogger({ entry: 'admin', appEnv: 'test', level: 'silent' }),
  });
  try {
    expect(config.db.url.reveal()).toBe(url);
    expect(driver.pools.map((pool) => driver.parameters(pool).options)).toEqual([
      '-c statement_timeout=7000',
      `-c statement_timeout=7000 ${suffix}`,
    ]);
    expect(driver.pools.map((pool) => pool.ssl)).toEqual([false, false]);
    expect(driver.connect).not.toHaveBeenCalled();
  } finally {
    await handles.close();
  }
});
