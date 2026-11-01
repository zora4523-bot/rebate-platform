// B1-04zr rule tests: the worker's production ports, read off the real assembly, over a database
// that answers without a connection. orderSyncPorts is not exported: AppModule hands its return
// value to OrdersModule.forWorker, so that call is where a test reads it, and nothing here passes a
// rescanConfig of its own. The runtime is then built directly with those ports: only the orders
// timers run, not the other modules' timers of a whole worker context, and the handler is the
// branch production takes (snapshots injected). No endpoints: without a live endpoint union's
// queryableAccount answers null, which is the worker without jd credentials; a test that wants a
// queryable account says so with withCredentials().
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { afterEach, expect, vi } from 'vitest';
import {
  FixedClock,
  createRootLogger,
  type Clock,
  type JobHandler,
  type JobQueue,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createOrderSyncRuntime,
  type OrderSyncReadPorts,
  type OrderSyncRuntime,
  type OrderSyncRuntimeDeps,
} from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import type { RegisteredPlatform } from '../../../../apps/api/src/modules/union/index.ts';
import { ACCOUNT, HOUR_MS, NOW, NOW_MS, PDD_ACCOUNT, TAOBAO_ACCOUNT } from '../rescan/kit.ts';
import { contextOf } from '../wiring/context-kit.ts';

const APP = 'jd-sync-spec';
/** Behind now by more than a window of either platform, so both streams have one to send. */
const INCREMENT_AT = new Date(NOW_MS - 3 * HOUR_MS);
const SYNC_START_AT = new Date('2026-01-01T00:00:00.000Z');

function unionAccount(platform: RegisteredPlatform, id: string) {
  return {
    id,
    app_id: APP,
    platform,
    sync_start_at: SYNC_START_AT,
    auth_status: 'active',
    auth_expires_at: null,
  };
}

/** One enabled account per scheduled platform, as app.union_accounts holds them. */
const UNION_ACCOUNTS = [unionAccount('jd', ACCOUNT), unionAccount('pdd', PDD_ACCOUNT)];

const OWNERS: Readonly<Record<RegisteredPlatform, string>> = {
  jd: ACCOUNT,
  pdd: PDD_ACCOUNT,
  taobao: TAOBAO_ACCOUNT,
};

type Answer = (query: CompiledQuery) => readonly unknown[];

class AnsweringDriver extends DummyDriver {
  readonly #answer: Answer;

  constructor(answer: Answer) {
    super();
    this.#answer = answer;
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const answer = this.#answer;
    return {
      executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => ({
        rows: answer(query) as R[],
      }),
      streamQuery: (): never => {
        throw new Error('synthetic database: no streaming');
      },
    };
  }
}

const databases: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

/**
 * A database without a connection that answers what the worker reads: config_items from `config`
 * (absent key → no row), the increment cursor of any stream, no rescan cursor, and the accounts.
 * `queries` collects the SQL it was asked.
 */
export function storedDb(config: Readonly<Record<string, unknown>> = {}) {
  const queries: string[] = [];
  const answer: Answer = (query) => {
    if (query.sql.includes('config_items')) {
      const key = query.parameters.find(
        (value): value is string => typeof value === 'string' && Object.hasOwn(config, value),
      );
      return key === undefined ? [] : [{ app_id: APP, key, value: config[key], version: 1 }];
    }
    if (query.sql.includes('sync_cursors')) {
      return query.parameters.includes('increment') ? [{ cursor_at: INCREMENT_AT }] : [];
    }
    return query.sql.includes('union_accounts') ? UNION_ACCOUNTS : [];
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new AnsweringDriver(answer),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      queries.push(event.query.sql);
    },
  });
  databases.push(db);
  return { db, queries };
}

/** What AppModule gives OrdersModule.forWorker, of which these tests need the runtime's ports. */
export type WorkerPorts = OrderSyncReadPorts & {
  readonly snapshots: (
    db: Kysely<DB>,
    clock: Clock,
    logger: RootLogger,
  ) => NonNullable<OrderSyncRuntimeDeps['snapshots']>;
};

/** The real return value of orderSyncPorts, off a real worker assembly (compile-only database). */
export async function productionPorts(): Promise<WorkerPorts> {
  // By URL, as context-kit.ts: decorated controllers stay out of the spec project's TS compilation.
  const { OrdersModule } = (await import(
    new URL('../../../../apps/api/src/modules/orders/index.ts', import.meta.url).href
  )) as { OrdersModule: { forWorker(options: WorkerPorts): unknown } };
  const forWorker = vi.spyOn(OrdersModule, 'forWorker');
  const f = await contextOf('worker', true);
  try {
    expect(forWorker).toHaveBeenCalledTimes(1);
    return forWorker.mock.calls[0]![0];
  } finally {
    await f.context.close();
  }
}

interface LogLine {
  readonly level: number;
  readonly msg: string;
  readonly platform?: string;
  readonly reason?: string;
}

/** A runtime over `ports` on the snapshots branch, with its sends and log lines recorded. */
export function workerOf(ports: WorkerPorts, db: Kysely<DB>) {
  const lines: LogLine[] = [];
  const clock = new FixedClock(NOW);
  const logger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(JSON.parse(line) as LogLine) },
  );
  const send = vi.fn<JobQueue['send']>(async () => 'synthetic');
  const runtime = createOrderSyncRuntime({
    db,
    clock,
    logger,
    queue: {
      register: vi.fn<(queue: string, handler: JobHandler) => void>(),
      send,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
    events: { publish: vi.fn() },
    endpoints: [],
    registry: { registrations: () => [], get: vi.fn() },
    ports,
    snapshots: ports.snapshots(db, clock, logger),
  });
  return {
    runtime,
    clock,
    lines: () => [...lines],
    /** The payloads sent to the order-sync queue under one job name. */
    sent: (job: string) =>
      send.mock.calls
        .filter(([queue, name]) => queue === 'order-sync' && name === job)
        .map(([, , payload]) => payload),
  };
}

/** The deployment's adapters hold credentials: each platform's account is the queryable one. */
export function withCredentials(runtime: OrderSyncRuntime): void {
  vi.spyOn(runtime.access, 'queryableAccount').mockImplementation(
    async (platform: RegisteredPlatform) => OWNERS[platform],
  );
}
