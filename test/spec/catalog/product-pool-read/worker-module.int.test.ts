// B1-05r: queue pool-refresh on the worker entry (F-ADM-10, 02 §11). CatalogWorkerModule.forWorker
// registers the handler and runs the seed on its own timer, as SettlementModule.forWorker; only the
// worker entry imports it. The timer case calls no seed: the module's timer (fake setTimeout and
// setInterval) does, against real PostgreSQL and pg-boss. The cache case stays on real timers for
// the Redis client, so it seeds by hand and runs the jobs through the handler the module registered.
// The module is loaded at run time, as the settlement kit loads its own: Nest decorators stay out of
// the spec project's compile.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import type { ProductDetailUpstream } from '../../../../apps/api/src/modules/catalog/detail.ts';
import {
  PRODUCT_CACHE_NAMESPACE,
  cacheDetailUpstream,
} from '../../../../apps/api/src/modules/catalog/infra/product-cache.ts';
import { GovernedUnion } from '../../../../apps/api/src/modules/catalog/ports.ts';
import { seedPoolRefresh } from '../../../../apps/api/src/modules/catalog/worker/pool-refresh.ts';
import {
  FixedClock,
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createRedisHandle,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { UnionError, type UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import {
  ROOT,
  fakeQueue,
  silentRootLogger,
  withDatabase,
  withRealQueue,
  workerContext,
  type NestContext,
} from '../../settlement/worker/kit.ts';
import { title } from '../section-items/kit.ts';
import {
  QUEUE,
  REFRESH_NOW,
  REFRESH_SEC,
  TIMEOUT,
  configOf,
  drainJobs,
  fakeUnion,
  itemRow,
  refreshOptionsOf,
  secondsAgo,
  seedItem,
  seedPool,
  seedRef,
  tenant,
} from './kit.ts';

/** Upper bound of the first delay and of the period of the module's timer. */
const STEP_MS = 60_000;
/** Real-time bound of waiting for a tick's sends. */
const WAIT_MS = 60_000;
const ENTRIES = ['api', 'stream', 'admin', 'worker', 'payout'] as const;

interface CatalogWorkerModuleLike {
  forWorker(options: { readonly ports: unknown; readonly config: () => unknown }): unknown;
}

async function catalogWorkerModule(): Promise<CatalogWorkerModuleLike> {
  const url = new URL('apps/api/src/modules/catalog/catalog-worker.module.ts', ROOT);
  const loaded = (await import(url.href)) as { CatalogWorkerModule: CatalogWorkerModuleLike };
  return loaded.CatalogWorkerModule;
}

function unionPorts(union: GovernedUnion) {
  class UnionPorts {}
  return {
    module: UnionPorts,
    providers: [{ provide: GovernedUnion, useValue: union }],
    exports: [GovernedUnion],
  };
}

/** `module` beside a global REDIS, as PlatformModule provides it on the worker entry. */
function withRedis(module: unknown, redis: RedisHandle) {
  class RedisDependency {}
  class Harness {}
  return {
    module: Harness,
    imports: [
      {
        module: RedisDependency,
        global: true,
        providers: [{ provide: REDIS, useValue: redis }],
        exports: [REDIS],
      },
      module,
    ],
  };
}

/** A handle on the run's test Redis; the keys carry a test's own app_id. */
async function withTestRedis(run: (redis: RedisHandle) => Promise<void>): Promise<void> {
  const server = await acquireTestRedis();
  try {
    const redis = await createRedisHandle(
      loadConnectionConfig('api', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/rules',
        REDIS_URL: server.url,
      }),
      { logger: silentRootLogger() },
    );
    expect(redis).not.toBeNull();
    try {
      await run(redis!);
    } finally {
      await redis!.close();
    }
  } finally {
    await server.stop();
  }
}

/** The union's answer for this product, received now. */
function unionItem(stable: string, clock: FixedClock): UnionItemDetail {
  return {
    platform: 'taobao',
    item_id: `rawRef-${stable}`,
    title: title(stable),
    price_fen: 6000n,
    coupon_fen: 1000n,
    final_price_fen: 5000n,
    commission_rate_bp: 1500n,
    quoted_at: clock.now().toISOString(),
  };
}

/** Lets the module's database work run (real I/O; the fake timers do not cover it). */
async function settle(db: Kysely<DB>): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await sql`SELECT 1`.execute(db);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

it(
  '[F-ADM-10] forWorker 只在 pool-refresh 上注册处理器；没有数据库或队列时什么都不注册，也能启动',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const CatalogWorkerModule = await catalogWorkerModule();
      const module = () =>
        CatalogWorkerModule.forWorker({
          ports: unionPorts(fakeUnion().union),
          config: () => configOf(new Map()),
        });
      const clock = new FixedClock(REFRESH_NOW);
      const logger = silentRootLogger();

      const full = fakeQueue();
      const complete = await workerContext(module(), { clock, logger, db, queue: full });
      await complete.close();
      expect(full.registered.map((entry) => entry.queue)).toEqual([QUEUE]);

      const noDatabase = fakeQueue();
      const withoutDb = await workerContext(module(), { clock, logger, queue: noDatabase });
      await withoutDb.close();
      expect(noDatabase.registered).toEqual([]);

      const withoutQueue = await workerContext(module(), { clock, logger, db });
      await withoutQueue.close();
    });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] forWorker 自己的定时器种任务：注册的处理器跑完写回行、用途是 pool_refresh；模块关闭后不再投递',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const owner = await tenant(db);
      const clock = new FixedClock(REFRESH_NOW);
      const stable = 'Kworkertimer01';
      const pool = await seedPool(db, owner, clock);
      await seedItem(db, owner, clock, pool, `tb:${stable}`, {
        quoted_at: secondsAgo(clock, 4000),
      });
      const fake = fakeUnion();
      fake.answers.set(`rawRef-${stable}`, () => unionItem(stable, clock));
      const CatalogWorkerModule = await catalogWorkerModule();
      const module = CatalogWorkerModule.forWorker({
        ports: unionPorts(fake.union),
        config: () => configOf(new Map()),
      });

      await withRealQueue(db, async (queue) => {
        const sends = () => queue.sent.filter((job) => job.queue === QUEUE);
        vi.useFakeTimers({
          toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
        let context: NestContext | undefined;
        try {
          context = await workerContext(module, {
            clock,
            logger: silentRootLogger(),
            db,
            queue,
          });
          const deadline = performance.now() + WAIT_MS;
          while (sends().length === 0) {
            if (performance.now() > deadline) expect.fail("no send by the module's own timer");
            await vi.advanceTimersByTimeAsync(STEP_MS);
            await settle(db);
          }

          const [registered] = queue.registered;
          expect(registered?.queue).toBe(QUEUE);
          await drainJobs(db, registered!.handler);
          expect(await itemRow(db, owner.appId, pool, `tb:${stable}`)).toMatchObject({
            final_price_fen: 5000n,
            commission_rate_bp: 1500,
          });
          expect(fake.contexts.every((call) => call.purpose === 'pool_refresh')).toBe(true);
          expect(fake.contexts.length).toBeGreaterThan(0);

          await context.close();
          context = undefined;
          const sentBefore = queue.sent.length;
          clock.advanceMs(REFRESH_SEC * 1000);
          for (let step = 0; step < 5; step += 1) {
            await vi.advanceTimersByTimeAsync(STEP_MS);
            await settle(db);
          }
          expect(queue.sent).toHaveLength(sentBefore);
        } finally {
          await context?.close();
          vi.useRealTimers();
        }
      });
    });
  },
  TIMEOUT,
);

