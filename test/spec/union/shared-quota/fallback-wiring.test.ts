// B1-22v wiring, 编排裁定 D10-460: an entry assembled WITHOUT a REDIS handle under APP_ENV=test
// (api: GovernedUnion; stream: the Agent's business ports; worker: the order-sync quota port)
// takes every union limiter from one createUnionQuotaFallback (called through
// platform/index.ts; the test spies on that export) — in-process buckets with today's numbers
// (capacity 100, 10/s, MVP shares, one per platform endpoint), never the shared Redis bucket —
// and logs exactly one `union_quota_redis_absent` warn line. The same entry WITH a REDIS handle
// never builds the fallback (wiring.test.ts covers its shared buckets). The real AppModule is
// assembled with Nest; only the job queue, the database (compile-only, no connection) and, in the
// second assembly, the Redis handle (a double whose every script fails) are substituted.
// Nothing listens or connects.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import * as redisModule from '../../../../apps/api/src/modules/platform/redis/index.ts';
import type {
  QuotaConfig,
  QuotaLimiter,
  UnionQuotaFallbackDeps,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type { RedisHandle } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import {
  UNION_ENDPOINTS,
  type UnionEndpoint,
} from '../../../../apps/api/src/modules/union/index.ts';
import { connection, memoryLogger } from '../../platform/redis/kit.ts';
import {
  MVP_SHARES,
  T0,
  UNION_CAPACITY,
  UNION_REFILL_PER_SECOND,
  WARN,
  drain,
  flat,
  parsed,
} from './kit.ts';

type Entry = 'api' | 'stream' | 'worker';
const ENTRIES: readonly Entry[] = ['api', 'stream', 'worker'];
const NEST_TIMEOUT_MS = 60_000;
/** Message of the one warn line of a fallback (union-quota.ts contract). */
const ABSENT = 'union_quota_redis_absent';

interface Context {
  get(token: unknown, options?: { strict: boolean }): unknown;
  close(): Promise<void>;
}

const databases: Kysely<DB>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

/** A database handle that compiles statements and never connects (DummyDriver). */
function compileOnlyDb(): Kysely<DB> {
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  databases.push(db);
  return db;
}

/** A REDIS double: every namespace answers each script with RedisUnavailableError. */
function fakeRedis(): RedisHandle {
  const close = vi.fn(async () => undefined);
  return {
    namespace: () => ({
      get: async () => null,
      set: async () => undefined,
      eval: () =>
        Promise.reject(new redisModule.RedisUnavailableError('connect_failed', 'ECONNREFUSED')),
    }),
    close,
    onApplicationShutdown: close,
  };
}

interface Built {
  readonly endpoints: readonly UnionEndpoint[];
  readonly fallbackDeps: readonly UnionQuotaFallbackDeps[];
  readonly limiters: readonly { readonly config: QuotaConfig; readonly limiter: QuotaLimiter }[];
  readonly sharedCalls: number;
  readonly memoryCalls: number;
  readonly lines: readonly string[];
  readonly context: Context;
}

async function boot(entry: Entry, withRedis: boolean): Promise<Built> {
  // URL imports keep the decorated Nest sources out of the spec project's TS compilation.
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: object): unknown } };
  const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: { createApplicationContext(module: unknown, options: object): Promise<Context> };
  };
  if (withRedis) vi.spyOn(redisModule, 'createRedisHandle').mockResolvedValue(fakeRedis());
  const platformModule = platform.PlatformModule as unknown as {
    forRoot(options: object): { providers?: unknown[] };
  };
  const original = platformModule.forRoot.bind(platformModule);
  const queue = {
    send: vi.fn(async () => 'synthetic-job'),
    register: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  vi.spyOn(platformModule, 'forRoot').mockImplementation((options) => {
    const module = original(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === platform.JOB_QUEUE
          ? { provide: platform.JOB_QUEUE, useValue: queue }
          : provider,
      ),
    };
  });
  const shared = vi.spyOn(platform, 'createRedisQuotaLimiter');
  const memory = vi.spyOn(platform, 'createMemoryQuotaLimiter');
  // Record every fallback and every limiter it hands out, keeping the real behaviour.
  const realFallback = platform.createUnionQuotaFallback;
  const fallbackDeps: UnionQuotaFallbackDeps[] = [];
  const limiters: { config: QuotaConfig; limiter: QuotaLimiter }[] = [];
  vi.spyOn(platform, 'createUnionQuotaFallback').mockImplementation((deps) => {
    fallbackDeps.push(deps);
    const fallback = realFallback(deps);
    return {
      mode: fallback.mode,
      limiter(config) {
        const limiter = fallback.limiter(config);
        limiters.push({ config, limiter });
        return limiter;
      },
    };
  });
  const { logger, lines } = memoryLogger(entry);
  const context = await NestFactory.createApplicationContext(
    AppModule.forEntry({
      entry,
      config: platform.loadConfig({ APP_ENV: 'test' }),
      clock: new platform.FixedClock(T0),
      logger,
      ...(withRedis ? { redisUrl: connection(entry).redisUrl } : {}),
      // api builds GovernedUnion without a database; stream and worker build theirs only with one.
      ...(entry === 'api'
        ? {}
        : { dbHandles: { db: compileOnlyDb(), dbRead: null, close: async () => undefined } }),
    }),
    { logger: false, abortOnError: false },
  );
  const endpoints = context.get(UNION_ENDPOINTS, { strict: false }) as readonly UnionEndpoint[];
  return {
    endpoints,
    fallbackDeps,
    limiters,
    sharedCalls: shared.mock.calls.length,
    memoryCalls: memory.mock.calls.length,
    lines,
    context,
  };
}

