// B1-01zzo brief B.2: runEntry('worker') wraps the collectFund it builds from the orders,
// settlement and payout ports in cacheFundCollector (worker clock, default 5 minutes) before
// handing it to createMetricsRegistry; B1-01zzh's collect is not wrapped. The test follows
// B1-01zzi's entry test, except that the spied createMetricsRegistry builds the real registry, so
// its render() runs the entry's own collectors over a database that compiles and logs every query
// but never connects (B1-01zzh's compileOnlyDb, no rows). The worker clock is the system clock of
// the test config, moved here by fake Date only. Nothing listens. Dynamic imports keep Nest
// decorators out of the spec project's TypeScript compilation.
import { afterEach, expect, it, vi } from 'vitest';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import * as metrics from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import type {
  MetricsRegistry,
  MetricsRegistryOptions,
  MetricsServerOptions,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import { FUND_TABLES, fundFromText, fundNamesIn, mentions } from '../fund-metrics/kit.ts';
import { ROOT, compileOnlyDb } from '../metrics/kit.ts';
import { NOW_MS, TTL_MS } from './kit.ts';

type Entry = 'api' | 'stream' | 'admin' | 'worker' | 'payout';
const ENTRIES: readonly Entry[] = ['api', 'stream', 'admin', 'worker', 'payout'];
const METRICS_CONFIG = { host: '10.0.3.7', port: 9464 };

/** The real registry factory, taken before any spy replaces the export. */
const realCreateRegistry = metrics.createMetricsRegistry;

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

/** Queries that read one of the fund port tables. */
function fundReads(queries: readonly string[]): string[] {
  return queries.filter((q) => FUND_TABLES.some((table) => mentions(q, table)));
}

/** Every fund port table is read by some query. */
function expectEveryFundTable(queries: readonly string[], when: string): void {
  for (const table of FUND_TABLES) {
    expect(
      queries.some((q) => mentions(q, table)),
      `${when}: reads ${table}`,
    ).toBe(true);
  }
}

/** Queries of B1-01zzh's collect (pgboss.job). */
function jobReads(queries: readonly string[]): string[] {
  return queries.filter((q) => /"?pgboss"?\."?job"?/.test(q));
}

async function fixture() {
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as Boot;
  const { runEntry } = (await import(new URL('apps/api/src/entry.ts', ROOT).href)) as {
    runEntry(entry: Entry): Promise<void>;
  };
  const base = platform.loadConfig({ APP_ENV: 'test' });
  // No CLOCK_NOW: the worker clock is the system clock, which reads the faked Date below.
  const config = { ...base, metrics: METRICS_CONFIG, clockNow: undefined } as ReturnType<
    typeof platform.loadConfig
  >;
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
  vi.spyOn(platform, 'createDbHandles').mockReturnValue({
    db: compileOnlyDb(queries),
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
    const registry = realCreateRegistry(registryOptions);
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
  // Date is faked too: the worker's system clock reads it, and only this test moves it.
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'Date',
    ],
  });
  vi.setSystemTime(NOW_MS);
  return {
    runEntry,
    registries,
    servers,
    queries,
    /** Delivers SIGTERM to the last started entry and lets its shutdown run. */
    async stop() {
      const handler = handlers.get('SIGTERM');
      handlers.clear();
      handler?.('SIGTERM');
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

it('[AC-B1-01zzo#8] worker 装配走缓存：5 分钟内两次 render 只查一次资金端口表（collect 每次照查），过 5 分钟再查；直接调 collectFund 也共用缓存；其余四个入口没有 collectFund、render 不查库也无资金指标', async () => {
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
      const { options, registry } = made[0]!;
      expect(options.entry).toBe(entry);
      if (entry === 'worker') {
        expect(options.collectFund, 'worker collectFund').toEqual(expect.any(Function));
        expect(options.collect, 'worker collect (B1-01zzh)').toEqual(expect.any(Function));

        f.queries.length = 0;
        const first = await registry.render();
        expectEveryFundTable(f.queries, 'first scrape');
        expect(jobReads(f.queries), 'first scrape: collect').not.toEqual([]);

        f.queries.length = 0;
        const second = await registry.render();
        expect(fundReads(f.queries), 'second scrape at the same instant').toEqual([]);
        expect(jobReads(f.queries), 'second scrape: collect is not cached').not.toEqual([]);
        expect(fundFromText(second)).toEqual(fundFromText(first));

        vi.setSystemTime(NOW_MS + TTL_MS - 1);
        f.queries.length = 0;
        const third = await registry.render();
        expect(fundReads(f.queries), 'one millisecond before 5 minutes').toEqual([]);
        expect(fundFromText(third)).toEqual(fundFromText(first));

        vi.setSystemTime(NOW_MS + TTL_MS + 1);
        f.queries.length = 0;
        const fourth = await registry.render();
        expectEveryFundTable(f.queries, 'after 5 minutes');
        expect(fundFromText(fourth)).toEqual(fundFromText(first));

        // The registry's collectFund is the cached one: same snapshot object, no new reads.
        f.queries.length = 0;
        const a = await options.collectFund!();
        const b = await options.collectFund!();
        expect(b).toBe(a);
        expect(fundReads(f.queries), 'direct calls within 5 minutes').toEqual([]);
      } else {
        expect(options.collectFund, entry).toBeUndefined();
        expect(options.collect, entry).toBeUndefined();
        f.queries.length = 0;
        const text = await registry.render();
        expect(fundNamesIn(text), entry).toEqual([]);
        expect(f.queries, `${entry}: render reads no table`).toEqual([]);
      }
      await f.stop();
    }
  } finally {
    await f.stop();
  }
}, 30_000);
