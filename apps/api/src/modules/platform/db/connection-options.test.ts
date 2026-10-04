import { inspect } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PeerCertificate } from 'node:tls';
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
    constructor(config: PoolConfig) {
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
  driver.connect.mockClear();
});

afterEach(() => vi.restoreAllMocks());

const suffix = '-c default_transaction_read_only=on';
// pg's TypeId declaration omits array OIDs, though its runtime supports them.
const int8ArrayOid = 1016 as Parameters<NonNullable<PoolConfig['types']>['getTypeParser']>[0];

it.each(['p%word', 'p@word', 'p:word', 'p#word', 'p word', 'p\\word'])(
  '[AC-B1-01f#8] 密码 %s 按 URL 解码，保留连接参数且不暴露密码',
  async (password) => {
    const url = new URL('postgres://couli_readonly@db.example:5434/couli');
    url.password = encodeURIComponent(password);
    const readUrl = `${url.href}?options=-c%20statement_timeout=12345&sslmode=disable`;
    const config = loadConnectionConfig('admin', {
      DATABASE_URL: readUrl.replace('couli_readonly', 'couli_app'),
      DATABASE_READ_URL: readUrl,
      REDIS_URL: 'redis://127.0.0.1:1/0',
    });
    const logger = createRootLogger({ entry: 'admin', appEnv: 'test', level: 'silent' });
    const error = vi.spyOn(logger, 'error');
    const handles = createDbHandles(config, { logger });
    try {
      expect(driver.pools).toHaveLength(2);
      const supplied = driver.pools[1]!;
      expect(supplied.connectionString).toBeUndefined();
      const actual = driver.parameters(supplied);
      expect(actual).toMatchObject({
        host: 'db.example',
        port: 5434,
        user: 'couli_readonly',
        password,
        database: 'couli',
        ssl: false,
        application_name: 'couli-admin-read',
        keepalives: 1,
      });
      expect(actual.options).toBe(`-c statement_timeout=12345 ${suffix}`);
      expect(supplied.max).toBe(5);
      const primary = driver.pools[0]!;
      expect(primary.connectionString).toBeUndefined();
      expect(driver.parameters(primary)).toMatchObject({
        password,
        options: '-c statement_timeout=12345',
        user: 'couli_app',
        application_name: 'couli-admin',
        keepalives: 1,
      });
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

it.each([
  'couli%xx:p@db.example/couli',
  'couli:p%word@db.example/couli',
  'couli:p@db.example/cou%li',
])('[AC-B1-01f#10] 非法转义 %s 在加载配置时拒绝，不带原始 cause', (authority) => {
  let error: unknown;
  try {
    loadConnectionConfig('payout', { DATABASE_URL: `postgres://${authority}` });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ConfigError);
  expect((error as ConfigError).problems).toEqual([
    'DATABASE_URL: must be a postgres:// or postgresql:// URL with a user, a host and a database name',
  ]);
  expect(error).not.toHaveProperty('cause');
  expect(inspect(error, { showHidden: true, depth: null })).not.toContain(authority);
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
      'ssl%6dode=verify-full',
      'opti%6Fns=-c%20search_path%3Dapp',
      'ssl+mode=require',
      'sslmode=prefer',
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
        `${name}: query parameters may only be sslmode (disable, require, verify-ca or verify-full), sslrootcert (required by verify-ca, allowed with verify-full), options, password or sslpassword, each at most once and with a literal name`,
      ]);
      expect(error).not.toHaveProperty('cause');
      expect(inspect(error, { showHidden: true, depth: null })).not.toContain(secret);
    }
    expect(driver.pools).toHaveLength(0);
  },
);

