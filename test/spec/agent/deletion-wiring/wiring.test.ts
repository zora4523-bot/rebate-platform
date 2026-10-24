// B3-09j（BR-AI-22，D10-175、D10-312）：AGENT_USER_HASH_KEY 经 platform/config 读进 AppConfig；组合根的
// agentDeletionCleanup 按配置装配注销清理端口 agent。有密钥 → agent 的 purgeAgentDataForUser；非 prod
// 缺密钥 → unavailable 标记并 warn 一次；prod 缺密钥由 loadConfig 拒绝启动。problem、错误消息与日志都不带
// 密钥值。清理 SQL 行为由 test/spec/agent/deletion 覆盖，导出引用由 test/spec/agent/deletion-export 覆盖。
// 不连库、不启动 Nest：app.module.ts 只按 test/spec/ledger/posting/wiring.test.ts 的写法动态导入。
// 第 3 次（评审 r1 两条 S1）：清理函数在无库的 Kysely 桩驱动上跑一次，参数里须有按配置密钥算的
// HMAC-SHA256(userId)；worker 入口的注销清理 provider 须注入 APP_CONFIG、ROOT_LOGGER 并按配置装配 agent 槽。
// D10-334（编排例外，计数不改）：provider 另以 optional 注入 platform 的 DB 令牌；缺密钥只在有库时 warn 一行，
// 无库（DB 解析为 undefined）时静默且 agent 槽仍是 unavailable 标记（identity [AC-B1-15f#29]）。
// agentDeletionCleanup 的第三个参数是数据库（undefined 视为无库）。
import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
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
  type Transaction,
} from 'kysely';
import { expect, it } from 'vitest';

import {
  ConfigError,
  loadConfig,
  readAgentUserHashConfig,
  type AppConfig,
  type AppEnv,
} from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB as DB_TOKEN,
  FixedClock,
  ROOT_LOGGER,
  createRootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import type {
  DeletionCleanupPort,
  DeletionCleanupPorts,
  DeletionCleanupStep,
} from '../../../../apps/api/src/modules/identity/ports/deletion-cleanup.ts';

const KEY_NAME = 'AGENT_USER_HASH_KEY';
/** Synthetic key; ASCII only so a serialized log argument shows it verbatim. */
const SECRET = 'test-only-agent-user-hash-key-first';
/** A second configured key: the hash must follow whichever key the configuration carries. */
const SECOND_SECRET = 'test-only-agent-user-hash-key-second';
/** The value of an unrelated variable passed alongside; never echoed either. */
const OTHER_NAME = 'B309J_UNRELATED_SETTING';
const OTHER_SECRET = 'test-only-unrelated-setting-value';
const ALL_ENVS: readonly AppEnv[] = ['local', 'test', 'staging', 'prod'];
const NON_PROD_ENVS: readonly AppEnv[] = ['local', 'test', 'staging'];

type Env = Readonly<Record<string, string | undefined>>;

/** Missing, explicitly undefined, empty and blank: all count as "no key". */
const MISSING_KEY_ENVS: readonly Env[] = [
  { [OTHER_NAME]: OTHER_SECRET },
  { [KEY_NAME]: undefined, [OTHER_NAME]: OTHER_SECRET },
  { [KEY_NAME]: '', [OTHER_NAME]: OTHER_SECRET },
  { [KEY_NAME]: '   ', [OTHER_NAME]: OTHER_SECRET },
  { [KEY_NAME]: ' \t\n ', [OTHER_NAME]: OTHER_SECRET },
];

/** Non-blank values are kept exactly as set. */
const PRESENT_KEYS: readonly string[] = [SECRET, '合成密钥-ü-1', `  ${SECRET}-padded  `];

/** A hand-built configuration (the function under test is pure over it). */
const BASE: AppConfig = {
  appEnv: 'test',
  logLevel: 'silent',
  clockNow: undefined,
  exitAfterInit: false,
  apiHost: '127.0.0.1',
  apiPort: 3100,
  streamPort: 3101,
  adminPort: 3102,
  keyring: null,
  jwt: null,
};

type AgentDeletionCleanup = (
  config: AppConfig,
  logger: RootLogger,
  database: unknown,
) => DeletionCleanupPort;

