// B1-15f: the worker entry starts the expiry timer after the payout verification recheck and stops
// it after the recheck drained, before the services stop (brief §9.2 #1 装配, «已定» 调度「启停排在
// worker 入口里收款复核之后」; rule-test list item 11). Only the worker starts it. The entry runs with
// every external part replaced (queue, context, services), like B1-13g's entry test.
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
  const expiryToken = Symbol('test-deletion-expiry');
  vi.spyOn(api, 'payoutVerifyRecheckToken').mockReturnValue(recheckToken);
  vi.spyOn(api, 'deletionExpiryToken').mockReturnValue(expiryToken);
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
  const recheckRunner = { runOnce: vi.fn(async () => ({ scanned: 0 })) };
  const expiryRunner = { runOnce: vi.fn(async () => ({ scanned: 0 })) };
  const queue = {
    start: vi.fn(async () => {
      order.push('queue-start');
    }),
    stop: vi.fn(async () => undefined),
  };
  const app: App = {
    init: async () => undefined,
    listen: async () => undefined,
    close: async () => {
      order.push('context-close');
    },
    get: (token) => {
      if (token === p.platform.JOB_QUEUE) return queue;
      if (token === risk.riskScanToken()) return scan;
      if (token === recheckToken) return recheckRunner;
      if (token === expiryToken) return expiryRunner;
      if (token === orders.orderSyncToken())
        return { start: () => ({ stop: async () => undefined }) };
      if (token === agent.agentSweeperToken())
        return { start: () => ({ stop: async () => undefined }) };
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
  vi.spyOn(api, 'startPayoutVerifyRecheck').mockImplementation(() => {
    order.push('recheck-start');
    return {
      stop: async () => {
        order.push('recheck-stop');
        await Promise.resolve();
        order.push('recheck-drained');
      },
    };
  });
  const expiryGate = deferred<void>();
  const expiryStop = vi.fn(async () => {
    order.push('expiry-stop');
    await expiryGate.promise;
    order.push('expiry-drained');
  });
  const starts: { resolve: () => unknown; stopping: () => boolean }[] = [];
  const start = vi
    .spyOn(api, 'startDeletionExpiry')
    .mockImplementation((resolve, _logger, stopping) => {
      order.push('expiry-start');
      starts.push({ resolve, stopping });
      return { stop: expiryStop };
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
    entry,
    order,
    start,
    starts,
    scan,
    expiryRunner,
    expiryToken,
    get,
    expiryStop,
    servicesStop,
    expiryGate,
    signal() {
      expect(handlers.has('SIGTERM')).toBe(true);
      handlers.get('SIGTERM')!('SIGTERM');
    },
    async drain() {
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

it('[AC-B1-15f#26] worker 在收款复核之后启动注销到期定时器；停机在复核 drain 之后、服务停止之前等它 drain', async () => {
  const f = await fixture();
  try {
    await f.entry.runEntry('worker');
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.order.indexOf('recheck-start')).toBeGreaterThanOrEqual(0);
    expect(f.order.indexOf('expiry-start')).toBeGreaterThan(f.order.indexOf('recheck-start'));
    expect(f.starts[0]!.resolve()).toBe(f.expiryRunner);
    expect(f.get).toHaveBeenCalledWith(f.expiryToken, { strict: false });
    expect(f.starts[0]!.stopping()).toBe(false);
    f.signal();
    await f.drain();
    expect(f.starts[0]!.stopping()).toBe(true);
    expect(f.expiryStop).toHaveBeenCalledTimes(1);
    expect(f.order.indexOf('recheck-drained')).toBeLessThan(f.order.indexOf('expiry-stop'));
    expect(f.servicesStop).not.toHaveBeenCalled();
    expect(f.order).not.toContain('context-close');
    f.expiryGate.resolve();
    await f.drain();
    expect(f.servicesStop).toHaveBeenCalledTimes(1);
    expect(f.order.indexOf('expiry-drained')).toBeLessThan(f.order.indexOf('services-stop'));
    expect(f.order.indexOf('expiry-drained')).toBeLessThan(f.order.indexOf('context-close'));
    expect(vi.getTimerCount()).toBe(0);
    for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
      await f.entry.runEntry(entry);
      f.signal();
      await f.drain();
      expect(f.start).toHaveBeenCalledTimes(1);
    }
  } finally {
    f.expiryGate.resolve();
    f.signal();
    await f.drain();
  }
}, 30_000);

it('[AC-B1-15f#27] seed 时已收到停机信号，不再装注销到期定时器', async () => {
  const f = await fixture();
  try {
    // First establish that the worker wires the hook at all: the baseline must be red.
    await f.entry.runEntry('worker');
    expect(f.start).toHaveBeenCalledTimes(1);
    f.expiryGate.resolve();
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
    f.expiryGate.resolve();
    f.signal();
    await f.drain();
  }
}, 30_000);