it(
  '[BR-PROD-07] forWorker 注册的处理器遇到下架真的删 Redis 里的详情缓存：删之前命中，删之后回源',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const CatalogWorkerModule = await catalogWorkerModule();
      const fake = fakeUnion();
      const module = CatalogWorkerModule.forWorker({
        ports: unionPorts(fake.union),
        config: () => configOf(new Map()),
      });
      const owner = await tenant(db);
      const clock = new FixedClock(REFRESH_NOW);
      const stable = 'Kworkerdrop01';
      const key = `tb:${stable}`;
      const pool = await seedPool(db, owner, clock);
      await seedItem(db, owner, clock, pool, key, { quoted_at: secondsAgo(clock, 4000) });
      await seedRef(db, owner, clock, stable);
      fake.answers.set(
        `rawRef-${stable}`,
        () => new UnionError('item_unavailable', 'synthetic off shelf', 'taobao'),
      );

      await withTestRedis(async (redis) => {
        const upstream = {
          detail: vi.fn<ProductDetailUpstream['detail']>(async () => unionItem(stable, clock)),
        };
        const cached = cacheDetailUpstream(upstream, {
          redis: redis.namespace(PRODUCT_CACHE_NAMESPACE),
          clock,
          config: configOf(new Map()),
        });
        const request = { appId: owner.appId, productKey: key, platform: 'taobao' as const };
        await cached.detail(request);
        await cached.detail(request);
        expect(upstream.detail).toHaveBeenCalledTimes(1);

        await withRealQueue(db, async (queue) => {
          const context = await workerContext(withRedis(module, redis), {
            clock,
            logger: silentRootLogger(),
            db,
            queue,
          });
          // Inside the context: closing it closes the REDIS handle it was given.
          try {
            const [registered] = queue.registered;
            expect(registered?.queue).toBe(QUEUE);
            const seeding = refreshOptionsOf(db, queue, fake.union, clock, new Map(), () =>
              Promise.resolve(),
            );
            await seedPoolRefresh(seeding);
            await drainJobs(db, registered!.handler);

            expect(await itemRow(db, owner.appId, pool, key)).toMatchObject({ status: 'offline' });
            await cached.detail(request);
            expect(upstream.detail).toHaveBeenCalledTimes(2);
          } finally {
            await context.close();
          }
        });
      });
    });
  },
  TIMEOUT,
);

it(
  '[F-ADM-10] 只有 worker 入口装配 CatalogWorkerModule，别的入口不消费 pool-refresh',
  async () => {
    const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
      AppModule: { forEntry(options: object): unknown };
    };
    const target = await catalogWorkerModule();
    const forWorker = vi.spyOn(target, 'forWorker').mockReturnValue({ module: class Stand {} });
    try {
      const calls: Partial<Record<(typeof ENTRIES)[number], number>> = {};
      for (const entry of ENTRIES) {
        forWorker.mockClear();
        AppModule.forEntry({
          entry,
          config: loadConfig({ APP_ENV: 'test' }),
          clock: new FixedClock(REFRESH_NOW),
          logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }, { write() {} }),
        });
        calls[entry] = forWorker.mock.calls.length;
      }
      expect(calls).toEqual({ api: 0, stream: 0, admin: 0, worker: 1, payout: 0 });
    } finally {
      forWorker.mockRestore();
    }
  },
  TIMEOUT,
);
