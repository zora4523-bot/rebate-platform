// B1-22v wiring (编排裁定 D10-446 ①): every entry that builds governed union adapters (api:
// GovernedUnion; stream: the Agent's business ports; worker: the order-sync quota port) takes its
// union quota from the shared Redis bucket — createRedisQuotaLimiter called through
// platform/index.ts, one bucket per platform endpoint with today's numbers (capacity 100, 10/s,
// MVP shares), one namespace of the entry's REDIS handle shared by every entry, the entry's CLOCK
// — and never from an in-process memory bucket. The real AppModule is assembled with Nest; only the
// Redis handle (a double whose every script fails, so a token is refused), the job queue and the
// database (compile-only, no connection) are substituted. Nothing listens or connects.
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
import { afterEach, expect, it, vi, type Mock } from 'vitest';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import * as redisModule from '../../../../apps/api/src/modules/platform/redis/index.ts';
import type {
  RedisHandle,
  RedisNamespace,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import {
  UNION_ENDPOINTS,
  type UnionEndpoint,
} from '../../../../apps/api/src/modules/union/index.ts';
import { connection, memoryLogger } from '../../platform/redis/kit.ts';
import { MVP_SHARES, T0, UNION_CAPACITY, UNION_REFILL_PER_SECOND } from './kit.ts';

type Entry = 'api' | 'stream' | 'worker';
const ENTRIES: readonly Entry[] = ['api', 'stream', 'worker'];
const NEST_TIMEOUT_MS = 60_000;

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

/** The entry's REDIS double: every namespace answers each script with RedisUnavailableError. */
function fakeRedis() {
  const spaces: { readonly name: string; readonly eval: Mock<RedisNamespace['eval']> }[] = [];
  const namespace = vi.fn<RedisHandle['namespace']>((name) => {
    const evalScript = vi.fn<RedisNamespace['eval']>(() =>
      Promise.reject(new redisModule.RedisUnavailableError('connect_failed', 'ECONNREFUSED')),
    );
    spaces.push({ name, eval: evalScript });
    return { get: async () => null, set: async () => undefined, eval: evalScript };
  });
  const close = vi.fn(async () => undefined);
  const handle: RedisHandle = { namespace, close, onApplicationShutdown: close };
  return {
    handle,
    /** Scripts sent so far, per namespace name of this handle. */
    scripts(): Map<string, number> {
      const counts = new Map<string, number>();
      for (const space of spaces) {
        counts.set(space.name, (counts.get(space.name) ?? 0) + space.eval.mock.calls.length);
      }
      return counts;
    },
  };
}

async function boot(entry: Entry) {
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
  const redis = fakeRedis();
  vi.spyOn(redisModule, 'createRedisHandle').mockResolvedValue(redis.handle);
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
  const clock = new platform.FixedClock(T0);
  const context = await NestFactory.createApplicationContext(
    AppModule.forEntry({
      entry,
      config: platform.loadConfig({ APP_ENV: 'test' }),
      clock,
      logger: memoryLogger(entry).logger,
      redisUrl: connection(entry).redisUrl,
      // api builds GovernedUnion without a database; stream and worker build theirs only with one.
      ...(entry === 'api'
        ? {}
        : { dbHandles: { db: compileOnlyDb(), dbRead: null, close: async () => undefined } }),
    }),
    { logger: false, abortOnError: false },
  );
  return { context, redis, shared, memory, clock };
}

/** What one entry's assembly built, plus one online token asked of every shared limiter. */
async function wiring(entry: Entry) {
  const built = await boot(entry);
  try {
    const endpoints = built.context.get(UNION_ENDPOINTS, {
      strict: false,
    }) as readonly UnionEndpoint[];
    const calls = built.shared.mock.calls;
    const answers: unknown[] = [];
    // Per limiter: the namespace names of the entry's handle that received a script for its call.
    const scriptedIn: string[][] = [];
    for (const result of built.shared.mock.results) {
      const before = built.redis.scripts();
      answers.push(
        result.type === 'return' ? await result.value.tryAcquire('online') : result.type,
      );
      scriptedIn.push(
        [...built.redis.scripts()]
          .filter(([name, count]) => count > (before.get(name) ?? 0))
          .map(([name]) => name),
      );
    }
    return {
      quotaKeys: [...new Set(endpoints.map((endpoint) => endpoint.quotaKey))].sort(),
      memoryCalls: built.memory.mock.calls.length,
      configs: calls.map(([config]) => ({
        bucketKey: config.bucketKey,
        capacity: config.capacity,
        refillPerSecond: config.refillPerSecond,
        shares: { ...config.shares },
      })),
      clocks: calls.map(([, deps]) => deps.clock === built.clock),
      answers,
      scriptedIn,
    };
  } finally {
    await built.context.close();
  }
}

it.each(ENTRIES)(
  '[D10-446][R-04] %s 入口的联盟配额全是 Redis 共享桶：每个平台一桶（容量 100、10/s、MVP 份额）、同一命名空间、进程 CLOCK，不再建内存桶；Redis 不可用即拒',
  async (entry) => {
    const built = await wiring(entry);
    expect(built.quotaKeys.length).toBeGreaterThan(0);
    expect({
      memoryCalls: built.memoryCalls,
      buckets: [...new Set(built.configs.map((config) => config.bucketKey))].sort(),
      configs: built.configs,
      entryClock: built.clocks.every((same) => same),
      answers: built.answers,
      // Each decision is one script in one namespace of the entry's REDIS handle…
      scriptedNamespacesPerCall: built.scriptedIn.map((names) => names.length),
      // …and every limiter of the entry uses the same namespace name.
      namespaceNames: new Set(built.scriptedIn.flat()).size,
    }).toEqual({
      memoryCalls: 0,
      buckets: built.quotaKeys,
      configs: built.configs.map((config) => ({
        bucketKey: config.bucketKey,
        capacity: UNION_CAPACITY,
        refillPerSecond: UNION_REFILL_PER_SECOND,
        shares: MVP_SHARES,
      })),
      entryClock: true,
      answers: built.configs.map(() => false),
      scriptedNamespacesPerCall: built.configs.map(() => 1),
      namespaceNames: 1,
    });
  },
  NEST_TIMEOUT_MS,
);

it(
  '[D10-446] api / stream / worker 用同一个 Redis 命名空间：三个进程里同一平台的配额落在同一桶',
  async () => {
    const names: string[] = [];
    const keys: string[][] = [];
    for (const entry of ENTRIES) {
      const built = await wiring(entry);
      names.push(...built.scriptedIn.flat());
      keys.push([...new Set(built.configs.map((config) => config.bucketKey))].sort());
      vi.restoreAllMocks();
    }
    expect({
      everyEntryBuilt: keys.every((entryKeys) => entryKeys.length > 0),
      sameBuckets: keys.every((entryKeys) => entryKeys.join('\n') === keys[0]?.join('\n')),
      scripted: names.length > 0,
      distinctNamespaces: new Set(names).size,
    }).toEqual({ everyEntryBuilt: true, sameBuckets: true, scripted: true, distinctNamespaces: 1 });
  },
  NEST_TIMEOUT_MS * 3,
);
