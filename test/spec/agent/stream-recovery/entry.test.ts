// B3-03h 第 9 节 7：worker 入口接上 sweeper 循环（照 test/spec/risk/freeze-expiry-heal/entry.test.ts：stub
// bootstrap.createWorkerContext 与 startWorkerServices，不起真进程、不发真信号）。worker 在 startWorkerServices
// 解决之后、`started` 之前起循环（context.get(agentSweeperToken(), {strict: false}) 的 start()，不带测试缝）；
// 停机先 stop 循环再 services.stop；COULI_EXIT_AFTER_INIT=1、启动期间已收到信号、上下文里没有可用的运行体（get
// 抛错、null、undefined、没有 start）时不起也不崩；api / stream / admin / payout 不起。
import { afterEach, expect, it, vi } from 'vitest';

import { agentSweeperToken } from '../../../../apps/api/src/modules/agent/index.ts';
import { ports } from '../../risk/freeze-expiry/kit.ts';

type Entry = 'worker' | 'api' | 'stream' | 'admin' | 'payout';

// Loaded by URL (as the B1-03u entry test does): the entry, bootstrap and platform pull in the
// Nest controllers, which the `test` project does not compile.
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
interface Boot {
  createHttpApp(...args: unknown[]): Promise<unknown>;
  createWorkerContext(...args: unknown[]): Promise<unknown>;
}
const src = (path: string): string =>
  new URL(`../../../../apps/api/src/${path}`, import.meta.url).href;
async function modules() {
  return {
    platform: (await import(src('modules/platform/index.ts'))) as Platform,
    boot: (await import(src('bootstrap.ts'))) as Boot,
    entryModule: (await import(src('entry.ts'))) as { runEntry(entry: Entry): Promise<void> },
    risk: (await import(src('modules/risk/index.ts'))) as { riskScanToken(): symbol },
  };
}

const originalExitCode = process.exitCode;
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

type AgentAnswer = 'runtime' | 'throw' | null | undefined | 'no-start';

async function fixture(env: Record<string, string> = {}) {
  const { platform, boot, entryModule, risk } = await modules();
  const riskScanToken = risk.riskScanToken;
  // The token the worker resolves; the fake context answers it per state.agent.
  const agentToken = agentSweeperToken();
  expect(typeof agentToken).toBe('symbol');
  const p = await ports();
  const config = platform.loadConfig({ APP_ENV: 'test', ...env });
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
  const msgs = (): string[] => p.lines.map((line) => (JSON.parse(line) as { msg: string }).msg);
  // loop.stop() resolves at once unless the test holds it (holdLoopStop): then it settles only
  // when the test says so, as a loop waiting for its running tick does.
  let loopStopGate: Promise<void> | null = null;
  const loopStop = vi.fn(async () => {
    order.push('sweep-stop-called');
    if (loopStopGate !== null) await loopStopGate;
    order.push('sweep-stopped');
  });
  const start = vi.fn((...args: unknown[]) => {
    void args;
    order.push(msgs().includes('started') ? 'sweep-start-after-started' : 'sweep-start');
    return { stop: loopStop };
  });
  const state: { agent: AgentAnswer; agentGets: number } = { agent: 'runtime', agentGets: 0 };
  const queue = {
    start: vi.fn(async () => {
      order.push('queue-start');
    }),
    stop: vi.fn(async () => undefined),
  };
  const context = {
    init: async () => undefined,
    listen: async () => undefined,
    close: async () => undefined,
    get: (token: unknown): unknown => {
      if (token === platform.JOB_QUEUE) return queue;
      if (token === riskScanToken()) return null;
      if (token === agentToken) {
        state.agentGets += 1;
        switch (state.agent) {
          case 'runtime':
            return { start };
          case 'throw':
            throw new Error('Nest could not find the agent sweeper token');
          case 'no-start':
            return { sweeper: {} };
          default:
            return state.agent;
        }
      }
      throw new Error(`unexpected token ${String(token)}`);
    },
  };
  vi.spyOn(boot, 'createHttpApp').mockResolvedValue(context);
  vi.spyOn(boot, 'createWorkerContext').mockResolvedValue(context);
  const servicesStop = vi.fn(async () => {
    order.push('services-stop');
  });
  let duringStart: (() => void) | null = null;
  vi.spyOn(platform, 'startWorkerServices').mockImplementation(async (parts) => {
    await parts.queue.start();
    duringStart?.();
    return { stop: servicesStop };
  });
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const originalOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((
    event: string,
    listener: (...a: unknown[]) => void,
  ) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      handlers.set(event, listener);
      return process;
    }
    return originalOn(event as never, listener as never);
  }) as never);
  vi.useFakeTimers();
  const f = {
    ...p,
    order,
    msgs,
    start,
    loopStop,
    servicesStop,
    state,
    run: (entry: Entry) => entryModule.runEntry(entry),
    signal(signal: 'SIGTERM' | 'SIGINT') {
      expect(handlers.has(signal)).toBe(true);
      handlers.get(signal)!(signal);
    },
    onStart(fn: () => void) {
      duringStart = fn;
    },
    holdLoopStop(): { release(): void; fail(error: Error): void } {
      let release!: () => void;
      let fail!: (error: Error) => void;
      loopStopGate = new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
      return { release: () => release(), fail: (error) => fail(error) };
    },
    /** Drains pending continuations without advancing time (fake timers). */
    async drain() {
      for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
    },
    async settleShutdown() {
      await vi.advanceTimersByTimeAsync(0);
      expect(msgs().some((m) => m === 'stopped' || m === 'shutdown_failed')).toBe(true);
    },
  };
  return f;
}

