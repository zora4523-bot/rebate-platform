// B1-06za: in-process admission limits of linking's upstream calls (规划/02 §6.2 联盟治理,
// §18 并发固定做法; orchestrator ruling D9-4). The union governance layer already bounds each
// call (online timeout, idempotent read retries, breaker, quota); what it cannot bound is how many
// callers of this process wait on it at once while holding a pooled connection.
// - createBoundedQueue: a FIFO admission queue — `concurrency` callbacks run at once, up to
//   `queueCapacity` wait for a slot, each waiting at most `waitMs` (one setTimeout per waiter,
//   cleared on admission). A full queue answers {kind:'full'} at once; an expired wait answers
//   {kind:'timeout'} and its callback never starts. A finished callback (resolved, rejected or
//   thrown synchronously) hands its slot straight to the queue head, so no later arrival jumps it.
// - getBindingAdmission: the one queue of this process for union binding submissions (4 running,
//   16 waiting, 2000 ms) — the bindings use case refuses with 42901 + Retry-After before the
//   idempotent transaction opens, so a refusal consumes no state (BR-ID-17) and stores no record.
// A waiter's callback runs in the async context of its own request (AsyncResource.bind at enqueue),
// never in the context of the request whose release admitted it: the request-scoped stores (the
// idempotency entry observer, post-miss hooks) must see the waiter's own request.
// Limits are module constants (no config item, as BIND_CONCURRENCY before them).
import { AsyncResource } from 'node:async_hooks';

export type AdmissionResult<T> =
  { readonly kind: 'completed'; readonly value: T } | { readonly kind: 'full' | 'timeout' };

export interface BoundedQueue {
  readonly concurrency: number;
  readonly queueCapacity: number;
  readonly waitMs: number;
  readonly running: number;
  readonly waiting: number;
  /** Admission/enqueue happens synchronously; rejected callbacks are never invoked. */
  run<T>(work: () => Promise<T>): Promise<AdmissionResult<T>>;
}

export interface BoundedQueueOptions {
  readonly concurrency: number;
  readonly queueCapacity: number;
  readonly waitMs: number;
}

interface Waiter {
  readonly admit: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function positiveInteger(name: string, value: number, min: number): number {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`linking: bounded queue ${name} must be an integer ≥ ${min}`);
  }
  return value;
}

export function createBoundedQueue(options: BoundedQueueOptions): BoundedQueue {
  const concurrency = positiveInteger('concurrency', options.concurrency, 1);
  const queueCapacity = positiveInteger('queueCapacity', options.queueCapacity, 0);
  const waitMs = positiveInteger('waitMs', options.waitMs, 1);
  let running = 0;
  const waiters: Waiter[] = [];

  function release(): void {
    // The slot passes straight to the head; the count drops only when nobody waits.
    const next = waiters.shift();
    if (next === undefined) {
      running -= 1;
      return;
    }
    clearTimeout(next.timer);
    next.admit();
  }

  async function execute<T>(work: () => Promise<T>): Promise<AdmissionResult<T>> {
    try {
      return { kind: 'completed', value: await work() };
    } finally {
      release();
    }
  }

  return {
    concurrency,
    queueCapacity,
    waitMs,
    get running() {
      return running;
    },
    get waiting() {
      return waiters.length;
    },
    run<T>(work: () => Promise<T>): Promise<AdmissionResult<T>> {
      if (running < concurrency && waiters.length === 0) {
        running += 1;
        return execute(work);
      }
      if (waiters.length >= queueCapacity) return Promise.resolve({ kind: 'full' });
      return new Promise<AdmissionResult<T>>((resolve, reject) => {
        const waiter: Waiter = {
          admit: AsyncResource.bind(() => {
            execute(work).then(resolve, reject);
          }),
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index === -1) return;
            waiters.splice(index, 1);
            resolve({ kind: 'timeout' });
          }, waitMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

/** Binding submissions holding their transaction's connection at once (api pool: 10). */
export const BIND_CONCURRENCY = 4;
/** Binding submissions waiting for a slot, without a connection. */
export const BIND_QUEUE_CAPACITY = 16;
/** Longest wait for a slot before the submission is refused (42901). */
export const BIND_WAIT_MS = 2000;

let bindingAdmission: BoundedQueue | undefined;

/** One process-wide bind admission queue: 4 running, 16 waiting, 2000 ms wait. */
export function getBindingAdmission(): BoundedQueue {
  bindingAdmission ??= createBoundedQueue({
    concurrency: BIND_CONCURRENCY,
    queueCapacity: BIND_QUEUE_CAPACITY,
    waitMs: BIND_WAIT_MS,
  });
  return bindingAdmission;
}

/** Retry-After (whole seconds, ≥ 1) of a refused binding submission: one full wait. */
export const BIND_RETRY_AFTER_SEC = Math.max(1, Math.ceil(BIND_WAIT_MS / 1000));
