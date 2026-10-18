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
import { afterEach, expect, vi } from 'vitest';
import type { ReceivedJob } from '../../../../apps/api/src/modules/platform/index.ts';
import type { OrderSyncRuntime } from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import { ports } from '../../risk/freeze-expiry/kit.ts';
import { capture } from '../attribution/kit.ts';

const databases: Kysely<DB>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

export function compileOnlyDb(queries: string[]): Kysely<DB> {
  const db = new Kysely<DB>({
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
  databases.push(db);
  return db;
}

interface Context {
  get(token: unknown, options?: { strict: boolean }): unknown;
  close(): Promise<void>;
}

export async function contextOf(
  entry: string,
  withDb: boolean,
  suppliedDb?: Kysely<DB>,
  withoutQueue = false,
) {
  // URL imports keep decorated HTTP controllers out of the spec project's TS compilation.
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: object): unknown } };
  const platform = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as {
    PlatformModule: { forRoot(options: object): { providers?: unknown[]; exports?: unknown[] } };
    JOB_QUEUE: symbol;
    EVENT_BUS: symbol;
    CLOCK: symbol;
    ROOT_LOGGER: symbol;
    loadConfig(env: Record<string, string>): unknown;
  };
  const { PlatformModule, JOB_QUEUE, loadConfig } = platform;
  const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: { createApplicationContext(module: unknown, options: object): Promise<Context> };
  };
  const p = await ports();
  const queries: string[] = [];
  const queue = {
    send: vi.fn(async () => 'fixture'),
    register: vi.fn<(name: string, handler: (job: ReceivedJob) => Promise<void>) => void>(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const original = PlatformModule.forRoot.bind(PlatformModule);
  vi.spyOn(PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = original(options);
    if (withoutQueue) {
      const omitted = new Set([JOB_QUEUE, platform.EVENT_BUS]);
      return {
        ...module,
        providers: (module.providers ?? []).filter(
          (p) =>
            !(
              typeof p === 'object' &&
              p !== null &&
              'provide' in p &&
              omitted.has(p.provide as symbol)
            ),
        ),
        exports: (module.exports ?? []).filter((p) => !omitted.has(p as symbol)),
      };
    }
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === JOB_QUEUE
          ? { provide: JOB_QUEUE, useValue: queue }
          : provider,
      ),
    };
  });
  const context = await NestFactory.createApplicationContext(
    AppModule.forEntry({
      entry,
      config: loadConfig({ APP_ENV: 'test' }),
      clock: p.clock,
      logger: p.logger,
      ...(withDb
        ? {
            dbHandles: {
              db: suppliedDb ?? compileOnlyDb(queries),
              dbRead: null,
              close: async () => undefined,
            },
          }
        : {}),
    }),
    { logger: false, abortOnError: false },
  );
  const lines = () => p.lines.map((line) => JSON.parse(line) as { level: number; msg: string });
  return { context, queries, queue, lines, platform };
}

export async function token() {
  const orders = (await import(
    new URL('../../../../apps/api/src/modules/orders/index.ts', import.meta.url).href
  )) as {
    orderSyncToken?: () => symbol;
    OrdersModule: { forWorker?: unknown };
  };
  expect(typeof orders.orderSyncToken).toBe('function');
  const result = await capture(() => orders.orderSyncToken!());
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw result.error;
  expect(typeof result.value).toBe('symbol');
  expect(orders.orderSyncToken!()).toBe(result.value);
  expect(typeof orders.OrdersModule.forWorker).toBe('function');
  return result.value;
}

export async function runtime(context: Context): Promise<OrderSyncRuntime> {
  const key = await token();
  const result = await capture(() => context.get(key, { strict: false }));
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    start: expect.any(Function),
    pipeline: { process: expect.any(Function) },
  });
  return result.value as OrderSyncRuntime;
}
