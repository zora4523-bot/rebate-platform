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

/** A pool of `size` permits (an integer ≥ 1). */
export function createPermits(size: number): Permits {
  void size;
  throw new Error('NotImplemented: createPermits');
}
