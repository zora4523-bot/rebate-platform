import { inspect } from 'node:util';
import type { createDb } from '@couli/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConfigError } from '../config/index.ts';
import { createRootLogger } from '../logging/index.ts';
import { createDbHandles, loadConnectionConfig } from './index.ts';

type PoolConfig = Parameters<NonNullable<Parameters<typeof createDb>[0]['poolFactory']>>[0];

const driver = vi.hoisted(() => ({
  pools: [] as PoolConfig[],
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
  driver.connect.mockClear();
});

afterEach(() => vi.restoreAllMocks());

const suffix = '-c default_transaction_read_only=on';

it.each(['p%word', 'p@word', 'p:word', 'p#word', 'p word', 'p\\word'])(
  '[AC-B1-01f#8] 密码 %s 的解析与直接交给 pg 相同，保留连接参数且不暴露密码',
  async (password) => {
    const url = new URL('postgres://couli_readonly@db.example:5434/couli');
    url.password = password;
    // Keep the original equals signs: pg re-encodes the entire URL for a literal %.
    const readUrl = `${url.href}?options=-c%20statement_timeout=12345&sslmode=no-verify&application_name=report&client_encoding=UTF8`;
    const config = loadConnectionConfig('admin', {
      DATABASE_URL: 'postgres://couli_app@db.example:5433/couli',
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
        keepalives: 1,
      });
      expect(actual.options).toBe(`-c statement_timeout=12345 ${suffix}`);
      expect(supplied.max).toBe(5);
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
      expect(driver.pools[0]!.connectionString).toBe(config.db.url.reveal());
    } finally {
      await handles.close();
    }
  },
);

it('[AC-B1-01f#10] pg 解析连接参数失败时错误不带 URL、口令或原始 cause', () => {
  const secret = 'parse-secret-value';
  const config = loadConnectionConfig('admin', {
    DATABASE_URL: 'postgres://couli_app@db.example/couli',
    DATABASE_READ_URL: `postgres://couli_readonly:${secret}@db.example/couli?sslnegotiation=${secret}`,
    REDIS_URL: 'redis://127.0.0.1:1/0',
  });
  let error: unknown;
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