/** A database stand-in (never queried): "a database is configured". */
const STAND_IN_DATABASE: unknown = Object.freeze({ standIn: 'database' });

async function loadAgentDeletionCleanup(): Promise<AgentDeletionCleanup> {
  // Dynamic: a static import would pull identity's decorated application layer into the spec
  // project's erasable-only TypeScript compilation.
  const module = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { agentDeletionCleanup?: unknown };
  expect(typeof module.agentDeletionCleanup, 'exported').toBe('function');
  return module.agentDeletionCleanup as AgentDeletionCleanup;
}

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

interface LogCall {
  /** A pino level, or `child` for the bindings of a child logger. */
  readonly level: (typeof LEVELS)[number] | 'child';
  readonly args: readonly unknown[];
}

/** A logger stand-in recording every call; children record into the same list. */
function recordingLogger(): { readonly logger: RootLogger; readonly calls: LogCall[] } {
  const calls: LogCall[] = [];
  const target: Record<string, unknown> = {
    level: 'trace',
    isLevelEnabled: () => true,
    bindings: () => ({}),
  };
  for (const level of LEVELS) {
    target[level] = (...args: unknown[]) => {
      calls.push({ level, args });
    };
  }
  target['child'] = (...args: unknown[]) => {
    calls.push({ level: 'child', args });
    return target;
  };
  return { logger: target as unknown as RootLogger, calls };
}

function serialized(calls: readonly LogCall[]): string {
  return calls
    .map((call) =>
      inspect(call.args, {
        depth: null,
        breakLength: Infinity,
        maxArrayLength: null,
        maxStringLength: null,
        showHidden: true,
      }),
    )
    .join('\n');
}

function configError(run: () => unknown): ConfigError {
  let caught: unknown;
  let returned = false;
  try {
    run();
    returned = true;
  } catch (error) {
    caught = error;
  }
  expect(returned, 'loadConfig must refuse to start').toBe(false);
  expect(caught).toBeInstanceOf(ConfigError);
  return caught as ConfigError;
}

function keyProblems(problems: readonly string[]): readonly string[] {
  return problems.filter((problem) => problem.startsWith(KEY_NAME));
}

/** A valid (lower-case) uuid member id and the one session the stub driver reports for it. */
const PURGE_USER_ID = '7d3f0c2a-5b1e-4c9d-8a6f-2e4b1c0d9f3a';
const SESSION_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const PURGE_AT = new Date('2026-12-01T00:00:00.000Z');
/** Keys whose hash must not appear unless configured (OTHER_SECRET stands for any foreign key). */
const CANDIDATE_KEYS: readonly string[] = [SECRET, SECOND_SECRET, OTHER_SECRET];

interface RecordedQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

function hmacHex(key: string, userId: string): string {
  return createHmac('sha256', Buffer.from(key, 'utf8')).update(userId, 'utf8').digest('hex');
}

/**
 * Runs the step inside a real Kysely transaction over a no-database driver: every compiled query is
 * recorded, and each answers one row ({ id: SESSION_ID }, one affected row).
 */
async function runOnStubTransaction(
  step: DeletionCleanupStep,
  userId: string,
): Promise<readonly RecordedQuery[]> {
  const queries: RecordedQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      queries.push({ sql: compiled.sql, parameters: compiled.parameters });
      return { rows: [{ id: SESSION_ID }] as unknown as R[], numAffectedRows: 1n };
    },
    streamQuery(): AsyncIterableIterator<never> {
      throw new Error('stub driver: streaming is not used');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  try {
    await db.transaction().execute((trx) => step(trx, { appId: 'couli', userId, at: PURGE_AT }));
  } finally {
    await db.destroy();
  }
  return queries;
}

/**
 * BR-AI-22 细则「哈希」: the written user hash is HMAC-SHA256 under the configured key (the same
 * algorithm and key as agent_sessions.user_hash), never under any other key, and the key itself is
 * never a query parameter.
 */
