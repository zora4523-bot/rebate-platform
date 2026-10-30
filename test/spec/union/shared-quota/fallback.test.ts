// B1-22v, 编排裁定 D10-460: the union quota of an entry that has no REDIS handle
// (platform/http/union-quota.ts). local / test: an in-process bucket with the shared bucket's
// numbers and one warn line; staging / prod: every token refused and one warn line, and such an
// entry does not start without REDIS_URL in the first place. A Redis failure (a handle whose
// commands fail) is not this path: it stays refused (R-04, unavailable.test.ts).
import { expect, it, vi } from 'vitest';
import {
  ConfigError,
  GovernanceError,
  createGovernor,
  createUnionQuotaFallback,
  loadConnectionConfig,
  unionPolicy,
  type AppEnv,
  type QuotaPurpose,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createGovernedAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { ManualScheduler, Upstream, runCalls, tally } from '../../platform/http/kit.ts';
import { memoryLogger } from '../../platform/redis/kit.ts';
import { adapter, endpoint, online } from '../skeleton/kit.ts';
import { WARN, config, drain, flat, parsed, type LogLine } from './kit.ts';

/** Message of the one warn line of a fallback (union-quota.ts contract). */
const ABSENT = 'union_quota_redis_absent';
const PURPOSES: readonly QuotaPurpose[] = ['online', 'order_sync', 'pool_refresh', 'watch'];
const REDIS_ENTRIES = ['api', 'stream', 'admin', 'worker'] as const;

function absentWarnings(lines: readonly string[]): LogLine[] {
  return parsed(lines).filter((line) => line.msg === ABSENT);
}

function warningShape(line: LogLine | undefined) {
  return line === undefined
    ? undefined
    : { level: line.level, app_env: line['app_env'], mode: line['mode'], flat: flat(line) };
}

function outcome(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof GovernanceError) return error.code;
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  return 'returned';
}

it.each(['local', 'test'] as const)(
  '[D10-460] APP_ENV=%s 且无 REDIS：进程内桶，容量 / 速率 / 份额同共享桶（商品池刷新 10、在线 60 用尽后拒、订单同步 30、提醒 0，按速率回填）；只记一条 warn',
  async (appEnv) => {
    const scheduler = new ManualScheduler();
    const { logger, lines } = memoryLogger();
    const fallback = createUnionQuotaFallback({ appEnv, logger, scheduler });
    const taobao = fallback.limiter(config());
    const jd = fallback.limiter(config({ bucketKey: 'union:jd:synthetic-app' }));
    const full = {
      pool_refresh: await drain(taobao, 'pool_refresh'),
      online: await drain(taobao, 'online'),
      order_sync: await drain(taobao, 'order_sync'),
      watch: await drain(taobao, 'watch'),
    };
    const exhausted = {
      online: await taobao.tryAcquire('online'),
      order_sync: await taobao.tryAcquire('order_sync'),
    };
    // A bucket of another key is untouched by the first one.
    const otherKey = await drain(jd, 'order_sync');
    await scheduler.advance(1000);
    const afterOneSecond = {
      order_sync: await drain(taobao, 'order_sync'),
      // 6 of its own plus 1 borrowed from pool_refresh.
      online: await drain(taobao, 'online'),
    };
    const warnings = absentWarnings(lines);
    const text = lines.join('\n');
    expect({
      mode: fallback.mode,
      bucketKeys: [taobao.bucketKey, jd.bucketKey],
      full,
      exhausted,
      otherKey,
      afterOneSecond,
      warnings: warnings.length,
      warning: warningShape(warnings[0]),
      linesLogged: lines.length,
      leaks: ['redis://', 'REDIS_URL', 'password'].some((part) => text.includes(part)),
    }).toEqual({
      mode: 'memory',
      bucketKeys: ['union:taobao:synthetic-app', 'union:jd:synthetic-app'],
      full: { pool_refresh: 10, online: 60, order_sync: 30, watch: 0 },
      exhausted: { online: false, order_sync: false },
      otherKey: 30,
      afterOneSecond: { order_sync: 3, online: 7 },
      warnings: 1,
      warning: { level: WARN, app_env: appEnv, mode: 'memory', flat: true },
      linesLogged: 1,
      leaks: false,
    });
  },
);

