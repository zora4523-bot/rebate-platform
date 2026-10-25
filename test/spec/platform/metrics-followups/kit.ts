// B1-01zzo rule-test kit (orchestrator brief B.1–B.3; B1-01zzi / B1-01zzh followups). The TTL and
// the snapshots are written out here, independent of the code under test. Fund metric names, the
// fund port tables and the Prometheus text reader come from B1-01zzi's and B1-01zzh's kits (read
// only, not changed).
import type {
  FundMetricsSnapshot,
  WorkerMetricsSnapshot,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';

/** The injected clock's instant. */
export const NOW = '2031-04-05T06:07:08.000Z';
export const NOW_MS = Date.parse(NOW);

/** Brief B.1: the default TTL, 5 minutes (规划/02 §13 common granularity). */
export const TTL_MS = 300_000;

export const WORKER: WorkerMetricsSnapshot = {
  queueFailed: { notify: 2, settle: 0 },
  deadLetters: { 'notify.dead': 1 },
  backlog: { notify: 7 },
  oldestDueEvtAgeSeconds: { 'evt.payout-went-negative': 125 },
  syncWatermarkLagSeconds: { taobao: 4000 },
};

export const FIRST: FundMetricsSnapshot = {
  orderSyncPendingOpen: { UNMAPPED_STATUS: 3, ILLEGAL_TRANSITION: 1 },
  billJobsFailed: 2,
  partialBatches: 1,
  beneficiariesHeldOver30Days: 4,
  payingNeedsManual: 5,
};

export const SECOND: FundMetricsSnapshot = {
  orderSyncPendingOpen: { UNMAPPED_STATUS: 1, NO_RECEIVED_AT: 2 },
  billJobsFailed: 0,
  partialBatches: 3,
  beneficiariesHeldOver30Days: 0,
  payingNeedsManual: 1,
};

/** A fresh snapshot object for call number `n`; values differ per n. */
export function snapshotNo(n: number): FundMetricsSnapshot {
  return {
    orderSyncPendingOpen: { UNMAPPED_STATUS: n },
    billJobsFailed: n,
    partialBatches: n + 1,
    beneficiariesHeldOver30Days: n + 2,
    payingNeedsManual: n + 3,
  };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** A promise settled by hand, to hold a collection in flight. */
export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export type Settled<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** The outcome of a promise as a value (handlers attached at once, so no unhandled rejection). */
export function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, error }),
  );
}
