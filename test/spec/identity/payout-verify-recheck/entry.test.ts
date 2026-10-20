import { afterEach, expect, it, vi } from 'vitest';
import { ROOT, compileOnlyDb, deferred, identity, ports } from './kit.ts';

type Entry = 'worker' | 'api' | 'stream' | 'admin' | 'payout';
interface App {
  init(): Promise<void>;
  listen(): Promise<void>;
  close(): Promise<void>;
  get(token: unknown, options?: { strict: boolean }): unknown;
}

const originalExitCode = process.exitCode;
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

async function fixture() {
  const api = await identity();
  const p = await ports();
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(...args: unknown[]): Promise<App>;
    createWorkerContext(...args: unknown[]): Promise<App>;
  };
  const entry = (await import(new URL('apps/api/src/entry.ts', ROOT).href)) as {
    runEntry(entry: Entry): Promise<void>;
  };
  const risk = (await import(new URL('apps/api/src/modules/risk/index.ts', ROOT).href)) as {
    riskScanToken(): symbol;
    startRiskScanHeal(...args: unknown[]): { stop(): void };
  };
  const orders = (await import(new URL('apps/api/src/modules/orders/index.ts', ROOT).href)) as {
    orderSyncToken(): symbol;
  };
  const agent = (await import(new URL('apps/api/src/modules/agent/index.ts', ROOT).href)) as {
    agentSweeperToken(): symbol;
  };
  const order: string[] = [];
  const recheckToken = Symbol('test-recheck');
  vi.spyOn(api, 'payoutVerifyRecheckToken').mockReturnValue(recheckToken);
  const config = p.platform.loadConfig({ APP_ENV: 'test' });
  vi.spyOn(p.platform, 'loadConfig').mockReturnValue(config);
  const connections = p.platform.loadConnectionConfig('worker', {
    DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
    REDIS_URL: 'redis://127.0.0.1:1',
  });
  vi.spyOn(p.platform, 'loadConnectionConfig').mockReturnValue(connections);
  vi.spyOn(p.platform, 'loadMaintConnectionConfig').mockReturnValue(null);
  vi.spyOn(p.platform, 'createRootLogger').mockReturnValue(p.logger);
  const db = compileOnlyDb([]);
  vi.spyOn(p.platform, 'createDbHandles').mockReturnValue({
    db,
    dbRead: null,
    close: () => db.destroy(),
  });
  const scan = {
    seed: vi.fn(async () => {
      order.push('seed');
    }),
    heal: vi.fn(async () => undefined),
  };
  const runner = { runOnce: vi.fn(async () => ({ scanned: 0 })) };
  const queue = {
    start: vi.fn(async () => {
      order.push('queue-start');
    }),
    stop: vi.fn(async () => undefined),
  };
  const syncStop = vi.fn(async () => {
    order.push('sync-stop');
  });
  const loopStop = vi.fn(async () => {
    order.push('loop-stop');
  });
  const app: App = {
    init: async () => undefined,
    listen: async () => undefined,
    close: async () => {
      order.push('context-close');
    },
    get: (token) => {
      if (token === p.platform.JOB_QUEUE) return queue;
      if (token === risk.riskScanToken()) return scan;
      if (token === recheckToken) return runner;
      if (token === orders.orderSyncToken()) return { start: () => ({ stop: syncStop }) };
      if (token === agent.agentSweeperToken()) return { start: () => ({ stop: loopStop }) };
      return null;
    },
  };
  const get = vi.spyOn(app, 'get');
  vi.spyOn(boot, 'createHttpApp').mockResolvedValue(app);
  vi.spyOn(boot, 'createWorkerContext').mockResolvedValue(app);
  const servicesStop = vi.fn(async () => {
    order.push('services-stop');
    await app.close();
  });
  vi.spyOn(p.platform, 'startWorkerServices').mockImplementation(async (parts) => {
    await parts.queue.start();
    return { stop: servicesStop };
  });
  vi.spyOn(risk, 'startRiskScanHeal').mockImplementation(() => {
    order.push('heal-start');
    return {
      stop: () => {
        order.push('heal-stop');
      },
    };
  });
  const stopGate = deferred<void>();
  const recheckStop = vi.fn(async () => {
    order.push('recheck-stop');
    await stopGate.promise;
    order.push('recheck-drained');
  });
  const starts: { resolve: () => unknown; stopping: () => boolean }[] = [];
  const start = vi
    .spyOn(api, 'startPayoutVerifyRecheck')
    .mockImplementation((resolve, _logger, stopping) => {
      order.push('recheck-start');
      starts.push({ resolve, stopping });
      return { stop: recheckStop };
    });
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
    ...p,
    entry,
    order,
    start,
    starts,
    scan,
    runner,
    get,
    recheckToken,
    recheckStop,
    syncStop,
    loopStop,
    servicesStop,
    stopGate,
    signal() {
      expect(handlers.has('SIGTERM')).toBe(true);
      handlers.get('SIGTERM')!('SIGTERM');
    },
    async drain() {
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

it('[AC-B1-13g#40] worker 在 risk heal 后启动复核；停机先等复核 drain，再停循环、服务与池', async () => {
  const f = await fixture();
  try {
    await f.entry.runEntry('worker');
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.order.slice(0, 4)).toEqual(['queue-start', 'seed', 'heal-start', 'recheck-start']);
    expect(f.starts[0]!.resolve()).toBe(f.runner);
    expect(f.get).toHaveBeenCalledWith(f.recheckToken, { strict: false });
    expect(f.starts[0]!.stopping()).toBe(false);
    f.signal();
    await f.drain();
    expect(f.starts[0]!.stopping()).toBe(true);
    expect(f.recheckStop).toHaveBeenCalledTimes(1);
    expect(f.syncStop).not.toHaveBeenCalled();
    expect(f.loopStop).not.toHaveBeenCalled();
    expect(f.servicesStop).not.toHaveBeenCalled();
    expect(f.order).not.toContain('context-close');
    f.stopGate.resolve();
    await f.drain();
    expect(f.servicesStop).toHaveBeenCalledTimes(1);
    expect(f.order.indexOf('recheck-drained')).toBeLessThan(f.order.indexOf('sync-stop'));
    expect(f.order.indexOf('recheck-drained')).toBeLessThan(f.order.indexOf('loop-stop'));
    expect(f.order.indexOf('recheck-drained')).toBeLessThan(f.order.indexOf('context-close'));
    expect(vi.getTimerCount()).toBe(0);
    for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
      await f.entry.runEntry(entry);
      f.signal();
      await f.drain();
      expect(f.start).toHaveBeenCalledTimes(1);
    }
  } finally {
    f.stopGate.resolve();
    f.signal();
    await f.drain();
  }
}, 30_000);

it('[AC-B1-13g#41] seed 时已收到停机信号，不再装复核循环', async () => {
  const f = await fixture();
  try {
    // First establish that the worker actually wires the hook: baseline must be red.
    await f.entry.runEntry('worker');
    expect(f.start).toHaveBeenCalledTimes(1);
    f.stopGate.resolve();
    f.signal();
    await f.drain();
    f.start.mockClear();
    f.scan.seed.mockImplementationOnce(async () => {
      f.signal();
    });
    await f.entry.runEntry('worker');
    await f.drain();
    expect(f.start).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    f.stopGate.resolve();
    f.signal();
    await f.drain();
  }
}, 30_000);
