// B1-01zzi brief B.2: with config.metrics set, runEntry gives the worker's registry a collectFund
// built from the orders, settlement and payout read ports over the worker's own database handle
// (platform imports no business module; entry.ts assembles it), next to B1-01zzh's collect; the
// other four entries get neither. The stand-ins follow B1-01zzh's entry test: the platform exports
// are spied on the platform surface and on platform/metrics, the database compiles and logs every
// query but never connects (kit recordingDb), nothing listens. Dynamic imports keep Nest decorators out of the spec
// project's TypeScript compilation.
import { afterEach, expect, it, vi } from 'vitest';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import * as metrics from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import type {
  MetricsRegistry,
  MetricsRegistryOptions,
  MetricsServerOptions,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import { ROOT } from '../metrics/kit.ts';
import { PORT_TABLES, SQL_CLOCK, WRITE_SQL, mentions, recordingDb } from './kit.ts';

type Entry = 'api' | 'stream' | 'admin' | 'worker' | 'payout';
const ENTRIES: readonly Entry[] = ['api', 'stream', 'admin', 'worker', 'payout'];
const METRICS_CONFIG = { host: '10.0.3.7', port: 9464 };

interface Boot {
  createHttpApp(...args: unknown[]): Promise<unknown>;
  createWorkerContext(...args: unknown[]): Promise<unknown>;
}

const originalExitCode = process.exitCode;
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

async function fixture() {
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as Boot;
  const { runEntry } = (await import(new URL('apps/api/src/entry.ts', ROOT).href)) as {
    runEntry(entry: Entry): Promise<void>;
  };
  const base = platform.loadConfig({ APP_ENV: 'test' });
  const config = { ...base, metrics: METRICS_CONFIG } as ReturnType<typeof platform.loadConfig>;
  vi.spyOn(platform, 'loadConfig').mockReturnValue(config);
  const connections = platform.loadConnectionConfig('worker', {
    DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
    REDIS_URL: 'redis://127.0.0.1:1',
  });
  vi.spyOn(platform, 'loadConnectionConfig').mockReturnValue(connections);
  vi.spyOn(platform, 'loadMaintConnectionConfig').mockReturnValue(null);
  const logger = platform.createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: () => undefined },
  );
  vi.spyOn(platform, 'createRootLogger').mockReturnValue(logger);
  const queries: string[] = [];
  // No rows during startup (as in B1-01zzh's test); one empty row per query while collectFund runs.
  const answer = { oneRow: false };
  const db = recordingDb(queries, () => (answer.oneRow ? [{}] : []));
  vi.spyOn(platform, 'createDbHandles').mockReturnValue({
    db,
    dbRead: null,
    close: async () => undefined,
  });
  const queue = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
  const app = {
    init: async () => undefined,
    listen: async () => undefined,
    close: async () => undefined,
    get: (token: unknown) => (token === platform.JOB_QUEUE ? queue : null),
  };
  vi.spyOn(boot, 'createHttpApp').mockResolvedValue(app);
  vi.spyOn(boot, 'createWorkerContext').mockResolvedValue(app);
  vi.spyOn(platform, 'startWorkerServices').mockImplementation(async (parts) => {
    await parts.queue.start();
    return { stop: async () => parts.queue.stop() };
  });

  const registries: { options: MetricsRegistryOptions; registry: MetricsRegistry }[] = [];
  const servers: { options: MetricsServerOptions }[] = [];
  const createRegistry = (registryOptions: MetricsRegistryOptions): MetricsRegistry => {
    const registry: MetricsRegistry = {
      contentType: 'text/plain; version=0.0.4; charset=utf-8',
      render: async () => '',
    };
    registries.push({ options: registryOptions, registry });
    return registry;
  };
  const startServer = async (serverOptions: MetricsServerOptions) => {
    servers.push({ options: serverOptions });
    return { port: serverOptions.port, close: vi.fn(async () => undefined) };
  };
  vi.spyOn(platform, 'createMetricsRegistry').mockImplementation(createRegistry);
  vi.spyOn(metrics, 'createMetricsRegistry').mockImplementation(createRegistry);
  vi.spyOn(platform, 'startMetricsServer').mockImplementation(startServer);
  vi.spyOn(metrics, 'startMetricsServer').mockImplementation(startServer);

  const handlers = new Map<string, (...args: unknown[]) => void>();
  const originalOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      handlers.set(event, listener);
      return process;
    }
    return originalOn(event, listener);
  });
  vi.useFakeTimers();
  return {
    runEntry,
    registries,
    servers,
    queries,
    answer,
    /** Delivers SIGTERM to the last started entry and lets its shutdown run. */
    async stop() {
      const handler = handlers.get('SIGTERM');
      handlers.clear();
      handler?.('SIGTERM');
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

it('[AC-B1-01zzi#14] worker 的 registry 带 collectFund：经本入口库读三个模块端口的表、不写、不读数据库时钟，collect 照旧；其余四个入口没有 collectFund', async () => {
  const f = await fixture();
  try {
    for (const entry of ENTRIES) {
      const before = f.servers.length;
      await f.runEntry(entry);
      expect(process.exitCode, `${entry} failed to start`).toBe(originalExitCode);
      expect(f.servers.length - before, `${entry}: metrics servers started`).toBe(1);
      const server = f.servers.at(-1)!;
      const made = f.registries.filter((r) => r.registry === server.options.registry);
      expect(made, `${entry}: served registry comes from createMetricsRegistry`).toHaveLength(1);
      const registryOptions = made[0]!.options;
      expect(registryOptions.entry).toBe(entry);
      if (entry === 'worker') {
        expect(registryOptions.collectFund, 'worker collectFund').toEqual(expect.any(Function));
        expect(registryOptions.collect, 'worker collect (B1-01zzh)').toEqual(expect.any(Function));
        f.queries.length = 0;
        // The stand-in database answers one empty row per query; only the reads matter here.
        f.answer.oneRow = true;
        await Promise.resolve()
          .then(() => registryOptions.collectFund!())
          .catch(() => undefined);
        f.answer.oneRow = false;
        for (const table of Object.values(PORT_TABLES).flat()) {
          expect(
            f.queries.some((q) => mentions(q, table)),
            `collectFund reads ${table}`,
          ).toBe(true);
        }
        expect(f.queries.filter((q) => WRITE_SQL.test(q))).toEqual([]);
        expect(f.queries.filter((q) => SQL_CLOCK.test(q))).toEqual([]);
      } else {
        expect(registryOptions.collectFund, entry).toBeUndefined();
        expect(registryOptions.collect, entry).toBeUndefined();
      }
      await f.stop();
    }
  } finally {
    await f.stop();
  }
}, 30_000);
