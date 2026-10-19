// B1-08n: the worker's order-sync assembly (规划/02 §7.1～§7.3). OrdersModule.forWorker (orders.module.ts)
// calls createOrderSyncRuntime once with the worker's handles; entry.ts later calls start() once.
// - Building the runtime runs no query, sends nothing and arms no timer: it reads
//   specs/order-status-map/<platform>.csv once per scheduled platform (a missing file is
//   MISSING_STATUS_MAP, any other read error is rethrown: the worker does not start), wraps every
//   configured union adapter once in the worker's own governance (offline breaker readable by the
//   access port; quota and breakers per process, 待裁定 6), builds the cursor store, the update
//   step (B1-08i) and the attribution pipeline (B1-08h) over the platform EVENT_BUS, and registers
//   the order-sync handler. The scheduler and the handler share the same access instance.
// - start() starts the scheduler's timer loops only (createOrderSyncScheduler); every call starts
//   one more set (entry.ts calls it once).
// Other modules' readers come in as ports from app.module (identity users, linking bindings, the
// quota limiter, B1-08q's source backfill ports); union's are read through union/index.ts. orders
// never imports linking, identity, catalog or content.
// - B1-08q: when ports.sources is given, one OrderSourcePorts object is built at assembly (no read)
//   and the same object goes to the pipeline and the update step; the update step also gets the
//   pipeline's pids reader so its backfill knows the order's pid_scene (D10-60).
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import { readFileSync } from 'node:fs';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  systemScheduler,
  type Clock,
  type EventBus,
  type QueueRuntime,
  type QuotaLimiter,
  type RootLogger,
  type Scheduler,
} from '../platform/index.ts';
import {
  REGISTERED_PLATFORMS,
  createGovernedSyncAdapter,
  createUnionOrderReaders,
  createUnionSyncAccess,
  type RegisteredPlatform,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionRegistry,
} from '../union/index.ts';
import { createOrderPipeline } from './application/pipeline-port.ts';
import type { OrderPipelineDeps, OrderPipelinePort } from './application/pipeline-types.ts';
import type { OrderSourcePorts } from './application/source-backfill.ts';
import type {
  SyncAccessPort,
  SyncCursorStore,
  SyncLogger,
  SyncRegistry,
} from './application/sync-ports.ts';
import {
  ORDER_SYNC_QUEUE,
  createOrderSyncScheduler,
  type SyncIntervalConfig,
} from './application/sync-scheduler.ts';
import { createOrderUpdateStep, type OrderUpdateDeps } from './application/update-step.ts';
import { loadStatusMap, type StatusMap } from './domain/status-map.ts';
import { scheduledPlatforms } from './domain/sync-window.ts';
import { createSyncCursorStore } from './infra/sync-cursors.ts';
import { handleOrderSyncWindow } from './jobs/order-sync.ts';

export interface OrderSyncRuntime {
  readonly access: SyncAccessPort;
  readonly cursors: SyncCursorStore;
  readonly registry: SyncRegistry;
  readonly pipeline: OrderPipelinePort;
  readonly statusMaps: (platform: RegisteredPlatform) => StatusMap;
  readonly logger: SyncLogger;
  start(): { stop(): Promise<void> };
}

/** Readers and limits owned by other modules, assembled in app.module (orders imports neither). */
export interface OrderSyncReadPorts {
  /** identity: users.attr_code → user_id in one App, any status. */
  readonly users: (db: Kysely<DB>) => OrderPipelineDeps['users'];
  /** linking: union_bindings of (App, account, relation_id), any status. */
  readonly bindings: (db: Kysely<DB>) => OrderPipelineDeps['bindings'];
  /** The quota bucket of one platform's governed adapter in this process (endpoint.quotaKey). */
  readonly quota: (endpoint: UnionEndpoint, scheduler: Scheduler) => QuotaLimiter;
  /**
   * B1-08q: the source backfill ports (BR-ATTR-15; linking's link_logs, catalog's key prefixes,
   * content's config_items), called once at assembly and reading nothing until used. Absent (a
   * runtime built without them) → no source backfill: the four source columns stay NULL.
   */
  readonly sources?: (db: Kysely<DB>, clock: Clock, logger: RootLogger) => OrderSourcePorts;
}

export interface OrderSyncRuntimeDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly queue: QueueRuntime;
  readonly events: EventBus;
  readonly endpoints: readonly UnionEndpoint[];
  readonly registry: UnionRegistry;
  readonly ports: OrderSyncReadPorts;
}