async function expectHashedUnder(
  step: DeletionCleanupStep,
  key: string,
  label: string,
): Promise<void> {
  const queries = await runOnStubTransaction(step, PURGE_USER_ID);
  expect(queries.length, `${label}: statements issued`).toBeGreaterThan(0);
  const recorded = queries.map((query) => query.parameters);
  const parameters = inspect(recorded, {
    depth: null,
    breakLength: Infinity,
    maxArrayLength: null,
    maxStringLength: null,
  });
  expect(parameters, `${label}: hash under the configured key`).toContain(
    hmacHex(key, PURGE_USER_ID),
  );
  for (const other of CANDIDATE_KEYS.filter((candidate) => candidate !== key)) {
    expect(parameters, `${label}: no hash under another key`).not.toContain(
      hmacHex(other, PURGE_USER_ID),
    );
  }
  expect(parameters, `${label}: the key is never a parameter`).not.toContain(key);
}

interface ModuleShape {
  readonly module?: unknown;
  readonly imports?: readonly unknown[];
  readonly providers?: readonly unknown[];
}

interface FactoryShape {
  readonly provide: unknown;
  readonly inject?: readonly unknown[];
  readonly useFactory?: (...args: unknown[]) => unknown;
}

const WORKER_CLOCK = new FixedClock('2026-12-01T00:00:00.000Z');

function tokenOf(entry: unknown): unknown {
  return typeof entry === 'object' && entry !== null && 'token' in entry ? entry.token : entry;
}

/**
 * The worker entry's deletion cleanup provider (identity's IdentityDeletionExpiryModule, the
 * `cleanup` option app.module passes), found in the Nest module metadata; nothing is started.
 */
async function workerCleanupProvider(config: AppConfig): Promise<FactoryShape> {
  // Dynamic, as in test/spec/ledger/posting/wiring.test.ts and test/spec/commission/wiring/kit.ts.
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: object): ModuleShape } };
  const { IdentityDeletionExpiryModule } = (await import(
    new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
  )) as { IdentityDeletionExpiryModule: unknown };
  const root = AppModule.forEntry({
    entry: 'worker',
    config,
    clock: WORKER_CLOCK,
    logger: createRootLogger({ level: 'silent', entry: 'worker', appEnv: 'test' }, { write() {} }),
  });
  const found: ModuleShape[] = [];
  const seen = new Set<unknown>();
  function collect(candidate: unknown): void {
    if (candidate === null || typeof candidate !== 'object' || seen.has(candidate)) return;
    seen.add(candidate);
    const shape = candidate as ModuleShape;
    if (shape.module === IdentityDeletionExpiryModule) found.push(shape);
    for (const child of shape.imports ?? []) collect(child);
  }
  collect(root);
  expect(found, 'worker imports IdentityDeletionExpiryModule once').toHaveLength(1);
  const cleanup = (found[0]?.providers ?? []).filter(
    (provider): provider is FactoryShape =>
      typeof provider === 'object' &&
      provider !== null &&
      'provide' in provider &&
      typeof provider.provide === 'symbol' &&
      provider.provide.description === 'IDENTITY_DELETION_PROCESSING_CLEANUP',
  );
  expect(cleanup, 'one deletion cleanup provider').toHaveLength(1);
  const provider = cleanup[0];
  if (provider === undefined) throw new Error('no deletion cleanup provider');
  return provider;
}

function isOptional(entry: unknown): boolean {
  return (
    typeof entry === 'object' && entry !== null && 'optional' in entry && entry.optional === true
  );
}

/**
 * Resolves the provider's injections: APP_CONFIG, ROOT_LOGGER, CLOCK; the optional DB token as
 * `database` (the stand-in, or undefined for "no database"); other optional ones absent.
 */
async function cleanupPorts(
  provider: FactoryShape,
  config: AppConfig,
  logger: RootLogger,
  database: unknown,
): Promise<DeletionCleanupPorts> {
  const args = (provider.inject ?? []).map((entry) => {
    const token = tokenOf(entry);
    if (token === APP_CONFIG) return config;
    if (token === ROOT_LOGGER) return logger;
    if (token === CLOCK) return WORKER_CLOCK;
    expect(isOptional(entry), `unexpected required injection ${String(token)}`).toBe(true);
    if (token === DB_TOKEN) return database;
    return undefined;
  });
  expect(typeof provider.useFactory, 'cleanup provider is a factory').toBe('function');
  if (provider.useFactory === undefined) throw new Error('cleanup provider has no factory');
  return (await provider.useFactory(...args)) as DeletionCleanupPorts;
}

