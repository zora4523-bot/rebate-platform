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

export function createBoundedQueue(options: BoundedQueueOptions): BoundedQueue {
  void options;
  throw new Error('NotImplemented: createBoundedQueue');
}

/** One process-wide bind admission queue: 4 running, 16 waiting, 2000 ms wait. */
export function getBindingAdmission(): BoundedQueue {
  throw new Error('NotImplemented: getBindingAdmission');
}
