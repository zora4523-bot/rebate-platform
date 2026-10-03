// Shared helpers of the platform/http rule tests (规划/02 §1 原则 4, §6.2 治理层).
// Time is virtual: the ManualScheduler below is the only clock and the only source of waiting
// the code under test gets, so every test is deterministic and none waits in real time.
import {
  GovernanceError,
  type GovernanceErrorCode,
  type Governor,
  type CallOptions,
  type Scheduler,
} from '../../../../apps/api/src/modules/platform/http/index.ts';

/** Lets pending promise callbacks and I/O callbacks run (real macrotask turns). */
export async function flush(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

interface Timer {
  readonly at: number;
  readonly order: number;
  readonly resolve: () => void;
}

/** A Scheduler whose time only moves when the test calls `advance`. */
export class ManualScheduler implements Scheduler {
  private time = 0;
  private order = 0;
  private timers: Timer[] = [];

  now(): number {
    return this.time;
  }

  /** Waits that are neither finished nor cancelled. */
  get pending(): number {
    return this.timers.length;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      const timer: Timer = { at: this.time + ms, order: this.order, resolve };
      this.order += 1;
      this.timers.push(timer);
      signal?.addEventListener(
        'abort',
        () => {
          this.timers = this.timers.filter((other) => other !== timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  /** Moves time forward by `ms`, firing due waits in order and letting async code run. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      await flush();
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.time = due.at;
      due.resolve();
    }
    this.time = target;
    await flush();
  }
}

/** The state of a promise observed without awaiting it. */
export interface Observed<T> {
  settled: 'pending' | 'resolved' | 'rejected';
  value?: T;
  error?: unknown;
}

export function observe<T>(promise: Promise<T>): Observed<T> {
  const observed: Observed<T> = { settled: 'pending' };
  promise.then(
    (value) => {
      observed.settled = 'resolved';
      observed.value = value;
    },
    (error: unknown) => {
      observed.settled = 'rejected';
      observed.error = error;
    },
  );
  return observed;
}

/**
 * How a settled call ended, as a short string: `resolved`, the GovernanceError code, or
 * `error: <message>` for any other error. `pending` when it has not settled.
 */
export function ending(observed: Observed<unknown>): GovernanceErrorCode | string {
  if (observed.settled === 'pending') return 'pending';
  if (observed.settled === 'resolved') return 'resolved';
  const error = observed.error;
  if (error instanceof GovernanceError) return error.code;
  return `error: ${error instanceof Error ? error.message : String(error)}`;
}

/** The GovernanceError code a synchronous call throws, `returned`, or `error: <message>`. */
export function thrown(run: () => unknown): GovernanceErrorCode | string {
  try {
    run();
  } catch (error) {
    if (error instanceof GovernanceError) return error.code;
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  return 'returned';
}

/** An upstream stand-in that records when it is invoked and with which abort signal. */
export class Upstream {
  /** Scheduler time of every invocation. */
  readonly calledAt: number[] = [];
  readonly signals: AbortSignal[] = [];
  private readonly scheduler: ManualScheduler;

  constructor(scheduler: ManualScheduler) {
    this.scheduler = scheduler;
  }

  private record(signal: AbortSignal): number {
    this.calledAt.push(this.scheduler.now());
    this.signals.push(signal);
    return this.calledAt.length;
  }

  /** Answers at once with `value`. */
  ok<T>(value: T): (signal: AbortSignal) => Promise<T> {
    return (signal) => {
      this.record(signal);
      return Promise.resolve(value);
    };
  }

  /** Fails at once; the error message carries the attempt number. */
  down(): (signal: AbortSignal) => Promise<never> {
    return (signal) => {
      const attempt = this.record(signal);
      return Promise.reject(new Error(`upstream down #${String(attempt)}`));
    };
  }

  /** Fails the first `failures` invocations, then answers with `value`. */
  downThenOk<T>(failures: number, value: T): (signal: AbortSignal) => Promise<T> {
    return (signal) => {
      const attempt = this.record(signal);
      return attempt <= failures
        ? Promise.reject(new Error(`upstream down #${String(attempt)}`))
        : Promise.resolve(value);
    };
  }

  /** Never answers; settles only when the signal aborts (rejecting with its reason). */
  hang(): (signal: AbortSignal) => Promise<never> {
    return (signal) => {
      this.record(signal);
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason);
          },
          { once: true },
        );
      });
    };
  }

  /** Ignores the signal and answers with `value` after `ms` of scheduler time. */
  slow<T>(ms: number, value: T): (signal: AbortSignal) => Promise<T> {
    return (signal) => {
      this.record(signal);
      return this.scheduler.sleep(ms).then(() => value);
    };
  }
}

/** Runs `count` calls one after the other at the current time and returns how each ended. */
export async function runCalls(
  governor: Governor,
  count: number,
  operation: (signal: AbortSignal) => Promise<unknown>,
  options: CallOptions,
): Promise<string[]> {
  const endings: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const observed = observe(governor.call(operation, options));
    await flush();
    endings.push(ending(observed));
  }
  return endings;
}

/** `{ ending: count }` of a list of endings, for compact assertions. */
export function tally(endings: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of endings) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}