it('[AC-B3-09j#1][BR-AI-22] prod 缺失、空串或全空白：agentUserHashKey 为 null，恰有一条以 AGENT_USER_HASH_KEY 开头的 problem，且不带传入值', () => {
  for (const env of MISSING_KEY_ENVS) {
    const result = readAgentUserHashConfig('prod', env);
    expect(result.agentUserHashKey, inspect(env)).toBeNull();
    expect(result.problems, inspect(env)).toHaveLength(1);
    const problem = result.problems[0] ?? '';
    expect(problem.startsWith(KEY_NAME), problem).toBe(true);
    expect(problem).not.toContain(OTHER_SECRET);
    expect(problem).not.toContain(OTHER_NAME);
  }
});

it('[AC-B3-09j#2] local / test / staging 缺失、空串或全空白：agentUserHashKey 为 null，problems 为空（非 prod 不拒绝启动）', () => {
  for (const appEnv of NON_PROD_ENVS) {
    for (const env of MISSING_KEY_ENVS) {
      const result = readAgentUserHashConfig(appEnv, env);
      expect(result.agentUserHashKey, `${appEnv} ${inspect(env)}`).toBeNull();
      expect(result.problems, `${appEnv} ${inspect(env)}`).toEqual([]);
    }
  }
});

it('[AC-B3-09j#3] 任一 APP_ENV 下值非空白：agentUserHashKey 等于原值，problems 为空', () => {
  for (const appEnv of ALL_ENVS) {
    for (const value of PRESENT_KEYS) {
      const result = readAgentUserHashConfig(appEnv, { [KEY_NAME]: value, [OTHER_NAME]: 'x' });
      expect(result.agentUserHashKey, `${appEnv} ${inspect(value)}`).toBe(value);
      expect(result.problems, `${appEnv} ${inspect(value)}`).toEqual([]);
    }
  }
});

it('[AC-B3-09j#4] loadConfig 填入 agentUserHashKey；test 缺省为 null 不抛；prod 缺省抛 ConfigError 且不带值', () => {
  // Present first: an unchanged loadConfig (no such field) fails here.
  expect(loadConfig({ APP_ENV: 'test', [KEY_NAME]: SECRET }).agentUserHashKey).toBe(SECRET);
  expect(loadConfig({ APP_ENV: 'test' }).agentUserHashKey).toBeNull();
  expect(loadConfig({ APP_ENV: 'test', [KEY_NAME]: '  ' }).agentUserHashKey).toBeNull();

  // prod without the key: one problem names it (other prod requirements may be listed too).
  for (const env of MISSING_KEY_ENVS) {
    const missing = configError(() => loadConfig({ ...env, APP_ENV: 'prod' }));
    expect(keyProblems(missing.problems), inspect(env)).toHaveLength(1);
    expect(missing.message).toContain(KEY_NAME);
    expect(missing.message).not.toContain(OTHER_SECRET);
    for (const problem of missing.problems) expect(problem).not.toContain(OTHER_SECRET);
  }

  // prod with the key but other requirements missing: the key raises no problem and its value
  // appears in neither the message nor any problem.
  const given = configError(() => loadConfig({ APP_ENV: 'prod', [KEY_NAME]: SECRET }));
  expect(keyProblems(given.problems)).toEqual([]);
  expect(given.message).not.toContain(SECRET);
  for (const problem of given.problems) expect(problem).not.toContain(SECRET);
});

