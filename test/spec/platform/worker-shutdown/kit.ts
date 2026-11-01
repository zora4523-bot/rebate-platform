// B2-15q rule-test kit (claude-independent, D10-553; no BR refs). The four background timers of the
// worker entry (payment's bill.recon chain, ledger's daily check, payout's recon and overdue chains)
// and union's chain timer, as module.forWorker() assembles them: no production file is touched and
// nothing extra is exported. A timer is taken from the DynamicModule's providers by the description
// of its token (PAYMENT_RECON_TIMER, LEDGER_DAILY_CHECK_TIMER, PAYOUT_RECON_TIMER,
// PAYOUT_OVERDUE_TIMER, UNION_AUTH_TIMER) and built by the provider's own useFactory, so these tests
// pin the tokens and the factories' arguments, not the name of any function inside the modules.
//
// Real pieces: the timers, the seed and heal functions a tick runs, createDb (Kysely over the pool
// handed to it). Synthetic: the pool of `gatedDb` (no connection; its connect waits at a gate the
// test opens, so a tick is held in flight at its first statement whichever function it runs, and
// every statement answers no rows, so a tick sends nothing), the logger and the queue.
//
// This file is shared with the unit tests: it never imports @couli/db/testing or pg.
import { createDb, type DB } from '@couli/db';
import type { Kysely, PostgresPool } from 'kysely';
import { vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

const MODULES = '../../../../apps/api/src/modules/';

/** Real timers, taken before any fake timers are installed: every bound below runs on these. */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** Upper bound of a wait that must end at once on a correct implementation (real time). */
const SETTLE_BOUND_MS = 2_000;
/** Rounds of the real event loop that let a tick or a stop run as far as it can on its own. */
const DRAIN_ROUNDS = 10;

/** beforeAll of the unit tests: the modules' graph takes a while on a cold transform cache. */
export const LOAD_TIMEOUT_MS = 60_000;

export const TIMERS = [
  'payment-recon',
  'ledger-daily-check',
  'payout-recon',
  'payout-overdue',
] as const;
export type TimerName = (typeof TIMERS)[number];

/** The hooks Nest calls; the result of a stop is awaited by Nest, whatever its type. */
export interface Lifecycle {
  onApplicationBootstrap(): void;
  onModuleDestroy(): unknown;
}

export interface TickDeps {
  readonly db: Kysely<DB>;
  readonly clock: FixedClock;
  readonly queue: unknown;
  readonly logger: RecordingLogger;
}

export interface Target {
  /** Delay of the first tick after bootstrap, from the module. */
  readonly seedDelayMs: number;
  /** Interval between two ticks, from the module. */
  readonly healIntervalMs: number;
  /** The warn line of a failed tick (it exists before this task). */
  readonly failureLine: string;
  build(deps: TickDeps): Lifecycle;
}

export interface UnionMonitor {
  seed(): Promise<void>;
  heal(): Promise<void>;
}

export interface UnionTarget {
  readonly seedDelayMs: number;
  readonly healIntervalMs: number;
  build(monitor: UnionMonitor, logger: RecordingLogger): Lifecycle;
}

interface ModuleProvider {
  readonly provide?: unknown;
  readonly useFactory?: (...args: unknown[]) => Lifecycle;
}

interface WorkerModule {
  readonly providers?: readonly ModuleProvider[];
}

interface WorkerBuilder {
  forWorker(options: unknown): WorkerModule;
}

type Loaded = Record<string, unknown>;

/** URL imports keep the controllers' parameter decorators out of test's erasable TS project. */
async function moduleAt(path: string): Promise<Loaded> {
  return (await import(new URL(`${MODULES}${path}`, import.meta.url).href)) as Loaded;
}

function numberIn(loaded: Loaded, name: string): number {
  const value = loaded[name];
  if (typeof value !== 'number') throw new Error(`fixture: ${name} is not exported`);
  return value;
}

function workerIn(loaded: Loaded, name: string, options: unknown): WorkerModule {
  const builder = loaded[name] as WorkerBuilder | undefined;
  if (builder === undefined) throw new Error(`fixture: ${name} is not exported`);
  return builder.forWorker(options);
}

function factoryIn(
  module: WorkerModule,
  description: string,
): NonNullable<ModuleProvider['useFactory']> {
  const provider = (module.providers ?? []).find(
    (candidate) =>
      typeof candidate.provide === 'symbol' && candidate.provide.description === description,
  );
  if (provider?.useFactory === undefined) throw new Error(`fixture: no provider ${description}`);
  return provider.useFactory;
}

/** ledger's run store; the gated database has no app, so a tick never reaches it. */
const NO_RUNS = {
  stateOf: () => Promise.reject(new Error('fixture: no app has a run')),
  claimOverdueAlert: () => Promise.reject(new Error('fixture: no app has a run')),
};

/** The four timers, each `build` a fresh one. */
export async function loadTargets(): Promise<Record<TimerName, Target>> {
  const payment = await moduleAt('payment/payment.module.ts');
  const ledger = await moduleAt('ledger/daily-check.module.ts');
  const payout = await moduleAt('payout/payout.module.ts');
  const paymentTimer = factoryIn(
    workerIn(payment, 'PaymentModule', { config: () => undefined }),
    'PAYMENT_RECON_TIMER',
  );
  const ledgerTimer = factoryIn(
    workerIn(ledger, 'LedgerDailyCheckModule', {}),
    'LEDGER_DAILY_CHECK_TIMER',
  );
  const payoutWorker = workerIn(payout, 'PayoutModule', {});
  const payoutReconTimer = factoryIn(payoutWorker, 'PAYOUT_RECON_TIMER');
  const payoutOverdueTimer = factoryIn(payoutWorker, 'PAYOUT_OVERDUE_TIMER');
  return {
    'payment-recon': {
      seedDelayMs: numberIn(payment, 'RECON_SEED_DELAY_MS'),
      healIntervalMs: numberIn(payment, 'RECON_HEAL_INTERVAL_MS'),
      failureLine: 'pay_bill_recon_heal_failed',
      build: ({ db, clock, queue, logger }) =>
        paymentTimer({ queue: 'pay' }, clock, logger, db, queue),
    },
    'ledger-daily-check': {
      seedDelayMs: numberIn(ledger, 'LEDGER_DAILY_CHECK_SEED_DELAY_MS'),
      healIntervalMs: numberIn(ledger, 'LEDGER_DAILY_CHECK_HEAL_INTERVAL_MS'),
      failureLine: 'ledger_daily_check_heal_failed',
      build: ({ db, clock, queue, logger }) =>
        ledgerTimer({ db, clock, queue, logger, runs: NO_RUNS }),
    },
    'payout-recon': {
      seedDelayMs: numberIn(payout, 'PAYOUT_RECON_SEED_DELAY_MS'),
      healIntervalMs: numberIn(payout, 'PAYOUT_RECON_HEAL_INTERVAL_MS'),
      failureLine: 'payout_recon_heal_failed',
      build: ({ db, clock, queue, logger }) => payoutReconTimer(true, clock, logger, db, queue),
    },
    'payout-overdue': {
      seedDelayMs: numberIn(payout, 'PAYOUT_OVERDUE_SEED_DELAY_MS'),
      healIntervalMs: numberIn(payout, 'PAYOUT_OVERDUE_HEAL_INTERVAL_MS'),
      failureLine: 'payout_overdue_heal_failed',
      build: ({ db, clock, queue, logger }) => payoutOverdueTimer(true, clock, logger, db, queue),
    },
  };
}

export async function loadUnionTarget(): Promise<UnionTarget> {
  const union = await moduleAt('union/auth-expiry/union-auth.module.ts');
  const timer = factoryIn(workerIn(union, 'UnionAuthModule', {}), 'UNION_AUTH_TIMER');
  return {
    seedDelayMs: numberIn(union, 'SEED_DELAY_MS'),
    healIntervalMs: numberIn(union, 'HEAL_INTERVAL_MS'),
    build: (monitor, logger) => timer(monitor, logger),
  };
}

/** Fake timers for the modules' timers only; promises, setImmediate and PostgreSQL I/O stay real. */
export function fakeModuleTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
}

