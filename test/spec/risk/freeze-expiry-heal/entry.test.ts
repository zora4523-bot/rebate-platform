import { afterEach, expect, it, vi } from 'vitest';
import { ports } from '../freeze-expiry/kit.ts';
import { healModule, type Control } from './kit.ts';

type Entry = 'worker' | 'api' | 'stream' | 'admin' | 'payout';
interface App {
  init(): Promise<void>;
  listen(): Promise<void>;
  close(): Promise<void>;
  get(token: unknown): unknown;
}

const originalExitCode = process.exitCode;
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

async function entryFixture() {
  const risk = await healModule();
  const p = await ports();
  const platform = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as {
    JOB_QUEUE: symbol;
    loadConfig(env: object): object;
    loadConnectionConfig(...args: unknown[]): object;
    loadMaintConnectionConfig(...args: unknown[]): unknown;
    createRootLogger(...args: unknown[]): unknown;
    createDbHandles(...args: unknown[]): unknown;
    startWorkerServices(parts: { queue: { start(): Promise<void> } }): Promise<{
      stop(): Promise<void>;
    }>;
  };
  const boot = (await import(
    new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href
  )) as {
    createHttpApp(...args: unknown[]): Promise<App>;
    createWorkerContext(...args: unknown[]): Promise<App>;
  };
  const runner = (await import(
    new URL('../../../../apps/api/src/entry.ts', import.meta.url).href
  )) as { runEntry(entry: Entry): Promise<void> };
  const config = platform.loadConfig({ APP_ENV: 'test' });
  vi.spyOn(platform, 'loadConfig').mockReturnValue(config);
  vi.spyOn(platform, 'loadConnectionConfig').mockReturnValue({ redisUrl: null });
  vi.spyOn(platform, 'loadMaintConnectionConfig').mockReturnValue(null);
  vi.spyOn(platform, 'createRootLogger').mockReturnValue(p.logger);
  vi.spyOn(platform, 'createDbHandles').mockReturnValue({
    db: null,
    dbRead: null,
    close: async () => undefined,
  });
  const order: string[] = [];
  const scan = {
    seed: vi.fn(async () => {
      order.push('seed');
    }),
    heal: vi.fn(async () => undefined),
  };
  const queue = {
    start: vi.fn(async () => {
      order.push('queue-start');
    }),
    stop: vi.fn(async () => undefined),
  };
  const app: App = {
    init: async () => undefined,
    listen: async () => undefined,
    close: async () => undefined,
    get: (token) => (token === platform.JOB_QUEUE ? queue : scan),
  };
  vi.spyOn(boot, 'createHttpApp').mockResolvedValue(app);
  vi.spyOn(boot, 'createWorkerContext').mockResolvedValue(app);
  const servicesStop = vi.fn(async () => {
    order.push('services-stop');
  });
  vi.spyOn(platform, 'startWorkerServices').mockImplementation(async (parts) => {
    await parts.queue.start();
    return { stop: servicesStop };
  });
  const healStop = vi.fn(() => {
    order.push('heal-stop');
  });
  const starts: { resolve: () => unknown; stopping: () => boolean }[] = [];
  const start = vi
    .spyOn(risk, 'startRiskScanHeal')
    .mockImplementation((resolve, _logger, stopping): Control => {
      order.push('heal-start');
      starts.push({ resolve, stopping });
      return { stop: healStop };
    });
  // Capture only this entry's signal handlers; never send a real process signal.
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
    runner,
    order,
    scan,
    servicesStop,
    healStop,
    starts,
    start,
    signal(signal: 'SIGTERM' | 'SIGINT') {
      expect(handlers.has(signal)).toBe(true);
      handlers.get(signal)!(signal);
    },
    async settleShutdown() {
      // Drains the real async close continuation without advancing the five-minute timer.
      await vi.advanceTimersByTimeAsync(0);
      expect(
        p.lines
          .map((line) => JSON.parse(line) as { msg: string })
          .some((line) => line.msg === 'stopped' || line.msg === 'shutdown_failed'),
      ).toBe(true);
    },
  };
}

it('[AC-B1-03u#11] 真实入口在 worker 队列启动及 seed 后接上补投，停止时清理；其他四入口不装', async () => {
  const f = await entryFixture();
  await f.runner.runEntry('worker');
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.order).toEqual(['queue-start', 'seed', 'heal-start']);
  expect(f.starts[0]!.resolve()).toBe(f.scan);
  expect(f.starts[0]!.stopping()).toBe(false);
  f.signal('SIGTERM');
  await f.settleShutdown();
  expect(f.starts[0]!.stopping()).toBe(true);
  expect(f.healStop).toHaveBeenCalledTimes(1);
  expect(f.servicesStop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    await f.runner.runEntry(entry);
    f.signal('SIGINT');
    await f.settleShutdown();
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.scan.seed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  }
}, 30_000);

it('[AC-B1-03u#12] services.stop 拒绝仍调用补投 stop 并清掉 keep-alive，不能留下定时器', async () => {
  const f = await entryFixture();
  f.servicesStop.mockRejectedValueOnce(new Error('fixture-stop-failed'));
  await f.runner.runEntry('worker');
  expect(f.start).toHaveBeenCalledTimes(1);
  f.signal('SIGINT');
  await f.settleShutdown();
  expect(f.healStop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(f.lines.map((line) => JSON.parse(line))).toContainEqual(
    expect.objectContaining({
      msg: 'shutdown_failed',
    }),
  );
}, 30_000);

it('[AC-B1-03u#13] seed 投递失败只 warn 后仍启动补投，初次断链无需等重启', async () => {
  const f = await entryFixture();
  f.scan.seed.mockRejectedValueOnce(new Error('fixture-seed-failed'));
  await f.runner.runEntry('worker');
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.lines.map((line) => JSON.parse(line))).toContainEqual(
    expect.objectContaining({
      level: 40,
      msg: 'risk_scan_seed_failed',
    }),
  );
  f.signal('SIGTERM');
  await f.settleShutdown();
  expect(f.healStop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
}, 30_000);