it('[AC-B1-01f#12] 用户名、口令、库名解码一次，查询口令优先且 options 用表单解码', async () => {
  const config = loadConnectionConfig('admin', {
    DATABASE_URL:
      'postgres://couli%2Fapp:p%25word@db.example/couli%2Freport?options=-c+statement_timeout%3D7000',
    DATABASE_READ_URL:
      'postgres://couli_readonly:ignored@db.example/couli%252Freport?password=query%25%40%3A%23%2F+word',
    REDIS_URL: 'redis://127.0.0.1:1/0',
  });
  const handles = createDbHandles(config, {
    logger: createRootLogger({ entry: 'admin', appEnv: 'test', level: 'silent' }),
  });
  try {
    expect(driver.pools[0]).toMatchObject({
      host: 'db.example',
      port: 5432,
      user: 'couli/app',
      password: 'p%word',
      database: 'couli/report',
      options: '-c statement_timeout=7000',
      ssl: false,
    });
    expect(driver.pools[1]).toMatchObject({
      password: 'query%@:#/ word',
      database: 'couli%2Freport',
      ssl: false,
    });
    expect(driver.pools.every((pool) => !('connectionString' in pool))).toBe(true);
    expect(driver.connect).not.toHaveBeenCalled();
  } finally {
    await handles.close();
  }
});

const rootPath = fileURLToPath(import.meta.url);
const ca = readFileSync(rootPath, 'utf8');
it.each([
  ['', false],
  ['sslmode=disable', false],
  ['sslmode=require', { rejectUnauthorized: false }],
  [
    'sslmode=verify-full',
    {
      rejectUnauthorized: true,
      servername: 'db.example',
      checkServerIdentity: expect.any(Function),
    },
  ],
  [
    `sslmode=verify-full&sslrootcert=${encodeURIComponent(rootPath)}`,
    {
      rejectUnauthorized: true,
      ca,
      servername: 'db.example',
      checkServerIdentity: expect.any(Function),
    },
  ],
  [
    `sslmode=verify-ca&sslrootcert=${encodeURIComponent(rootPath)}`,
    { rejectUnauthorized: true, ca, checkServerIdentity: expect.any(Function) },
  ],
])('[AC-B1-01f#13] TLS 设置显式构造：%s', async (query, expected) => {
  const url = `postgres://couli_app:p%25word@db.example/couli?${query}`;
  const config = loadConnectionConfig('admin', {
    DATABASE_URL: url,
    DATABASE_READ_URL: url,
    REDIS_URL: 'redis://127.0.0.1:1/0',
  });
  const handles = createDbHandles(config, {
    logger: createRootLogger({ entry: 'admin', appEnv: 'test', level: 'silent' }),
  });
  try {
    for (const pool of driver.pools) {
      expect(pool.ssl).toEqual(expected);
      expect(pool).not.toHaveProperty('connectionString');
      if (
        query.startsWith('sslmode=verify-ca') &&
        typeof pool.ssl === 'object' &&
        pool.ssl.checkServerIdentity
      ) {
        expect(pool.ssl.checkServerIdentity('mismatched.example', {} as never)).toBeUndefined();
      }
    }
    expect(driver.connect).not.toHaveBeenCalled();
  } finally {
    await handles.close();
  }
});