it('[AC-B3-09j#5][BR-AI-22] 带密钥：agentDeletionCleanup 返回可装进 DeletionCleanupStep 的清理函数，不记 warn', async () => {
  const agentDeletionCleanup = await loadAgentDeletionCleanup();
  for (const appEnv of ALL_ENVS) {
    const { logger, calls } = recordingLogger();
    const port = agentDeletionCleanup(
      { ...BASE, appEnv, agentUserHashKey: SECRET },
      logger,
      STAND_IN_DATABASE,
    );
    expect(typeof port, appEnv).toBe('function');
    if (typeof port !== 'function') throw new Error(`${appEnv}: expected a cleanup step`);
    // Type level: fails `pnpm typecheck` if the narrowed port is not identity's step.
    const step = port satisfies DeletionCleanupStep;
    // agent's purge validates its input before any statement: a bad user id is refused without
    // touching the transaction (no database here).
    const input = { appId: 'couli', userId: 'not-a-uuid', at: new Date(0) };
    const refused: unknown = await step({} as Transaction<DB>, input).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused, appEnv).toBeInstanceOf(TypeError);
    expect((refused as Error).message).not.toMatch(/NotImplemented/);
    // A valid member on a no-database transaction: the hash written is under the configured key.
    await expectHashedUnder(step, SECRET, appEnv);
    expect(calls.filter((call) => call.level === 'warn')).toEqual([]);
  }
  // Another configured key yields that key's hash (no fixed or borrowed key).
  const { logger, calls } = recordingLogger();
  const port = agentDeletionCleanup(
    { ...BASE, appEnv: 'prod', agentUserHashKey: SECOND_SECRET },
    logger,
    STAND_IN_DATABASE,
  );
  expect(typeof port, 'second key').toBe('function');
  if (typeof port !== 'function') throw new Error('second key: expected a cleanup step');
  await expectHashedUnder(port, SECOND_SECRET, 'second key');
  expect(calls.filter((call) => call.level === 'warn')).toEqual([]);
});

it('[AC-B3-09j#6] 不带密钥（null / 缺省）：返回 { unavailable: 非空字符串 }，warn 恰 1 次且不含密钥值', async () => {
  const agentDeletionCleanup = await loadAgentDeletionCleanup();
  const keyless: readonly AppConfig[] = [
    BASE,
    { ...BASE, agentUserHashKey: null },
    { ...BASE, appEnv: 'local' },
    { ...BASE, appEnv: 'staging', agentUserHashKey: null },
  ];
  for (const config of keyless) {
    const label = `${config.appEnv} ${String(config.agentUserHashKey)}`;
    const { logger, calls } = recordingLogger();
    const port = agentDeletionCleanup(config, logger, STAND_IN_DATABASE);
    expect(typeof port, label).toBe('object');
    const marker = port as { readonly unavailable?: unknown };
    expect(typeof marker.unavailable, label).toBe('string');
    expect(String(marker.unavailable).trim(), label).not.toBe('');
    expect(
      calls.filter((call) => call.level === 'warn'),
      label,
    ).toHaveLength(1);
    expect(serialized(calls), label).not.toContain(SECRET);
  }
  // Reverse check: the keyed configuration's value never shows up in the keyless warn either.
  const { logger, calls } = recordingLogger();
  agentDeletionCleanup(
    { ...BASE, agentUserHashKey: SECRET },
    recordingLogger().logger,
    STAND_IN_DATABASE,
  );
  agentDeletionCleanup(BASE, logger, STAND_IN_DATABASE);
  expect(calls.filter((call) => call.level === 'warn')).toHaveLength(1);
  expect(serialized(calls)).not.toContain(SECRET);
});

it('[AC-B3-09j#7][BR-AI-22] 带密钥：日志替身任何级别（含 child 绑定）的调用参数都不含密钥值', async () => {
  const agentDeletionCleanup = await loadAgentDeletionCleanup();
  for (const appEnv of ALL_ENVS) {
    const { logger, calls } = recordingLogger();
    const port = agentDeletionCleanup(
      { ...BASE, appEnv, agentUserHashKey: SECRET },
      logger,
      STAND_IN_DATABASE,
    );
    expect(typeof port, appEnv).toBe('function');
    expect(serialized(calls), appEnv).not.toContain(SECRET);
  }
});

/** D10-334: the provider injects platform's DB token, and optionally (a worker may run without one). */
function expectOptionalDatabase(provider: FactoryShape, label: string): void {
  const entries = (provider.inject ?? []).filter((entry) => tokenOf(entry) === DB_TOKEN);
  expect(entries, `${label}: injects DB once`).toHaveLength(1);
  expect(isOptional(entries[0]), `${label}: DB is optional`).toBe(true);
}