/** Lets everything that can run without a timer or an opened gate run. */
export async function drain(): Promise<void> {
  for (let round = 0; round < DRAIN_ROUNDS; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export type WaitOutcome = 'done' | 'rejected' | 'timeout';

/** How `promise` went within `ms` of real time; never rejects and never outlives the bound. */
export async function within(promise: Promise<unknown>, ms: number): Promise<WaitOutcome> {
  let cancel = (): void => undefined;
  const limit = new Promise<WaitOutcome>((resolve) => {
    const bound = realSetTimeout(() => {
      resolve('timeout');
    }, ms);
    cancel = () => {
      realClearTimeout(bound);
    };
  });
  const settled = promise.then(
    (): WaitOutcome => 'done',
    (): WaitOutcome => 'rejected',
  );
  try {
    return await Promise.race([settled, limit]);
  } finally {
    cancel();
  }
}

export function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = () => {
      done();
    };
  });
  return { promise, resolve };
}

export type StopOutcome = 'pending' | 'returned' | 'rejected';

export interface Stopping {
  /** Where the stop is right now. */
  outcome(): StopOutcome;
  /** Where it is after a bounded wait; 'pending' when it did not end in time. */
  settled(): Promise<StopOutcome>;
}

/**
 * Calls the stop hook at once and watches it; `log` gets `stop_returned` or `stop_rejected` when it
 * ends, so a test can read the order against what it logged itself.
 */
