// B1-01zzk 配置覆盖: the worker's per-queue concurrency overrides QUEUE_CONCURRENCY_<Q> (an integer
// from 1 to the queue's ENTRY_PLAN concurrency: only lower) and the shared budget QUEUE_DB_BUDGET
// (1..7) are read only through loadConfig, from the object it is given, into
// `queueLimits: { concurrency, dbBudget } | absent` (apps/api/src/modules/platform/config/queue-concurrency.ts).
// Invalid values refuse startup like every other variable: one ConfigError naming the variable,
// never echoing its value.
// Unit tests: no database, no port. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { POOL_SIZES } from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  BUDGET_ENV,
  DEFAULT_DB_BUDGET,
  ENV_NAME_OF,
  RESERVED_CONNECTIONS,
  TRUNK_WORKER_PLAN,
  concurrencyOf,
} from './kit.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** `queueLimits` of loadConfig's result, or 'absent' when the result has no such property. */
function limitsOf(env: Env): unknown {
  const config = loadConfig(env) as { queueLimits?: unknown };
  return Object.hasOwn(config, 'queueLimits') ? config.queueLimits : 'absent';
}

function problemsOf(env: Env): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
  expect.unreachable(`loadConfig accepted ${JSON.stringify(env)}`);
}

/** How many problems name `name` (the problem is the name, or starts with `<name>:`). */
function naming(problems: readonly string[], name: string): number {
  return problems.filter((problem) => problem === name || problem.startsWith(`${name}:`)).length;
}

it('[B1-01zzk 配置覆盖] 缺省取计划值：一个变量都没设（或都是空串）时 loadConfig 结果没有 queueLimits；设了合法值时 queueLimits 只列设了的队列，QUEUE_DB_BUDGET 未设时 dbBudget 为 null', () => {
  for (const env of [
    { APP_ENV: 'test' },
    { APP_ENV: 'test', QUEUE_DB_BUDGET: '' },
    { APP_ENV: 'local', QUEUE_CONCURRENCY_NOTIFY: '', QUEUE_CONCURRENCY_PAY: '' },
  ]) {
    expect(limitsOf(env), JSON.stringify(env)).toBe('absent');
  }
  expect(limitsOf({ APP_ENV: 'test', QUEUE_CONCURRENCY_NOTIFY: '2' })).toStrictEqual({
    concurrency: { notify: 2 },
    dbBudget: null,
  });
  expect(limitsOf({ APP_ENV: 'local', QUEUE_DB_BUDGET: '5' })).toStrictEqual({
    concurrency: {},
    dbBudget: 5,
  });
  expect(
    limitsOf({
      APP_ENV: 'test',
      QUEUE_CONCURRENCY_ORDER_SYNC: '1',
      QUEUE_CONCURRENCY_EVT_NOTIFICATION_RISK_STATE: '3',
      QUEUE_CONCURRENCY_POSTER: '',
      QUEUE_DB_BUDGET: '4',
    }),
  ).toStrictEqual({
    concurrency: { 'order-sync': 1, 'evt.notification-risk-state': 3 },
    dbBudget: 4,
  });
});

it('[B1-01zzk 配置覆盖] 每个 worker 队列各有自己的变量 QUEUE_CONCURRENCY_<队列名大写，- 与 . 换成 _>：1 与计划值本身都接受；17 个一起设成计划值时 concurrency 正好是整个 worker 计划', () => {
  expect(Object.keys(ENV_NAME_OF)).toStrictEqual(TRUNK_WORKER_PLAN.map((item) => item.queue));
  for (const item of TRUNK_WORKER_PLAN) {
    expect(ENV_NAME_OF[item.queue]).toBe(
      `QUEUE_CONCURRENCY_${item.queue.toUpperCase().replace(/[-.]/g, '_')}`,
    );
  }
  for (const item of TRUNK_WORKER_PLAN) {
    const name = ENV_NAME_OF[item.queue] ?? '';
    for (const value of new Set([1, item.concurrency])) {
      expect(
        limitsOf({ APP_ENV: 'test', [name]: String(value) }),
        `${name}=${String(value)}`,
      ).toStrictEqual({ concurrency: { [item.queue]: value }, dbBudget: null });
    }
  }
  const all: Record<string, string> = { APP_ENV: 'local' };
  for (const item of TRUNK_WORKER_PLAN) {
    all[ENV_NAME_OF[item.queue] ?? ''] = String(item.concurrency);
  }
  expect(limitsOf(all)).toStrictEqual({
    concurrency: concurrencyOf(TRUNK_WORKER_PLAN),
    dbBudget: null,
  });
});

