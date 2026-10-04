// Rule tests for loadConnectionConfig and POOL_SIZES (ADR-0001 §4.2 第 11 项 连接池、第 20 项
// payout 不读 Redis; ADR-0002 §5 admin 报表的 dbRead; 规划/02 §3.1 payout 一行「不连 Redis」;
// contract sections 1–3 of apps/api/src/modules/platform/db/index.ts). Expected values are written
// out by hand. Unit tests: no database, no port. Top-level it() only (规划/11 §4.3).
import { afterEach, expect, it, vi } from 'vitest';
import {
  ConnectionUrl,
  POOL_SIZES,
  loadConnectionConfig,
  type ConnectionConfig,
  type DbPoolConfig,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  ENTRIES,
  REQUIRED,
  SIZES,
  configErrorOf,
  configErrorProblems,
  describeError,
  envFor,
  ignoredBy,
  malformed,
  missing,
  pgRedactedOf,
  pgUrlOf,
  phraseOf,
  REDIS_REDACTED,
  thrown,
  urlsOf,
  type Entry,
  type VarName,
} from './kit.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

interface UrlView {
  readonly isConnectionUrl: boolean;
  readonly redacted: string;
  readonly reveal: string;
}

function urlView(url: unknown): UrlView | string {
  if (!(url instanceof ConnectionUrl)) return `not a ConnectionUrl: ${String(url)}`;
  return { isConnectionUrl: true, redacted: url.redacted, reveal: url.reveal() };
}

function poolView(pool: DbPoolConfig | null): unknown {
  if (pool === null) return null;
  return {
    plain: Object.getPrototypeOf(pool) === Object.prototype,
    frozen: Object.isFrozen(pool),
    keys: Reflect.ownKeys(pool).map(String).sort(),
    name: pool.name,
    url: urlView(pool.url),
    max: pool.max,
    applicationName: pool.applicationName,
    readOnly: pool.readOnly,
  };
}

/** Everything the contract fixes about a ConnectionConfig, as plain data; or what went wrong. */
function view(run: () => ConnectionConfig): unknown {
  let config: ConnectionConfig;
  try {
    config = run();
  } catch (error) {
    return describeError(error);
  }
  return {
    plain: Object.getPrototypeOf(config) === Object.prototype,
    frozen: Object.isFrozen(config),
    keys: Reflect.ownKeys(config).map(String).sort(),
    entry: config.entry,
    db: poolView(config.db),
    dbRead: poolView(config.dbRead),
    redisUrl: config.redisUrl === null ? null : urlView(config.redisUrl),
  };
}

const POOL_KEYS = ['applicationName', 'max', 'name', 'readOnly', 'url'];

function expectedPool(
  name: 'db' | 'dbRead',
  url: string,
  redacted: string,
  max: number,
  applicationName: string,
): unknown {
  return {
    plain: true,
    frozen: true,
    keys: POOL_KEYS,
    name,
    url: { isConnectionUrl: true, redacted, reveal: url },
    max,
    applicationName,
    readOnly: name === 'dbRead',
  };
}

/** What loadConnectionConfig must return for a complete environment, written out by hand. */
function expectedConfig(entry: Entry, env: Record<VarName, string>): unknown {
  const sizes = SIZES[entry];
  return {
    plain: true,
    frozen: true,
    keys: ['db', 'dbRead', 'entry', 'redisUrl'],
    entry,
    db: expectedPool('db', env.DATABASE_URL, pgRedactedOf('couli_app'), sizes.db, `couli-${entry}`),
    dbRead:
      entry === 'admin'
        ? expectedPool(
            'dbRead',
            env.DATABASE_READ_URL,
            pgRedactedOf('couli_readonly'),
            5,
            'couli-admin-read',
          )
        : null,
    redisUrl:
      entry === 'payout'
        ? null
        : { isConnectionUrl: true, redacted: REDIS_REDACTED, reveal: env.REDIS_URL },
  };
}

for (const entry of ENTRIES) {
  it(`[ADR-0001 §4.2 #11, #20; ADR-0002 §5] ${entry}：变量齐全时得到确切的连接配置——主库池大小 ${String(SIZES[entry].db)}${entry === 'admin' ? '、只读池 5' : '、没有 dbRead'}${entry === 'payout' ? '、不带 Redis' : ''}，POOL_SIZES 同值且冻结`, () => {
    const { env } = urlsOf(`config.${entry}`);
    const sizes = SIZES[entry];
    expect({
      poolSizes: POOL_SIZES[entry],
      frozen: Object.isFrozen(POOL_SIZES) && Object.isFrozen(POOL_SIZES[entry]),
      config: view(() => loadConnectionConfig(entry, envFor(entry, env))),
    }).toStrictEqual({
      poolSizes: sizes,
      frozen: true,
      config: expectedConfig(entry, env),
    });
  });
}