it('[AC-B1-01f#14] 根证书读取失败在配置加载时报固定错误，不暴露路径', () => {
  let error: unknown;
  try {
    loadConnectionConfig('payout', {
      DATABASE_URL:
        'postgres://couli_payout@db.example/couli?sslmode=verify-full&sslrootcert=missing-private-ca.pem',
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ConfigError);
  expect((error as ConfigError).problems).toEqual(['DATABASE_URL: sslrootcert could not be read']);
  expect(error).not.toHaveProperty('cause');
  expect(inspect(error, { showHidden: true, depth: null })).not.toContain('missing-private-ca.pem');
  expect(driver.pools).toHaveLength(0);
});

it.each([
  ['10.0.0.10', 'db.internal', false],
  ['db.internal', '10.0.0.10', true],
] as const)(
  '[AC-B1-01f#16] verify-full 分别绑定主库 %s 与只读库 %s 的主机（自定 CA：%s）',
  async (primaryHost, readHost, withCa) => {
    const query = `sslmode=verify-full${withCa ? `&sslrootcert=${encodeURIComponent(rootPath)}` : ''}`;
    const config = loadConnectionConfig('admin', {
      DATABASE_URL: `postgres://couli_app@${primaryHost}/couli?${query}`,
      DATABASE_READ_URL: `postgres://couli_readonly@${readHost}/couli?${query}`,
      REDIS_URL: 'redis://127.0.0.1:1/0',
    });
    const handles = createDbHandles(config, {
      logger: createRootLogger({ entry: 'admin', appEnv: 'test', level: 'silent' }),
    });
    try {
      expect(driver.pools).toHaveLength(2);
      for (const [index, host] of [primaryHost, readHost].entries()) {
        const ssl = driver.pools[index]!.ssl;
        expect(ssl).toEqual({
          rejectUnauthorized: true,
          ...(withCa ? { ca } : {}),
          ...(host === 'db.internal' ? { servername: host } : {}),
          checkServerIdentity: expect.any(Function),
        });
        if (typeof ssl !== 'object' || !ssl.checkServerIdentity) {
          throw new Error('Missing certificate identity check');
        }
        for (const suppliedName of ['localhost', '10.0.0.10', 'db.internal', 'other.internal']) {
          for (const [subjectaltname, matches] of [
            ['DNS:localhost', false],
            ['DNS:10.0.0.10', false],
            ['IP Address:10.0.0.11', false],
            ['IP Address:10.0.0.10', host === '10.0.0.10'],
            ['DNS:db.internal', host === 'db.internal'],
          ] as const) {
            const cert = { subject: { CN: 'localhost' }, subjectaltname } as PeerCertificate;
            const error = ssl.checkServerIdentity(suppliedName, cert);
            if (matches) expect(error).toBeUndefined();
            else {
              expect(error).toBeInstanceOf(Error);
              expect(error).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID', host });
            }
          }
        }
      }
      expect(driver.connect).not.toHaveBeenCalled();
    } finally {
      await handles.close();
    }
  },
);

it.each(['DATABASE_URL', 'DATABASE_READ_URL'] as const)(
  '[AC-B1-01f#17] %s 各连接字段拒绝所有 C0 与 DEL，覆盖已被查询口令取代的 userinfo 口令',
  (name) => {
    const controls = Array.from({ length: 32 }, (_, code) => code).concat(127);
    for (const code of controls) {
      const value = `private${encodeURIComponent(String.fromCharCode(code))}value`;
      for (const url of [
        `postgres://${value}:secret@db.internal/couli`,
        `postgres://couli_app:${value}@db.internal/couli`,
        `postgres://couli_app:${value}@db.internal/couli?password=override`,
        `postgres://couli_app@db.internal/${value}`,
        `postgres://couli_app@db.internal/couli?password=${value}`,
        `postgres://couli_app@db.internal/couli?options=${value}`,
      ]) {
        let error: unknown;
        try {
          const config = loadConnectionConfig('admin', {
            DATABASE_URL: 'postgres://couli_app@db.internal/couli',
            DATABASE_READ_URL: 'postgres://couli_readonly@db.internal/couli',
            REDIS_URL: 'redis://127.0.0.1:1/0',
            [name]: url,
          });
          void createDbHandles(config, {
            logger: createRootLogger({ entry: 'admin', appEnv: 'test', level: 'silent' }),
          }).close();
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).problems).toEqual([
          `${name}: connection fields may not contain control characters`,
        ]);
        expect(error).not.toHaveProperty('cause');
        expect(inspect(error, { showHidden: true, depth: null })).not.toContain('private');
      }
    }
    expect(driver.pools).toHaveLength(0);
    expect(driver.connect).not.toHaveBeenCalled();
  },
);
