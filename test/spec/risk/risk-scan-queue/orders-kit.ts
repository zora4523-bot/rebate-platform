// Shared helpers of the B1-03w orders-side rule tests (ruling D10-343 ①): the order snapshot
// compensation scan's job, dispatched every round by createSnapshotRetryScheduler through JobQueue
// onto order-sync (jobs/snapshot-retry.ts) and routed by the order-sync handler of
// createOrderSyncRuntime (worker-runtime.ts). Its name must be `snapshot_retry` (orchestrator §9.2
// #1, the job-name rule of platform/queue validateSend); the singletonKey keeps the readable
// prefix `snapshot-retry:` (§9.2 #2). Nothing here opens a database connection.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  QUEUE_CATALOG,
  QueueError,
  type JobHandler,
  type JobPayload,
  type QueueRuntime,
  type QueueSpec,
  type SendOptions,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { validateSend } from '../../../../apps/api/src/modules/platform/queue/validation.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import type { OrderSyncRuntimeDeps } from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import { describeError } from './kit.ts';

export const ORDER_SYNC = 'order-sync';
/** The compensation scan's job name fixed by the orchestrator (§9.2 #1). */
export const SNAPSHOT_RETRY = 'snapshot_retry';

/** `snapshot-retry:<app_id>`: the readable key of one App's scan (§9.2 #2, unchanged). */
export function snapshotKey(appId: string): string {
  return `snapshot-retry:${appId}`;
}

/** The production catalog entry of the order-sync queue (exclusive, B1-08g). */
export function orderSyncSpec(): QueueSpec {
  const spec = QUEUE_CATALOG.find((item) => item.name === ORDER_SYNC);
  if (spec === undefined) throw new Error('order-sync is missing from QUEUE_CATALOG');
  return spec;
}

export interface OrderSent {
  readonly queue: string;
  readonly name: string;
  readonly payload: JobPayload;
  readonly singletonKey: string | undefined;
  readonly trx: unknown;
  /** 'accepted' or describeError of what the send rejected with. */
  readonly outcome: string;
}

/**
 * A QueueRuntime double whose send checks exactly what QueueRuntime.send checks before touching
 * the database: catalog queue ('unknown_queue'), then the real validateSend of platform/queue
 * against the production order-sync entry. Handlers given to register() are kept.
 */
export function validatingOrderQueue() {
  const spec = orderSyncSpec();
  const sends: OrderSent[] = [];
  const handlers: [string, JobHandler][] = [];
  const queue: QueueRuntime = {
    async send(queueName: string, name: string, payload: JobPayload, options: SendOptions) {
      let failure: { readonly error: unknown } | null = null;
      try {
        if (queueName !== spec.name) throw new QueueError('unknown_queue');
        validateSend(spec, name, payload, options);
      } catch (error) {
        failure = { error };
      }
      sends.push({
        queue: queueName,
        name,
        payload,
        singletonKey: options.singletonKey,
        trx: options.trx,
        outcome: failure === null ? 'accepted' : describeError(failure.error),
      });
      if (failure !== null) throw failure.error;
      return randomUUID();
    },
    register(queueName: string, handler: JobHandler) {
      handlers.push([queueName, handler]);
    },
    start: async () => undefined,
    stop: async () => undefined,
  };
  return { queue, sends, handlers };
}

/** Real query compilation, empty results, no socket or database; compiled SQL into `queries`. */
export function loggedDb(queries: string[]): Kysely<DB> {
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      queries.push(event.query.sql);
    },
  });
}

/** The deps of createOrderSyncRuntime as the worker passes them, union and other modules stubbed. */
export function orderRuntimeDeps(input: {
  readonly db: Kysely<DB>;
  readonly queue: QueueRuntime;
  readonly logger: RootLogger;
  readonly at: string;
}): OrderSyncRuntimeDeps {
  return {
    db: input.db,
    clock: new FixedClock(input.at),
    logger: input.logger,
    queue: input.queue,
    events: { publish: vi.fn() },
    endpoints: [],
    registry: { registrations: () => [], get: vi.fn() },
    ports: {
      users: () => ({ findByAttrCode: vi.fn() }),
      bindings: () => ({ findByRelation: vi.fn() }),
      quota: (endpoint) => ({ bucketKey: endpoint.quotaKey, tryAcquire: () => true }),
    },
    // Compensation retry is on only with a snapshot port (B1-08t); it is never reached here.
    snapshots: { create: async () => ({ kind: 'pending', reason: 'plain-plain-plain-plain' }) },
  };
}