export function stopping(timer: Lifecycle, log: string[] = []): Stopping {
  let outcome: StopOutcome = 'pending';
  const done = Promise.resolve(timer.onModuleDestroy()).then(
    () => {
      outcome = 'returned';
      log.push('stop_returned');
    },
    () => {
      outcome = 'rejected';
      log.push('stop_rejected');
    },
  );
  return {
    outcome: () => outcome,
    async settled() {
      await within(done, SETTLE_BOUND_MS);
      return outcome;
    },
  };
}

export interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

export interface RecordingLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
  child(): RecordingLogger;
}

export function recordingLogger(): {
  readonly logger: RecordingLogger;
  warnings(): LogLine[];
} {
  const lines: LogLine[] = [];
  const write =
    (level: LogLine['level']) =>
    (fields: Record<string, unknown>, message: string): void => {
      lines.push({ level, fields, message });
    };
  const logger: RecordingLogger = {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: () => logger,
  };
  return { logger, warnings: () => lines.filter((line) => line.level === 'warn') };
}

export function fixedClock(): FixedClock {
  return new FixedClock('2026-10-22T02:00:00.000Z');
}

/** A queue no tick reaches: the databases of these tests have no app to send for. */
export function idleQueue(): unknown {
  return {
    send: () => Promise.reject(new Error('fixture: nothing to send')),
    register: () => undefined,
  };
}

export interface GatedDb {
  readonly db: Kysely<DB>;
  /** Connections asked for so far: one per statement of a tick. */
  connects(): number;
  /** Connections asked for and not answered yet. */
  waiting(): number;
  /** Answers the waiting connects, and every later one, with an empty result. */
  open(): void;
  /** Rejects the waiting connects, and every later one, with `error`. */
  fail(error: Error): void;
}

/** createDb over a pool without connections whose connect waits at a gate (see the header). */
export function gatedDb(): GatedDb {
  const gate = deferred();
  let connects = 0;
  let waiting = 0;
  let failure: Error | null = null;
  const client = {
    query: async () => ({ command: 'SELECT', rowCount: 0, rows: [] }),
    release: () => undefined,
  };
  const pool = {
    options: {},
    connect: async () => {
      connects += 1;
      waiting += 1;
      await gate.promise;
      waiting -= 1;
      if (failure !== null) throw failure;
      return client;
    },
    end: async () => undefined,
  };
  return {
    db: createDb({ poolFactory: () => pool as unknown as PostgresPool }),
    connects: () => connects,
    waiting: () => waiting,
    open: () => {
      gate.resolve();
    },
    fail: (error) => {
      failure = error;
      gate.resolve();
    },
  };
}

export interface Rig {
  readonly timer: Lifecycle;
  readonly pool: GatedDb;
  warnings(): LogLine[];
}

/** A fresh timer over its own gated database and logger. */
export function rigOf(target: Target): Rig {
  const pool = gatedDb();
  const { logger, warnings } = recordingLogger();
  const timer = target.build({
    db: pool.db,
    clock: fixedClock(),
    queue: idleQueue(),
    logger,
  });
  return { timer, pool, warnings };
}

/** The named error of a failed tick; its name is what the warn line may carry. */
export function syntheticError(name: string): Error {
  return Object.assign(new Error('synthetic failure'), { name });
}