it('[AC-B3-03h#20] worker 入口：startWorkerServices 解决之后、started 之前起一次循环（不带测试缝）；SIGTERM 时先等循环 stop 完成（它 resolve 之前 services.stop 不被调用），之后才 services.stop，不留定时器', async () => {
  const f = await fixture();
  await f.run('worker');
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.start.mock.calls[0]).toEqual([]);
  expect(f.order).toEqual(['queue-start', 'sweep-start']);
  expect(f.msgs()).toContain('started');
  const held = f.holdLoopStop();
  f.signal('SIGTERM');
  await f.drain();
  expect(f.loopStop).toHaveBeenCalledTimes(1);
  expect(f.servicesStop, 'services.stop waits for loop.stop').not.toHaveBeenCalled();
  expect(f.msgs()).not.toContain('stopped');
  held.release();
  await f.settleShutdown();
  expect(f.servicesStop).toHaveBeenCalledTimes(1);
  expect(f.order).toEqual([
    'queue-start',
    'sweep-start',
    'sweep-stop-called',
    'sweep-stopped',
    'services-stop',
  ]);
  expect(f.msgs()).toContain('stopped');
  expect(vi.getTimerCount()).toBe(0);
}, 30_000);

it('[AC-B3-03h#21] api / stream / admin / payout 入口不起循环', async () => {
  const f = await fixture();
  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    await f.run(entry);
    f.signal('SIGINT');
    await f.settleShutdown();
    expect(f.start, entry).not.toHaveBeenCalled();
    expect(vi.getTimerCount(), entry).toBe(0);
  }
}, 30_000);

it('[AC-B3-03h#22] COULI_EXIT_AFTER_INIT=1：worker 初始化后退出，不起循环', async () => {
  const f = await fixture({ COULI_EXIT_AFTER_INIT: '1' });
  await f.run('worker');
  expect(f.msgs()).toContain('started');
  expect(f.start).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
}, 30_000);

it('[AC-B3-03h#23] 启动期间已收到停止信号：服务直接停下，不起循环', async () => {
  const f = await fixture();
  f.onStart(() => f.signal('SIGTERM'));
  await f.run('worker');
  await f.settleShutdown();
  expect(f.start).not.toHaveBeenCalled();
  expect(f.servicesStop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
}, 30_000);

it('[AC-B3-03h#24] 上下文里没有可用的循环运行体（get 抛错、null、undefined、没有 start）：worker 照常 started 与停机，不起、不崩', async () => {
  for (const answer of ['throw', null, undefined, 'no-start'] as const) {
    const f = await fixture();
    f.state.agent = answer;
    await f.run('worker');
    expect(f.msgs(), String(answer)).toContain('started');
    expect(f.msgs(), String(answer)).not.toContain('startup_failed');
    expect(f.start, String(answer)).not.toHaveBeenCalled();
    f.signal('SIGTERM');
    await f.settleShutdown();
    expect(f.servicesStop, String(answer)).toHaveBeenCalledTimes(1);
    expect(f.msgs(), String(answer)).toContain('stopped');
    expect(vi.getTimerCount(), String(answer)).toBe(0);
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
}, 30_000);

it('[AC-B3-03h#25] 循环 stop 拒绝时 services.stop 仍被调用（在拒绝之后，不在之前）、keep-alive 清掉，不留定时器', async () => {
  const f = await fixture();
  await f.run('worker');
  expect(f.start).toHaveBeenCalledTimes(1);
  const held = f.holdLoopStop();
  f.signal('SIGTERM');
  await f.drain();
  expect(f.loopStop).toHaveBeenCalledTimes(1);
  expect(f.servicesStop).not.toHaveBeenCalled();
  held.fail(new Error('fixture-loop-stop-failed'));
  await f.settleShutdown();
  expect(f.servicesStop).toHaveBeenCalledTimes(1);
  expect(f.order).toEqual(['queue-start', 'sweep-start', 'sweep-stop-called', 'services-stop']);
  expect(vi.getTimerCount()).toBe(0);
}, 30_000);

it('[AC-B3-03h#34] 循环 stop 立即拒绝（同步就失败的停止）：services.stop 仍被调用，不留定时器', async () => {
  const f = await fixture();
  f.loopStop.mockRejectedValueOnce(new Error('fixture-loop-stop-failed'));
  await f.run('worker');
  expect(f.start).toHaveBeenCalledTimes(1);
  f.signal('SIGTERM');
  await f.settleShutdown();
  expect(f.loopStop).toHaveBeenCalledTimes(1);
  expect(f.servicesStop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
}, 30_000);
