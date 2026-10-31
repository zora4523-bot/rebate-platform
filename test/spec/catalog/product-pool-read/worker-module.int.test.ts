// B1-05r: queue pool-refresh on the worker entry (F-ADM-10, 02 §11). CatalogWorkerModule.forWorker
// registers the handler and runs the seed on its own timer, as SettlementModule.forWorker; only the
// worker entry imports it. Nothing here calls the seed: the module's timer (fake setTimeout and
// setInterval) does, against real PostgreSQL and pg-boss. The module is loaded at run time, as the
// settlement kit loads its own: Nest decorators stay out of the spec project's compile.
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import { GovernedUnion } from '../../../../apps/api/src/modules/catalog/ports.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';
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
  secondsAgo,
  seedItem,
  seedPool,
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
      fake.answers.set(`rawRef-${stable}`, () => ({
        platform: 'taobao',
        item_id: `rawRef-${stable}`,
        title: title(stable),
        price_fen: 6000n,
        coupon_fen: 1000n,
        final_price_fen: 5000n,
        commission_rate_bp: 1500n,
        quoted_at: clock.now().toISOString(),
      }));
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