for (const entry of ENTRIES) {
  for (const name of REQUIRED[entry]) {
    it(`[ADR-0001 §4.2 #11, #20; 规划/02 §3.1] ${entry} 缺 ${name}（未设或空串）就拒绝启动：ConfigError 只列这一条，文案确切`, () => {
      const { env } = urlsOf(`missing.${entry}.${name}`);
      const full = envFor(entry, env);
      const unset: Record<string, string> = { ...full };
      delete unset[name];
      const empty = { ...full, [name]: '' };
      const lowerCase = { ...unset, [name.toLowerCase()]: full[name] ?? '' };
      expect({
        unset: problemsOrWhat(() => loadConnectionConfig(entry, unset), [missing(name, entry)]),
        empty: problemsOrWhat(() => loadConnectionConfig(entry, empty), [missing(name, entry)]),
        lowerCase: problemsOrWhat(
          () => loadConnectionConfig(entry, lowerCase),
          [missing(name, entry)],
        ),
      }).toStrictEqual({ unset: [], empty: [], lowerCase: [] });
    });
  }
}

/** configErrorProblems of what `run` throws against `problems` (empty list = exactly that error). */
function problemsOrWhat(run: () => unknown, problems: readonly string[]): string[] {
  const error = configErrorOf(run);
  return typeof error === 'string' ? [error] : configErrorProblems(error, problems);
}

for (const entry of ENTRIES) {
  it(`[ADR-0001 §4.2 #11, #20] ${entry} 一个变量都没有：按 DATABASE_URL、DATABASE_READ_URL、REDIS_URL 的顺序列出它要的每一个，其余变量不影响`, () => {
    const expected = REQUIRED[entry].map((name) => missing(name, entry));
    expect({
      empty: problemsOrWhat(() => loadConnectionConfig(entry, {}), expected),
      unrelated: problemsOrWhat(
        () =>
          loadConnectionConfig(entry, {
            APP_ENV: 'test',
            PATH: '/usr/bin',
            MIGRATOR_DATABASE_URL: pgUrlOf('couli_migrator', phraseOf('migrator')),
            DATABASE_URL_RO: pgUrlOf('couli_readonly', phraseOf('ro')),
            PG_ADMIN_URL: 'not a url',
          }),
        expected,
      ),
    }).toStrictEqual({ empty: [], unrelated: [] });
  });
}

/** Malformed postgres URLs; each carries the password `phrase` where the URL has room for one. */
function malformedPg(phrase: string): string[] {
  const pw = encodeURIComponent(phrase);
  return [
    `mysql://couli_app:${pw}@127.0.0.1:1/couli`,
    `http://couli_app:${pw}@127.0.0.1:1/couli`,
    `redis://couli_app:${pw}@127.0.0.1:1/couli`,
    `postgres://:${pw}@127.0.0.1:1/couli`,
    `postgres://127.0.0.1:1/couli`,
    `postgres://couli_app:${pw}@127.0.0.1:1`,
    `postgres://couli_app:${pw}@127.0.0.1:1/`,
    `postgres:///couli`,
    `postgres://couli_app:${pw}@/couli`,
    `postgres://couli_app:${pw}@127.0.0.1:99999/couli`,
    `couli_app:${pw}@127.0.0.1:1/couli`,
    `//couli_app:${pw}@127.0.0.1:1/couli`,
    pw,
    ' ',
  ];
}

/** Malformed Redis URLs, the same way. */
function malformedRedis(phrase: string): string[] {
  const pw = encodeURIComponent(phrase);
  return [
    `http://:${pw}@127.0.0.1:1/0`,
    `postgres://couli_app:${pw}@127.0.0.1:1/couli`,
    'redis://',
    'redis:127.0.0.1',
    `rediss://:${pw}@/0`,
    `redis://:${pw}@127.0.0.1:99999/0`,
    `//:${pw}@127.0.0.1:1/0`,
    pw,
    ' ',
  ];
}