/** What the entry assembled without REDIS built, each bucket drained once right after assembly. */
async function withoutRedis(entry: Entry) {
  const built = await boot(entry, false);
  try {
    const quotaKeys = [...new Set(built.endpoints.map((endpoint) => endpoint.quotaKey))].sort();
    // One drain per bucket key (the first limiter of that key).
    const drained: Record<string, Record<string, number | boolean>> = {};
    for (const { config, limiter } of built.limiters) {
      if (config.bucketKey in drained) continue;
      drained[config.bucketKey] = {
        pool_refresh: await drain(limiter, 'pool_refresh'),
        online: await drain(limiter, 'online'),
        order_sync: await drain(limiter, 'order_sync'),
        watch: await drain(limiter, 'watch'),
        onlineAfter: await limiter.tryAcquire('online'),
      };
    }
    const warnings = parsed(built.lines).filter((line) => line.msg === ABSENT);
    return {
      quotaKeys,
      fallbacks: built.fallbackDeps.map((deps) => deps.appEnv),
      sharedCalls: built.sharedCalls,
      memoryCalls: built.memoryCalls,
      buckets: [...new Set(built.limiters.map(({ config }) => config.bucketKey))].sort(),
      configs: built.limiters.map(({ config }) => ({
        capacity: config.capacity,
        refillPerSecond: config.refillPerSecond,
        shares: { ...config.shares },
      })),
      drained,
      warnings: warnings.map((line) => ({
        level: line.level,
        app_env: line['app_env'],
        mode: line['mode'],
        flat: flat(line),
      })),
      leaks: built.lines.join('\n').includes('redis://'),
    };
  } finally {
    await built.context.close();
  }
}

it.each(ENTRIES)(
  '[D10-460] APP_ENV=test 的 %s 入口无 REDIS：联盟配额全取自一个进程内回落（每个平台一桶，容量 100、10/s、MVP 份额，按容量放行、用尽后拒），不建共享桶，只记一条 warn；有 REDIS 时不建回落',
  async (entry) => {
    const without = await withoutRedis(entry);
    expect(without.quotaKeys.length).toBeGreaterThan(0);
    expect(without).toEqual({
      quotaKeys: without.quotaKeys,
      fallbacks: ['test'],
      sharedCalls: 0,
      memoryCalls: 0,
      buckets: without.quotaKeys,
      configs: without.configs.map(() => ({
        capacity: UNION_CAPACITY,
        refillPerSecond: UNION_REFILL_PER_SECOND,
        shares: MVP_SHARES,
      })),
      drained: Object.fromEntries(
        without.quotaKeys.map(
          (key) =>
            [
              key,
              { pool_refresh: 10, online: 60, order_sync: 30, watch: 0, onlineAfter: false },
            ] as const,
        ),
      ),
      warnings: [{ level: WARN, app_env: 'test', mode: 'memory', flat: true }],
      leaks: false,
    });

    vi.restoreAllMocks();
    const withRedis = await boot(entry, true);
    try {
      expect({
        fallbacks: withRedis.fallbackDeps.length,
        absentWarnings: parsed(withRedis.lines).filter((line) => line.msg === ABSENT).length,
        sharedBuilt: withRedis.sharedCalls > 0,
      }).toEqual({ fallbacks: 0, absentWarnings: 0, sharedBuilt: true });
    } finally {
      await withRedis.context.close();
    }
  },
  NEST_TIMEOUT_MS * 2,
);
