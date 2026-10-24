// B1-01zzh brief B.3: with config.metrics set, runEntry starts one metrics server per entry on
// { host, port } with that entry's registry — the worker's registry gets a collect function reading
// through the worker's own database handle, the others none — and closes it on shutdown. Unset
// metrics or COULI_EXIT_AFTER_INIT opens no metrics server. The entry calls the platform exports
// createMetricsRegistry / startMetricsServer (spied here on the platform surface and on
// platform/metrics, whichever the entry imports); queue, contexts and services are stand-ins, like
// B1-15f's entry test. Nothing listens and no database is reached. Dynamic imports keep Nest
// decorators out of the spec project's TypeScript compilation.
import { afterEach, expect, it, vi } from 'vitest';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import * as metrics from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import type {
  MetricsRegistry,
  MetricsRegistryOptions,
  MetricsServerOptions,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import { compileOnlyDb, ROOT } from './kit.ts';

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

async function fixture(options: { metrics: boolean; exitAfterInit?: boolean }) {
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as Boot;
  const { runEntry } = (await import(new URL('apps/api/src/entry.ts', ROOT).href)) as {
    runEntry(entry: Entry): Promise<void>;
  };
  const base = platform.loadConfig({
    APP_ENV: 'test',
    ...(options.exitAfterInit === true ? { COULI_EXIT_AFTER_INIT: '1' } : {}),
  });
  const config = (options.metrics ? { ...base, metrics: METRICS_CONFIG } : base) as ReturnType<
    typeof platform.loadConfig
  >;
  vi.spyOn(platform, 'loadConfig').mockReturnValue(config);
  const connections = platform.loadConnectionConfig('worker', {
    DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
    REDIS_URL: 'redis://127.0.0.1:1',
  });
  vi.spyOn(platform, 'loadConnectionConfig').mockReturnValue(connections);
  vi.spyOn(platform, 'loadMaintConnectionConfig').mockReturnValue(null);
  const lines: string[] = [];
  const logger = platform.createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  vi.spyOn(platform, 'createRootLogger').mockReturnValue(logger);
  const queries: string[] = [];
  const db = compileOnlyDb(queries);
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
  const servers: { options: MetricsServerOptions; close: () => Promise<void> }[] = [];
  const createRegistry = (registryOptions: MetricsRegistryOptions): MetricsRegistry => {
    const registry: MetricsRegistry = {
      contentType: 'text/plain; version=0.0.4; charset=utf-8',
      render: async () => '',
    };
    registries.push({ options: registryOptions, registry });
    return registry;
  };
  const startServer = async (serverOptions: MetricsServerOptions) => {
    const close = vi.fn(async () => undefined);
    servers.push({ options: serverOptions, close });
    return { port: serverOptions.port, close };
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
    started: () => lines.filter((line) => line.includes('"msg":"started"')).length,
    /** Delivers SIGTERM to the last started entry and lets its shutdown run. */
    async stop() {
      const handler = handlers.get('SIGTERM');
      handlers.clear();
      handler?.('SIGTERM');
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

it('[AC-B1-01zzh#11] 设了 metrics：五个入口各起一个 metrics 服务器，worker 的 registry 带经本入口库的 collect，其余只进程级；停机时关闭', async () => {
  const f = await fixture({ metrics: true });
  try {
    for (const entry of ENTRIES) {
      const before = f.servers.length;
      await f.runEntry(entry);
      expect(process.exitCode, `${entry} failed to start`).toBe(originalExitCode);
      expect(f.servers.length - before, `${entry}: metrics servers started`).toBe(1);
      const server = f.servers.at(-1)!;
      expect(server.options.host).toBe(METRICS_CONFIG.host);
      expect(server.options.port).toBe(METRICS_CONFIG.port);
      const made = f.registries.filter((r) => r.registry === server.options.registry);
      expect(made, `${entry}: served registry comes from createMetricsRegistry`).toHaveLength(1);
      const registryOptions = made[0]!.options;
      expect(registryOptions.entry).toBe(entry);
      if (entry === 'worker') {
        expect(registryOptions.collect).toEqual(expect.any(Function));
        f.queries.length = 0;
        // The stand-in database answers every query with no rows; only the reads matter here.
        await Promise.resolve()
          .then(() => registryOptions.collect!())
          .catch(() => undefined);
        expect(f.queries.some((q) => /"?pgboss"?\."?job"?/.test(q))).toBe(true);
        expect(f.queries.some((q) => /"?sync_cursors"?/.test(q))).toBe(true);
        expect(f.queries.filter((q) => /^\s*(insert|update|delete)\b/i.test(q))).toEqual([]);
      } else {
        expect(registryOptions.collect, entry).toBeUndefined();
      }
      expect(server.close).not.toHaveBeenCalled();
      await f.stop();
      expect(server.close, `${entry}: metrics server closed on shutdown`).toHaveBeenCalledTimes(1);
    }
  } finally {
    await f.stop();
  }
}, 30_000);

it('[AC-B1-01zzh#12] 未设 metrics 不起服务器；COULI_EXIT_AFTER_INIT 时即使设了也不监听', async () => {
  // Baseline first: with metrics set, the worker does start one (red until the entry is wired).
  const on = await fixture({ metrics: true });
  try {
    await on.runEntry('worker');
    expect(on.servers).toHaveLength(1);
  } finally {
    await on.stop();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();

  const off = await fixture({ metrics: false });
  try {
    for (const entry of ENTRIES) {
      await off.runEntry(entry);
      await off.stop();
    }
    expect(off.started()).toBe(ENTRIES.length);
    expect(off.servers).toEqual([]);
  } finally {
    await off.stop();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();

  const init = await fixture({ metrics: true, exitAfterInit: true });
  for (const entry of ENTRIES) await init.runEntry(entry);
  expect(init.started()).toBe(ENTRIES.length);
  expect(init.servers).toEqual([]);
}, 30_000);
