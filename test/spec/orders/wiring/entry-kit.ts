import { afterEach, expect, vi } from 'vitest';

import { agentSweeperToken } from '../../../../apps/api/src/modules/agent/index.ts';
import { token } from './context-kit.ts';
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
    risk: (await import(src('modules/risk/index.ts'))) as {
      riskScanToken(): symbol;
      seedRiskScan: typeof import('../../../../apps/api/src/modules/risk/application/risk-scan.ts').seedRiskScan;
      startRiskScanHeal: typeof import('../../../../apps/api/src/modules/risk/application/risk-scan-heal.ts').startRiskScanHeal;
    },
  };
}

const originalExitCode = process.exitCode;
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

type AgentAnswer = 'runtime' | 'throw' | null | undefined | 'no-start' | 'queue' | 'start-throws';

export async function fixture(env: Record<string, string> = {}) {
  const { platform, boot, entryModule, risk } = await modules();
  const riskScanToken = risk.riskScanToken;
  // The token the worker resolves; the fake context answers it per state.agent.
  const agentToken = await token();
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
  const seed = risk.seedRiskScan;
  vi.spyOn(risk, 'seedRiskScan').mockImplementation(async (...args) => {
    order.push('seed');
    await seed(...args);
  });
  const startHeal = risk.startRiskScanHeal;
  vi.spyOn(risk, 'startRiskScanHeal').mockImplementation((...args) => {
    const handle = startHeal(...args);
    order.push('heal-start');
    return {
      stop() {
        order.push('heal-stop');
        handle.stop();
      },
    };
  });
  let duringAgentStart: (() => void) | undefined;
  const msgs = (): string[] => p.lines.map((line) => (JSON.parse(line) as { msg: string }).msg);
  // loop.stop() resolves at once unless the test holds it (holdLoopStop): then it settles only
  // when the test says so, as a loop waiting for its running tick does.
  let loopStopGate: Promise<void> | null = null;
  const loopStop = vi.fn(async () => {
    order.push('sync-stop-called');
    if (loopStopGate !== null) await loopStopGate;
    order.push('sync-stopped');
  });
  const start = vi.fn((...args: unknown[]) => {
    void args;
    order.push(msgs().includes('started') ? 'sync-start-after-started' : 'sync-start');
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
      if (token === agentSweeperToken())
        return {
          start: () => {
            order.push('agent-start');
            duringAgentStart?.();
            return {
              stop: async () => {
                order.push('agent-stop');
              },
            };
          },
        };
      if (token === agentToken) {
        state.agentGets += 1;
        switch (state.agent) {
          case 'runtime':
            return { start };
          case 'throw':
            throw new Error('Nest could not find the agent sweeper token');
          case 'queue':
            return queue;
          case 'start-throws':
            return {
              start: () => {
                throw new Error('synthetic start failure');
              },
            };
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
    onAgentStart(fn: () => void) {
      duringAgentStart = fn;
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