const WORKER_KEYS = [
  ['first key', SECRET],
  ['second key', SECOND_SECRET],
] as const;

it('[AC-B3-09j#5][AC-B3-09j#6][BR-AI-22] worker 入口：注销清理 provider 注入 APP_CONFIG、ROOT_LOGGER 与 optional DB，按配置装配 agent 槽（有密钥 → 按该密钥哈希的清理函数；无密钥 → unavailable 标记并 warn 一次）', async () => {
  const base = loadConfig({ APP_ENV: 'test' });

  // With the key: identity's cleanup round reaches agent's purge under that very key.
  for (const [label, key] of WORKER_KEYS) {
    const config: AppConfig = { ...base, agentUserHashKey: key };
    const provider = await workerCleanupProvider(config);
    const tokens = (provider.inject ?? []).map(tokenOf);
    expect(tokens, `${label}: injects APP_CONFIG`).toContain(APP_CONFIG);
    expect(tokens, `${label}: injects ROOT_LOGGER`).toContain(ROOT_LOGGER);
    const { logger, calls } = recordingLogger();
    const ports = await cleanupPorts(provider, config, logger, STAND_IN_DATABASE);
    expect(typeof ports.agent, `${label}: agent slot`).toBe('function');
    if (typeof ports.agent !== 'function') throw new Error(`${label}: expected a cleanup step`);
    await expectHashedUnder(ports.agent, key, `worker ${label}`);
    expect(calls.filter((call) => call.level === 'warn')).toEqual([]);
    expect(serialized(calls), label).not.toContain(key);
  }

  // Without the key (non-prod; prod never starts): the unavailable marker, one warn, no key value.
  for (const appEnv of ['test', 'staging'] as const) {
    const config: AppConfig = { ...base, appEnv, agentUserHashKey: null };
    const provider = await workerCleanupProvider(config);
    const tokens = (provider.inject ?? []).map(tokenOf);
    expect(tokens, `${appEnv}: injects APP_CONFIG`).toContain(APP_CONFIG);
    expect(tokens, `${appEnv}: injects ROOT_LOGGER`).toContain(ROOT_LOGGER);
    expectOptionalDatabase(provider, appEnv);
    const { logger, calls } = recordingLogger();
    const ports = await cleanupPorts(provider, config, logger, STAND_IN_DATABASE);
    expect(typeof ports.agent, `${appEnv}: agent slot`).toBe('object');
    const marker = ports.agent as { readonly unavailable?: unknown };
    expect(typeof marker.unavailable, appEnv).toBe('string');
    expect(String(marker.unavailable).trim(), appEnv).not.toBe('');
    expect(
      calls.filter((call) => call.level === 'warn'),
      appEnv,
    ).toHaveLength(1);
    for (const [, key] of WORKER_KEYS) expect(serialized(calls), appEnv).not.toContain(key);
  }
});

it('[AC-B3-09j#6] worker 入口无数据库：注销清理 provider 的 DB 解析为 undefined 且无密钥时，agent 槽仍是 { unavailable: 非空字符串 }，warn 及以上的调用为 0 条', async () => {
  const base = loadConfig({ APP_ENV: 'test' });
  for (const appEnv of ['test', 'staging'] as const) {
    const config: AppConfig = { ...base, appEnv, agentUserHashKey: null };
    const provider = await workerCleanupProvider(config);
    expectOptionalDatabase(provider, appEnv);
    const { logger, calls } = recordingLogger();
    const ports = await cleanupPorts(provider, config, logger, undefined);
    expect(typeof ports.agent, `${appEnv}: agent slot`).toBe('object');
    const marker = ports.agent as { readonly unavailable?: unknown };
    expect(typeof marker.unavailable, appEnv).toBe('string');
    expect(String(marker.unavailable).trim(), appEnv).not.toBe('');
    expect(
      calls.filter(
        (call) => call.level === 'warn' || call.level === 'error' || call.level === 'fatal',
      ),
      appEnv,
    ).toEqual([]);
  }
});
