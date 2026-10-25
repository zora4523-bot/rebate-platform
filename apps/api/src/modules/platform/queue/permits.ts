// Shared permit pool of the worker's business lanes (B1-01zzk; contract section 12 of ./index.ts).

/** A counting semaphore: at most `size` permits held at once, waiters served first come first. */
export interface Permits {
  readonly size: number;
  /** Permits currently held. */
  held(): number;
  /** Callers waiting in acquire. */
  waiting(): number;
  /**
   * Resolves true holding one permit: at once when one is free and nobody waits, else when a
   * release hands one over (longest waiter first). Resolves false holding nothing when `signal`
   * is aborted before (also when already aborted at the call).
   */
  acquire(signal: AbortSignal): Promise<boolean>;
  /** Returns one held permit; the longest waiter gets it. */
  release(): void;
}

interface Waiter {
  readonly grant: () => void;
}

/** A pool of `size` permits (an integer ≥ 1). */
export function createPermits(size: number): Permits {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('permits: size must be ≥ 1');
  let held = 0;
  // Insertion order is arrival order; an aborted waiter deletes itself.
  const waiters = new Set<Waiter>();
  return {
    size,
    held: () => held,
    waiting: () => waiters.size,
    acquire(signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return Promise.resolve(false);
      if (held < size && waiters.size === 0) {
        held += 1;
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        const abort = () => {
          waiters.delete(waiter);
          resolve(false);
        };
        const waiter: Waiter = {
          // The permit passes straight from the releaser to this waiter: `held` stays counted.
          grant: () => {
            signal.removeEventListener('abort', abort);
            resolve(true);
          },
        };
        waiters.add(waiter);
        signal.addEventListener('abort', abort, { once: true });
      });
    },
    release(): void {
      if (held === 0) return;
      const next = waiters.values().next();
      if (next.done === true) {
        held -= 1;
        return;
      }
      waiters.delete(next.value);
      next.value.grant();
    },
  };
}