const MALFORMED_CASES: readonly (readonly [VarName, Entry])[] = [
  ...ENTRIES.map((entry) => ['DATABASE_URL', entry] as const),
  ['DATABASE_READ_URL', 'admin'],
  ...ENTRIES.filter((entry) => entry !== 'payout').map((entry) => ['REDIS_URL', entry] as const),
];

for (const [name, entry] of MALFORMED_CASES) {
  it(`[ADR-0001 §4.2 #11; 规划/02 §12.6] ${entry} 的 ${name} 格式不对就拒绝启动：每种坏值都只报这一条固定文案，不回显值里的任何部分（含口令）`, () => {
    const { env } = urlsOf(`malformed.${entry}.${name}`);
    const phrase = phraseOf(`malformed.${entry}.${name}.value`);
    const values = name === 'REDIS_URL' ? malformedRedis(phrase) : malformedPg(phrase);
    const outcomes = values.map((value) =>
      problemsOrWhat(
        () => loadConnectionConfig(entry, { ...envFor(entry, env), [name]: value }),
        [malformed(name)],
      ),
    );
    expect(outcomes).toStrictEqual(values.map(() => []));
  });
}

it('[ADR-0001 §4.2 #11] 多个问题一次报全：admin 三个都坏按顺序三条；api 缺主库又坏 Redis 两条；payout 只看 DATABASE_URL', () => {
  const phrase = phraseOf('several');
  const badPg = `mysql://couli_app:${encodeURIComponent(phrase)}@127.0.0.1:1/couli`;
  const badRedis = `http://:${encodeURIComponent(phrase)}@127.0.0.1:1/0`;
  expect({
    admin: problemsOrWhat(
      () =>
        loadConnectionConfig('admin', {
          DATABASE_URL: badPg,
          DATABASE_READ_URL: badPg,
          REDIS_URL: badRedis,
        }),
      [malformed('DATABASE_URL'), malformed('DATABASE_READ_URL'), malformed('REDIS_URL')],
    ),
    api: problemsOrWhat(
      () => loadConnectionConfig('api', { REDIS_URL: badRedis, DATABASE_READ_URL: badPg }),
      [missing('DATABASE_URL', 'api'), malformed('REDIS_URL')],
    ),
    payout: problemsOrWhat(
      () =>
        loadConnectionConfig('payout', {
          DATABASE_URL: badPg,
          DATABASE_READ_URL: badPg,
          REDIS_URL: badRedis,
        }),
      [malformed('DATABASE_URL')],
    ),
  }).toStrictEqual({ admin: [], api: [], payout: [] });
});

it('[ADR-0001 §4.2 #11; 规划/02 §12.6] 合法写法都收：postgresql://、带端口与查询参数、没有口令、IPv6、首尾空白、大写协议、rediss:// 与库号；reveal() 是 WHATWG 序列化，redacted 去掉口令、查询串与片段', () => {
  const pw = encodeURIComponent(phraseOf('accepted'));
  const pgCases: readonly (readonly [string, string, string])[] = [
    [
      `postgresql://couli_app:${pw}@db.internal:5433/couli?sslmode=require`,
      `postgresql://couli_app:${pw}@db.internal:5433/couli?sslmode=require`,
      'postgresql://couli_app:***@db.internal:5433/couli',
    ],
    [
      'postgres://couli_app@127.0.0.1/couli',
      'postgres://couli_app@127.0.0.1/couli',
      'postgres://couli_app@127.0.0.1/couli',
    ],
    [
      `postgres://couli_app:${pw}@[::1]:5434/couli`,
      `postgres://couli_app:${pw}@[::1]:5434/couli`,
      'postgres://couli_app:***@[::1]:5434/couli',
    ],
    [
      `postgres://couli_readonly@10.0.0.5:5434/couli?password=${pw}&sslpassword=${pw}#${pw}`,
      `postgres://couli_readonly@10.0.0.5:5434/couli?password=${pw}&sslpassword=${pw}#${pw}`,
      'postgres://couli_readonly@10.0.0.5:5434/couli',
    ],
    [
      `  postgres://couli_app:${pw}@127.0.0.1:5433/couli  `,
      `postgres://couli_app:${pw}@127.0.0.1:5433/couli`,
      'postgres://couli_app:***@127.0.0.1:5433/couli',
    ],
    [
      `POSTGRES://couli_app:${pw}@127.0.0.1:5433/couli`,
      `postgres://couli_app:${pw}@127.0.0.1:5433/couli`,
      'postgres://couli_app:***@127.0.0.1:5433/couli',
    ],
  ];
  const redisCases: readonly (readonly [string, string, string])[] = [
    [
      `rediss://default:${pw}@cache.internal:6380`,
      `rediss://default:${pw}@cache.internal:6380`,
      'rediss://default:***@cache.internal:6380',
    ],
    ['redis://127.0.0.1:6379', 'redis://127.0.0.1:6379', 'redis://127.0.0.1:6379'],
    [
      `redis://:${pw}@127.0.0.1:6379/2?db=3`,
      `redis://:${pw}@127.0.0.1:6379/2?db=3`,
      'redis://:***@127.0.0.1:6379/2',
    ],
  ];
  const base = urlsOf('accepted.base').env;
  const seen = {
    db: pgCases.map(([value]) =>
      tryView(() => loadConnectionConfig('payout', { DATABASE_URL: value }).db.url),
    ),
    dbRead: pgCases.map(([value]) =>
      tryView(
        () =>
          loadConnectionConfig('admin', { ...base, DATABASE_READ_URL: value }).dbRead?.url ?? null,
      ),
    ),
    redis: redisCases.map(([value]) =>
      tryView(() => loadConnectionConfig('worker', { ...base, REDIS_URL: value }).redisUrl),
    ),
  };
  const want = (cases: readonly (readonly [string, string, string])[]): unknown[] =>
    cases.map(([, reveal, redacted]) => ({ isConnectionUrl: true, redacted, reveal }));
  expect(seen).toStrictEqual({ db: want(pgCases), dbRead: want(pgCases), redis: want(redisCases) });
});

