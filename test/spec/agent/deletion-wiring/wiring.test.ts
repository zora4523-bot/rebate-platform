// B3-09j（BR-AI-22，D10-175、D10-312）：AGENT_USER_HASH_KEY 经 platform/config 读进 AppConfig；组合根的
// agentDeletionCleanup 按配置装配注销清理端口 agent。有密钥 → agent 的 purgeAgentDataForUser；非 prod
// 缺密钥 → unavailable 标记并 warn 一次；prod 缺密钥由 loadConfig 拒绝启动。problem、错误消息与日志都不带
// 密钥值。清理 SQL 行为由 test/spec/agent/deletion 覆盖，导出引用由 test/spec/agent/deletion-export 覆盖。
// 不连库、不启动 Nest：app.module.ts 只按 test/spec/ledger/posting/wiring.test.ts 的写法动态导入。
import { inspect } from 'node:util';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';

import {
  ConfigError,
  loadConfig,
  readAgentUserHashConfig,
  type AppConfig,
  type AppEnv,
} from '../../../../apps/api/src/modules/platform/config/index.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import type {
  DeletionCleanupPort,
  DeletionCleanupStep,
} from '../../../../apps/api/src/modules/identity/ports/deletion-cleanup.ts';

const KEY_NAME = 'AGENT_USER_HASH_KEY';
/** Synthetic key; ASCII only so a serialized log argument shows it verbatim. */
const SECRET = 'test-only-agent-user-hash-key-first';
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

type AgentDeletionCleanup = (config: AppConfig, logger: RootLogger) => DeletionCleanupPort;

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
    const port = agentDeletionCleanup({ ...BASE, appEnv, agentUserHashKey: SECRET }, logger);
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
    expect(calls.filter((call) => call.level === 'warn')).toEqual([]);
  }
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
    const port = agentDeletionCleanup(config, logger);
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
  agentDeletionCleanup({ ...BASE, agentUserHashKey: SECRET }, recordingLogger().logger);
  agentDeletionCleanup(BASE, logger);
  expect(calls.filter((call) => call.level === 'warn')).toHaveLength(1);
  expect(serialized(calls)).not.toContain(SECRET);
});

it('[AC-B3-09j#7][BR-AI-22] 带密钥：日志替身任何级别（含 child 绑定）的调用参数都不含密钥值', async () => {
  const agentDeletionCleanup = await loadAgentDeletionCleanup();
  for (const appEnv of ALL_ENVS) {
    const { logger, calls } = recordingLogger();
    const port = agentDeletionCleanup({ ...BASE, appEnv, agentUserHashKey: SECRET }, logger);
    expect(typeof port, appEnv).toBe('function');
    expect(serialized(calls), appEnv).not.toContain(SECRET);
  }
});
