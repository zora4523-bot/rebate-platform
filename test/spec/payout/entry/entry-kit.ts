// The payout entry (entry.ts runEntry('payout')) over a fake application context, as the order-sync
// entry tests do (test/spec/orders/wiring/entry-kit.ts): no database, no pg-boss, no port.
import { afterEach, expect, vi } from 'vitest';
import type { PayoutModeDecision } from '../../../../apps/api/src/modules/payout/payout-mode.ts';
import {
  payoutRuntimeToken,
  type PayoutStarted,
} from '../../../../apps/api/src/modules/payout/payout-runtime.ts';
import type { AppEnv } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { CREDENTIAL_NAMES, LIVE_CREDENTIALS } from './mode-kit.ts';

// Loaded by URL (as the other entry tests do): the entry, bootstrap and platform pull in the Nest
// controllers.
interface Platform {
  JOB_QUEUE: symbol;
  loadConfig(env: object): object;
  loadConnectionConfig(...args: unknown[]): object;
  loadMaintConnectionConfig(...args: unknown[]): unknown;
  createRootLogger(...args: unknown[]): unknown;
  createDbHandles(...args: unknown[]): unknown;
}
interface Boot {
  createWorkerContext(...args: unknown[]): Promise<unknown>;
}
const src = (path: string): string =>
  new URL(`../../../../apps/api/src/${path}`, import.meta.url).href;

async function modules() {
  return {
    platform: (await import(src('modules/platform/index.ts'))) as Platform,
    boot: (await import(src('bootstrap.ts'))) as Boot,
    entryModule: (await import(src('entry.ts'))) as {
      runEntry(entry: 'payout'): Promise<void>;
    },
    logging: (await import(src('modules/platform/logging/logger.ts'))) as {
      createRootLogger(options: object, destination: { write(line: string): void }): unknown;
    },
  };
}

const originalExitCode = process.exitCode;
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = originalExitCode;
});

/** What the fake context answers for payoutRuntimeToken(). */
export type RuntimeAnswer = 'runtime' | 'throw' | null | undefined | 'no-start' | 'queue';

export interface FixtureOptions {
  /** APP_ENV of the process (config.appEnv and process.env.APP_ENV). Default test. */
  readonly appEnv?: AppEnv;
  /** Variables set on process.env; PAYOUT_MODE and the ALIPAY_ credentials are unset otherwise. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly exitAfterInit?: boolean;
}

export async function fixture(options: FixtureOptions = {}) {
  // The token the entry resolves; the fake context answers it per state.runtime.
  const runtimeToken = payoutRuntimeToken();
  expect(typeof runtimeToken).toBe('symbol');
  const { platform, boot, entryModule, logging } = await modules();
  const appEnv = options.appEnv ?? 'test';
  vi.stubEnv('APP_ENV', appEnv);
  vi.stubEnv('COULI_EXIT_AFTER_INIT', undefined);
  for (const name of ['PAYOUT_MODE', ...CREDENTIAL_NAMES]) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(options.env ?? {})) vi.stubEnv(name, value);

  const lines: string[] = [];
  const logger = logging.createRootLogger(
    { level: 'trace', entry: 'payout', appEnv: 'test' },
    { write: (line) => void lines.push(line) },
  );
  const base = platform.loadConfig({
    APP_ENV: 'test',
    ...(options.exitAfterInit === true ? { COULI_EXIT_AFTER_INIT: '1' } : {}),
  });
  vi.spyOn(platform, 'loadConfig').mockReturnValue({ ...base, appEnv });
  vi.spyOn(platform, 'loadConnectionConfig').mockReturnValue({ redisUrl: null });
  vi.spyOn(platform, 'loadMaintConnectionConfig').mockReturnValue(null);
  vi.spyOn(platform, 'createRootLogger').mockReturnValue(logger);
  vi.spyOn(platform, 'createDbHandles').mockReturnValue({
    db: null,
    dbRead: null,
    close: async () => undefined,
  });

  const order: string[] = [];
  const msgs = (): string[] => lines.map((line) => (JSON.parse(line) as { msg: string }).msg);
  const start = vi.fn((decision: PayoutModeDecision): PayoutStarted => {
    order.push('payout-start');
    return { mode: decision.mode, channels: {} };
  });
  const state: { runtime: RuntimeAnswer; runtimeGets: number } = {
    runtime: 'runtime',
    runtimeGets: 0,
  };
  const queue = {
    start: vi.fn(async () => {
      order.push('queue-start');
    }),
    stop: vi.fn(async () => {
      order.push('queue-stop');
    }),
  };
  const counts = { created: 0, closed: 0 };
  const context = {
    close: vi.fn(async () => {
      counts.closed += 1;
    }),
    get: (token: unknown): unknown => {
      if (token === platform.JOB_QUEUE) return queue;
      if (token === runtimeToken) {
        state.runtimeGets += 1;
        switch (state.runtime) {
          case 'runtime':
            return { start };
          case 'throw':
            throw new Error('Nest could not find the payout runtime token');
          case 'queue':
            return queue;
          case 'no-start':
            return { runtime: {} };
          default:
            return state.runtime;
        }
      }
      throw new Error(`unexpected token ${String(token)}`);
    },
  };
  let duringCreate: (() => void) | null = null;
  vi.spyOn(boot, 'createWorkerContext').mockImplementation(async () => {
    counts.created += 1;
    duringCreate?.();
    return context;
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

  return {
    lines,
    msgs,
    order,
    start,
    queue,
    state,
    counts,
    run: () => entryModule.runEntry('payout'),
    signal(signal: 'SIGTERM' | 'SIGINT') {
      expect(handlers.has(signal)).toBe(true);
      handlers.get(signal)!(signal);
    },
    onCreate(fn: () => void) {
      duringCreate = fn;
    },
    async settleShutdown() {
      for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
      expect(msgs().some((m) => m === 'stopped' || m === 'shutdown_failed')).toBe(true);
    },
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Startup refused: logged, exit code 1, nothing registered or started, every context closed. */
export function expectRefused(f: Fixture): void {
  expect(process.exitCode).toBe(1);
  expect(f.msgs().some((m) => m === 'startup_failed' || m === 'config_invalid')).toBe(true);
  expect(f.msgs()).not.toContain('started');
  expect(f.start).not.toHaveBeenCalled();
  expect(f.queue.start).not.toHaveBeenCalled();
  expect(f.counts.closed).toBe(f.counts.created);
  expect(f.lines.join('\n')).not.toContain(LIVE_CREDENTIALS.privateKey);
  expect(vi.getTimerCount()).toBe(0);
}

/** Started and serving until SIGTERM; then the queue and the context stop and no timer is left. */
export async function expectServedThenStopped(f: Fixture): Promise<void> {
  expect(process.exitCode).not.toBe(1);
  expect(f.msgs()).toContain('started');
  expect(f.msgs()).not.toContain('startup_failed');
  expect(f.queue.start).toHaveBeenCalledTimes(1);
  f.signal('SIGTERM');
  await f.settleShutdown();
  expect(f.msgs()).toContain('stopped');
  expect(f.queue.stop).toHaveBeenCalledTimes(1);
  expect(f.counts.closed).toBe(f.counts.created);
  expect(vi.getTimerCount()).toBe(0);
}