const ORDER_SYNC = Symbol('ORDER_SYNC');

/** The DI token of the worker's order-sync runtime; the same symbol on every call. */
export function orderSyncToken(): symbol {
  return ORDER_SYNC;
}

/** One read of the platform's mapping file; a missing file is null (loadStatusMap refuses it). */
function readStatusMapCsv(platform: RegisteredPlatform): string | null {
  try {
    // specs/ at the repository root; same depth from src/ and dist/.
    return readFileSync(
      new URL(`../../../../../specs/order-status-map/${platform}.csv`, import.meta.url),
      'utf8',
    );
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null;
    throw error;
  }
}

function loadStatusMaps(): (platform: RegisteredPlatform) => StatusMap {
  const maps = new Map<RegisteredPlatform, StatusMap>();
  for (const platform of scheduledPlatforms()) {
    maps.set(platform, loadStatusMap(platform, readStatusMapCsv(platform)));
  }
  return (platform) => maps.get(platform) ?? loadStatusMap(platform, null);
}

// TODO(规划/11 §4.5): order_sync.<platform>.interval_seconds 的全局读法 — blocked on 平台级配置口径
const DEFAULT_INTERVAL: SyncIntervalConfig = { get: async () => undefined };

// TODO(规划/11 §4.5): 返利首态 R1/R2 与更新时的返利迁移 — blocked on settlement 立项
// Until then an attributed order keeps the column default rebate_status (UNATTRIBUTED).
const PENDING_SETTLEMENT: OrderPipelineDeps['rebate'] = {
  onImported: async () => undefined,
};
const PENDING_SETTLEMENT_UPDATES: OrderUpdateDeps['rebate'] = {
  onUpdated: async () => undefined,
  onUnmappedStatus: async () => undefined,
};

export function createOrderSyncRuntime(deps: OrderSyncRuntimeDeps): OrderSyncRuntime {
  const { db, clock, logger, queue, events, endpoints } = deps;
  const statusMaps = loadStatusMaps();

  const scheduler = systemScheduler();
  const governed = new Map<
    RegisteredPlatform,
    { readonly adapter: UnionAdapter; offlineBreakerState(): 'closed' | 'open' }
  >();
  for (const platform of REGISTERED_PLATFORMS) {
    const endpoint = endpoints.find((entry) => entry.platform === platform);
    if (endpoint === undefined) continue;
    governed.set(
      platform,
      createGovernedSyncAdapter(deps.registry.get(platform), {
        endpoint,
        scheduler,
        quota: deps.ports.quota(endpoint, scheduler),
      }),
    );
  }
  const registry: SyncRegistry = {
    get(platform) {
      const entry = governed.get(platform);
      if (entry === undefined) throw new Error(`union: no endpoint for ${platform}`);
      return entry.adapter;
    },
  };
  const access: SyncAccessPort = createUnionSyncAccess({
    db,
    endpoints,
    breaker: (platform) => governed.get(platform)?.offlineBreakerState() ?? 'closed',
    logger,
  });
  const cursors = createSyncCursorStore(db, clock);

  const readers = createUnionOrderReaders(db);
  const users = deps.ports.users(db);
  const bindings = deps.ports.bindings(db);
  // B1-08q: one sources object for both steps (built here, read on use).
  const sources = deps.ports.sources?.(db, clock, logger);
  const updateStep = createOrderUpdateStep({
    clock,
    users,
    bindings,
    pids: readers.pids,
    statusMaps,
    logger,
    rebate: PENDING_SETTLEMENT_UPDATES,
    events,
    ...(sources === undefined ? {} : { sources }),
  });
  const pipeline = createOrderPipeline({
    db,
    clock,
    statusMaps,
    pids: readers.pids,
    accounts: readers.accounts,
    users,
    bindings,
    rebate: PENDING_SETTLEMENT,
    updateStep,
    events,
    logger,
    ...(sources === undefined ? {} : { sources }),
  });

  const handler = { access, cursors, registry, pipeline, logger };
  queue.register(ORDER_SYNC_QUEUE, (job) => handleOrderSyncWindow(job, handler));
  const sync = createOrderSyncScheduler(
    { clock, queue, cursors, access, logger },
    DEFAULT_INTERVAL,
  );
  return {
    access,
    cursors,
    registry,
    pipeline,
    statusMaps,
    logger,
    start: () => sync.start(),
  };
}
