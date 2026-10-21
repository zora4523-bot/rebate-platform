import { afterEach, expect, it, vi } from 'vitest';
import { api, growth, ROOT } from './kit.ts';

// Same boundary as B1-03u / B3-03h: run the real entry, stub infrastructure and signals.
// Dynamic imports keep Nest decorators out of the spec project's TypeScript compilation.
interface Platform {
  JOB_QUEUE: symbol;
  loadConfig(env: object): object;
  loadConnectionConfig(...args: unknown[]): object;
  loadMaintConnectionConfig(...args: unknown[]): unknown;
  createRootLogger(...args: unknown[]): unknown;
  createDbHandles(...args: unknown[]): unknown;
  startWorkerServices(parts: { queue: { start(): Promise<void> } }): Promise<{
    stop(): Promise<void>;
  }>;
}
type Logging = typeof import('../../../../apps/api/src/modules/platform/logging/logger.ts');

const originalExitCode = process.exitCode;
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

it('[AC-B1-35#102] worker 入口启动邀请奖励循环，关闭先等待它 stop 再关闭服务', async () => {
  const platform = await api<Platform>('platform/index.ts');
  const logging = await api<Logging>('platform/logging/logger.ts');
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createWorkerContext(...args: unknown[]): Promise<unknown>;
  };
  const runner = (await import(new URL('apps/api/src/entry.ts', ROOT).href)) as {
    runEntry(entry: 'worker'): Promise<void>;
  };
  const risk = await api<{ riskScanToken(): symbol }>('risk/index.ts');
  const identity = await api<{ payoutVerifyRecheckToken(): symbol }>('identity/index.ts');
  const agent = await api<{ agentSweeperToken(): symbol }>('agent/index.ts');
  const orders = await api<{ orderSyncToken(): symbol }>('orders/index.ts');
  const unrelatedTokens = new Set([
    risk.riskScanToken(),
    identity.payoutVerifyRecheckToken(),
    agent.agentSweeperToken(),
    orders.orderSyncToken(),
  ]);
  const g = await growth();
  const lines: string[] = [];
  const logger = logging.createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const messages = () => lines.map((line) => (JSON.parse(line) as { msg: string }).msg);
  const config = platform.loadConfig({ APP_ENV: 'test' });
  vi.spyOn(platform, 'loadConfig').mockReturnValue(config);
  vi.spyOn(platform, 'loadConnectionConfig').mockReturnValue({ redisUrl: null });
  vi.spyOn(platform, 'loadMaintConnectionConfig').mockReturnValue(null);
  vi.spyOn(platform, 'createRootLogger').mockReturnValue(logger);
  vi.spyOn(platform, 'createDbHandles').mockReturnValue({
    db: {},
    dbRead: {},
    close: async () => undefined,
  });
  const order: string[] = [];
  const scanner = { tick: vi.fn(async () => undefined) };
  vi.spyOn(g, 'createInviteRewardScanner').mockReturnValue(scanner);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = vi.fn(async () => {
    order.push('reward-stop-called');
    await gate;
    order.push('reward-stopped');
  });
  const start = vi.spyOn(g, 'startInviteRewardWorker').mockImplementation(() => {
    order.push(messages().includes('started') ? 'reward-start-too-late' : 'reward-start');
    return { stop };
  });
  const queue = {
    start: vi.fn(async () => {
      order.push('queue-start');
    }),
    stop: vi.fn(async () => undefined),
  };
  vi.spyOn(boot, 'createWorkerContext').mockResolvedValue({
    close: async () => undefined,
    get: (token: symbol) => {
      if (token === platform.JOB_QUEUE) return queue;
      if (unrelatedTokens.has(token)) return null;
      return scanner;
    },
  });
  const servicesStop = vi.fn(async () => {
    order.push('services-stop');
  });
  vi.spyOn(platform, 'startWorkerServices').mockImplementation(async (parts) => {
    await parts.queue.start();
    return { stop: servicesStop };
  });
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const originalOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((
    event: string,
    listener: (...args: unknown[]) => void,
  ) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      handlers.set(event, listener);
      return process;
    }
    return originalOn(event as never, listener as never);
  }) as never);
  vi.useFakeTimers();
  try {
    await runner.runEntry('worker');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ scanner, logger });
    expect(order).toEqual(['queue-start', 'reward-start']);
    expect(messages()).toContain('started');
    expect(handlers.has('SIGTERM')).toBe(true);
    handlers.get('SIGTERM')!('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(servicesStop).not.toHaveBeenCalled();
    expect(messages()).not.toContain('stopped');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(servicesStop).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      'queue-start',
      'reward-start',
      'reward-stop-called',
      'reward-stopped',
      'services-stop',
    ]);
    expect(messages()).toContain('stopped');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release();
    // Clean up the real entry even when its wiring assertion is still red.
    handlers.get('SIGTERM')?.('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
  }
});