function tryView(run: () => unknown): unknown {
  try {
    return urlView(run());
  } catch (error) {
    return describeError(error);
  }
}

for (const entry of ENTRIES) {
  it(`[ADR-0001 §4.2 #11, #20; 规划/02 §3.1] ${entry} 不读的变量（${ignoredBy(entry).join('、') || '无'}）与无关变量，取什么值（含坏值）都不改变结果`, () => {
    const { env } = urlsOf(`ignored.${entry}`);
    const plain = envFor(entry, env);
    const junk = 'not a url';
    const extra: Record<string, string> = {
      PATH: '/usr/bin',
      MIGRATOR_DATABASE_URL: junk,
      database_url: junk,
      redis_url: junk,
      REDIS_HOST: '127.0.0.1',
    };
    for (const name of ignoredBy(entry)) extra[name] = junk;
    const withGoodIgnored: Record<string, string> = { ...plain };
    for (const name of ignoredBy(entry)) withGoodIgnored[name] = env[name];
    // The expectation is written out by hand, never taken from the function under test.
    const expected = expectedConfig(entry, env);
    expect({
      plain: view(() => loadConnectionConfig(entry, plain)),
      junk: view(() => loadConnectionConfig(entry, { ...plain, ...extra })),
      good: view(() => loadConnectionConfig(entry, withGoodIgnored)),
    }).toStrictEqual({ plain: expected, junk: expected, good: expected });
  });
}

it('[规划/02 §12.6; apps/api AGENTS 硬规则 6] 只读传入的对象：不读 process.env，不改传入的对象（冻结的对象也能用）', () => {
  const { env } = urlsOf('pure');
  const other = urlsOf('pure.other').env;
  vi.stubEnv('DATABASE_URL', other.DATABASE_URL);
  vi.stubEnv('DATABASE_READ_URL', other.DATABASE_READ_URL);
  vi.stubEnv('REDIS_URL', other.REDIS_URL);
  const given = Object.freeze(envFor('admin', env));
  const before = JSON.stringify(given);
  let reveal: unknown;
  try {
    const config = loadConnectionConfig('admin', given);
    reveal = [config.db.url.reveal(), config.dbRead?.url.reveal(), config.redisUrl?.reveal()];
  } catch (error) {
    reveal = describeError(error);
  }
  expect({
    reveal,
    unchanged: JSON.stringify(given) === before,
    fromEmpty: thrown(() => loadConnectionConfig('payout', {})),
  }).toStrictEqual({
    reveal: [env.DATABASE_URL, env.DATABASE_READ_URL, env.REDIS_URL],
    unchanged: true,
    fromEmpty: `ConfigError ${JSON.stringify([missing('DATABASE_URL', 'payout')])}`,
  });
});