it('[B1-01zzk 配置覆盖] 超过计划值或不是 1 起的十进制整数一律启动拒绝：ConfigError 点名该变量、不回显取值', () => {
  for (const item of TRUNK_WORKER_PLAN) {
    const name = ENV_NAME_OF[item.queue] ?? '';
    for (const value of [
      String(item.concurrency + 1),
      '11',
      '0',
      '-1',
      '1.5',
      '1.0',
      'abc',
      ' 1',
      '1 ',
      '+1',
      '1e0',
      '0x1',
      '987654',
    ]) {
      const problems = problemsOf({ APP_ENV: 'test', [name]: value });
      expect(
        naming(problems, name),
        `${name}=${JSON.stringify(value)}: ${JSON.stringify(problems)}`,
      ).toBe(1);
      expect(problems.join('\n')).not.toContain('987654');
    }
  }
});

it('[B1-01zzk 配置覆盖; 其他入口不受影响] 不对应任何 worker 队列的 QUEUE_CONCURRENCY_* 启动拒绝：payout（并发固定 1，只由 payout 入口执行）、死信队列、内部扫描队列、拼错的名字', () => {
  for (const name of [
    'QUEUE_CONCURRENCY_PAYOUT',
    'QUEUE_CONCURRENCY_NOTIFY_DEAD',
    'QUEUE_CONCURRENCY_ORDER_SYNC_DEAD',
    'QUEUE_CONCURRENCY_DEAD_LETTER_SCAN',
    'QUEUE_CONCURRENCY_ORDERSYNC',
    'QUEUE_CONCURRENCY_NOTIFICATION',
  ]) {
    const problems = problemsOf({ APP_ENV: 'test', [name]: '1' });
    expect(naming(problems, name), `${name}: ${JSON.stringify(problems)}`).toBe(1);
  }
});

it('[B1-01zzk 全局预算] QUEUE_DB_BUDGET 接受 1..7（7 = POOL_SIZES.worker.db 10 减去留给 supervision 与健康检查的 3 个连接，也是缺省值）；其余取值启动拒绝并点名该变量、不回显取值', () => {
  expect(POOL_SIZES.worker.db).toBe(10);
  expect(POOL_SIZES.worker.db - RESERVED_CONNECTIONS).toBe(DEFAULT_DB_BUDGET);
  for (let budget = 1; budget <= DEFAULT_DB_BUDGET; budget += 1) {
    expect(
      limitsOf({ APP_ENV: 'test', [BUDGET_ENV]: String(budget) }),
      String(budget),
    ).toStrictEqual({ concurrency: {}, dbBudget: budget });
  }
  for (const value of ['0', '8', '10', '7.5', '7.0', '-1', 'x', ' 7', '+7', '987654']) {
    const problems = problemsOf({ APP_ENV: 'test', [BUDGET_ENV]: value });
    expect(
      naming(problems, BUDGET_ENV),
      `${JSON.stringify(value)}: ${JSON.stringify(problems)}`,
    ).toBe(1);
    expect(problems.join('\n')).not.toContain('987654');
  }
});

it('[B1-01zzk 配置覆盖] 多个变量同时不合法时一个 ConfigError 逐个点名；APP_ENV 本身不合法时这些问题照常一并列出', () => {
  const problems = problemsOf({
    APP_ENV: 'test',
    QUEUE_CONCURRENCY_NOTIFY: '6',
    QUEUE_CONCURRENCY_NOPE: '1',
    QUEUE_CONCURRENCY_SETTLE: '1',
    QUEUE_DB_BUDGET: '0',
  });
  expect({
    notify: naming(problems, 'QUEUE_CONCURRENCY_NOTIFY'),
    nope: naming(problems, 'QUEUE_CONCURRENCY_NOPE'),
    settle: naming(problems, 'QUEUE_CONCURRENCY_SETTLE'),
    budget: naming(problems, 'QUEUE_DB_BUDGET'),
  }).toStrictEqual({ notify: 1, nope: 1, settle: 0, budget: 1 });
  const bogus = problemsOf({ APP_ENV: 'bogus', QUEUE_DB_BUDGET: '0', QUEUE_CONCURRENCY_PAY: '5' });
  expect(bogus.some((problem) => problem.startsWith('APP_ENV'))).toBe(true);
  expect(naming(bogus, 'QUEUE_DB_BUDGET')).toBe(1);
  expect(naming(bogus, 'QUEUE_CONCURRENCY_PAY')).toBe(1);
});