it.each(['local', 'test', 'staging', 'prod'] as const)(
  '[D10-460] APP_ENV=%s 且无 REDIS：配置不合法与内存版一样同步抛 invalid_policy',
  (appEnv: AppEnv) => {
    const fallback = createUnionQuotaFallback({
      appEnv,
      logger: memoryLogger().logger,
      scheduler: new ManualScheduler(),
    });
    expect({
      capacityZero: outcome(() => fallback.limiter(config({ capacity: 0 }))),
      refillZero: outcome(() => fallback.limiter(config({ refillPerSecond: 0 }))),
      sharesSum: outcome(() =>
        fallback.limiter(
          config({ shares: { online: 60, order_sync: 30, pool_refresh: 10, watch: 1 } }),
        ),
      ),
      keyEmpty: outcome(() => fallback.limiter(config({ bucketKey: '' }))),
      good: outcome(() => fallback.limiter(config())),
    }).toEqual({
      capacityZero: 'invalid_policy',
      refillZero: 'invalid_policy',
      sharesSum: 'invalid_policy',
      keyEmpty: 'invalid_policy',
      good: 'returned',
    });
  },
);

it.each(['staging', 'prod'] as const)(
  '[D10-460][R-04] APP_ENV=%s：缺 REDIS_URL 起不来；无 REDIS 时一律拒绝（每种用途、任何时刻），治理层 quota_exceeded 且不调用对方；只记一条 warn',
  async (appEnv) => {
    // Startup: api / stream / admin / worker refuse to start without REDIS_URL (unset or empty).
    const startup = Object.fromEntries(
      REDIS_ENTRIES.flatMap((entry) =>
        [undefined, ''].map((redisUrl) => {
          const env = {
            APP_ENV: appEnv,
            DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/rules',
            DATABASE_READ_URL: 'postgres://couli_readonly@127.0.0.1:1/rules',
            ...(redisUrl === undefined ? {} : { REDIS_URL: redisUrl }),
          };
          let problems: readonly string[] | string = 'started';
          try {
            loadConnectionConfig(entry, env);
          } catch (error) {
            problems = error instanceof ConfigError ? error.problems : 'other error';
          }
          return [`${entry}:${redisUrl === undefined ? 'unset' : 'empty'}`, problems] as const;
        }),
      ),
    );
    expect(startup).toEqual(
      Object.fromEntries(
        REDIS_ENTRIES.flatMap((entry) =>
          ['unset', 'empty'].map(
            (how) =>
              [`${entry}:${how}`, [`REDIS_URL: must be set for the ${entry} entry`]] as const,
          ),
        ),
      ),
    );

    // An entry assembled without REDIS anyway: nothing is granted.
    const scheduler = new ManualScheduler();
    const { logger, lines } = memoryLogger();
    const fallback = createUnionQuotaFallback({ appEnv, logger, scheduler });
    const limiter = fallback.limiter(config());
    const granted: Record<string, number> = {};
    for (const purpose of PURPOSES) granted[purpose] = await drain(limiter, purpose, 100);
    await scheduler.advance(3_600_000);
    const afterAnHour = await drain(limiter, 'order_sync', 100);

    // Through the governor and the union governance layer.
    const upstream = new Upstream(scheduler);
    const governor = createGovernor('union.taobao', unionPolicy('online'), {
      scheduler,
      quota: fallback.limiter(config({ bucketKey: 'union:taobao:synthetic-governor' })),
    });
    const endings = await runCalls(governor, 25, upstream.ok('never reached'), {
      kind: 'idempotent_read',
      purpose: 'online',
    });
    const raw = adapter('jd');
    const resolveLink = vi.spyOn(raw, 'resolveLink');
    const governed = createGovernedAdapter(raw, {
      endpoint: endpoint('jd'),
      scheduler,
      quota: fallback.limiter(config({ bucketKey: 'union:jd:synthetic-app' })),
    });
    const link = 'https://item.jd.com/100012345678.html';
    const governedError = await governed.resolveLink(link, online).then(
      () => null,
      (reason: unknown) => reason,
    );

    const warnings = absentWarnings(lines);
    const text = lines.join('\n');
    expect({
      mode: fallback.mode,
      bucketKey: limiter.bucketKey,
      granted,
      afterAnHour,
      endings: tally(endings),
      invoked: upstream.calledAt.length,
      breaker: governor.breakerState(),
      governed: governedError instanceof GovernanceError ? governedError.code : governedError,
      resolveLinkCalls: resolveLink.mock.calls.length,
      warnings: warnings.length,
      warning: warningShape(warnings[0]),
      linesLogged: lines.length,
      leaks: ['redis://', 'REDIS_URL', 'password'].some((part) => text.includes(part)),
    }).toEqual({
      mode: 'refuse',
      bucketKey: 'union:taobao:synthetic-app',
      granted: { online: 0, order_sync: 0, pool_refresh: 0, watch: 0 },
      afterAnHour: 0,
      endings: { quota_exceeded: 25 },
      invoked: 0,
      breaker: 'closed',
      governed: 'quota_exceeded',
      resolveLinkCalls: 0,
      warnings: 1,
      warning: { level: WARN, app_env: appEnv, mode: 'refuse', flat: true },
      linesLogged: 1,
      leaks: false,
    });
  },
);
