// B1-05r: queue pool-refresh on the worker entry (app.module imports this module there only). Like
// SettlementModule.forWorker it registers the handler on JOB_QUEUE and runs the seed on its own
// timer; without a database or a queue nothing is registered and no timer runs. dropDetailCache
// works on the entry's optional REDIS, on the namespace and key cacheDetailUpstream writes.
import type { DB as Database } from '@couli/db';
import type { DynamicModule } from '@nestjs/common';
import type { Kysely } from 'kysely';
import {
  CLOCK,
  DB,
  JOB_QUEUE,
  REDIS,
  ROOT_LOGGER,
  type Clock,
  type QueueRuntime,
  type RedisHandle,
  type RootLogger,
} from '../platform/index.ts';
import { createCatalog } from './application/catalog.ts';
import type { CatalogWarning } from './domain/types.ts';
import { RAW_REPARSE_NAMESPACE } from './application/raw-reparse.ts';
import { PRODUCT_CACHE_NAMESPACE, detailCacheDropper } from './infra/product-cache.ts';
import {
  GovernedUnion,
  POOL_EXTRA_JOBS,
  type CatalogConfigReader,
  type PoolExtraJobs,
} from './ports.ts';
import {
  createPoolRefreshJobHandler,
  seedPoolRefresh,
  type PoolRefreshOptions,
} from './worker/pool-refresh.ts';

export interface CatalogWorkerOptions {
  /**
   * Provides and exports GovernedUnion, assembled by app.module as for CatalogAdminModule, and
   * optionally POOL_EXTRA_JOBS.
   */
  readonly ports: DynamicModule;
  /** content's configuration reader on the worker's handle. */
  readonly config: (db: Kysely<Database>, clock: Clock) => CatalogConfigReader;
}

const POOL_REFRESH_WORKER = Symbol('CATALOG_POOL_REFRESH_WORKER');
const POOL_REFRESH_QUEUE = 'pool-refresh';
const FIRST_TICK_MS = 5_000;
const TICK_INTERVAL_MS = 60_000;

interface PoolRefreshLifecycle {
  onApplicationBootstrap(): void;
  onModuleDestroy(): Promise<void>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The seed on the module's own timer; a failed tick is logged, the next one decides anew. */
function poolRefreshTimer(options: PoolRefreshOptions): PoolRefreshLifecycle {
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let first: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;

  function tick(): void {
    if (stopped || inFlight !== null) return;
    inFlight = seedPoolRefresh(options)
      .catch((error: unknown) => {
        options.logger.warn(
          { queue: POOL_REFRESH_QUEUE, error_name: errorName(error) },
          'pool_refresh_tick_failed',
        );
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return {
    onApplicationBootstrap() {
      first = setTimeout(() => {
        first = undefined;
        if (stopped) return;
        tick();
        interval = setInterval(tick, TICK_INTERVAL_MS);
        interval.unref();
      }, FIRST_TICK_MS);
      first.unref();
    },
    async onModuleDestroy() {
      stopped = true;
      if (first !== undefined) clearTimeout(first);
      if (interval !== undefined) clearInterval(interval);
      if (inFlight !== null) await inFlight;
    },
  };
}

export class CatalogWorkerModule {
  static forWorker(options: CatalogWorkerOptions): DynamicModule {
    return {
      module: CatalogWorkerModule,
      imports: [options.ports],
      providers: [
        {
          provide: POOL_REFRESH_WORKER,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            GovernedUnion,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: REDIS, optional: true },
            { token: POOL_EXTRA_JOBS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            union: GovernedUnion,
            db?: Kysely<Database>,
            queue?: QueueRuntime,
            redis?: RedisHandle,
            extraJobs?: PoolExtraJobs,
          ): PoolRefreshLifecycle => {
            if (db === undefined || queue === undefined) {
              logger.info({ queue: POOL_REFRESH_QUEUE }, 'pool_refresh_worker_disabled');
              return {
                onApplicationBootstrap: () => undefined,
                onModuleDestroy: () => Promise.resolve(),
              };
            }
            const workerLogger = logger.child({ module: 'catalog', queue: POOL_REFRESH_QUEUE });
            const cache = redis === undefined ? null : redis.namespace(PRODUCT_CACHE_NAMESPACE);
            const refresh: PoolRefreshOptions = {
              db,
              clock,
              queue,
              logger: workerLogger,
              config: options.config(db, clock),
              catalog: createCatalog({
                db,
                clock,
                warn: (event: CatalogWarning) => {
                  workerLogger.warn(
                    { event: `catalog_${event.kind}`, product_key: event.key },
                    'product_key alias chain not resolved',
                  );
                },
              }),
              union,
              dropDetailCache: detailCacheDropper(cache, workerLogger),
              redis: redis === undefined ? null : redis.namespace(RAW_REPARSE_NAMESPACE),
            };
            queue.register(POOL_REFRESH_QUEUE, createPoolRefreshJobHandler(refresh, extraJobs));
            return poolRefreshTimer(refresh);
          },
        },
      ],
    };
  }
}
