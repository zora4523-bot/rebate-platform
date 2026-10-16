// B1-17b rule-test helpers (BR-WATCH-05 (2), BR-WATCH-19 (1)). Everything under test comes from
// the public catalog/index.ts; expectations in the tests are literals or derived by the tests
// themselves, never read from the implementation.
import { vi } from 'vitest';
import type {
  PriceObservation,
  PriceSnapshotRecorderOptions,
  PriceSnapshotSourceKind,
  PriceSnapshotStore,
  PriceSnapshotValues,
  PriceSnapshotWrite,
  PriceSnapshotWriteOutcome,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

/** The configuration key of the touch interval (08 09_WATCH parameter table). */
export const INTERVAL_KEY = 'price_snapshot.touch_min_interval_minutes';

export const MINUTE = 60_000;

/** An instant in Beijing time of the example day, e.g. at('08:00'). */
export function at(hhmm: string, day = '2031-03-10'): Date {
  return new Date(`${day}T${hhmm}:00.000+08:00`);
}

/** Valid run values: price, no coupon, final = price (BR-PRICE-01 passes). */
export function vals(
  fen: bigint,
  overrides: Partial<PriceSnapshotValues> = {},
): PriceSnapshotValues {
  return { priceFen: fen, couponFen: 0n, finalPriceFen: fen, inStock: true, ...overrides };
}

/** A writable observation (fresh, no user-level parameter, valid prices, taobao detail). */
export function observation(overrides: Partial<PriceObservation> = {}): PriceObservation {
  return {
    appId: 'ph-app',
    platform: 'taobao',
    productKey: 'tb:123',
    skuKey: null,
    sourceKind: 'detail',
    outcome: 'ok',
    priceFen: 4500n,
    couponFen: 0n,
    finalPriceFen: 4500n,
    priceStatus: 'ok',
    inStock: true,
    fresh: true,
    userScoped: false,
    goodsSignPlan: null,
    ...overrides,
  };
}

/** A store write (the input of PriceSnapshotStore.write). */
export function storeWrite(
  key: { appId: string; productKey: string; sourceKind?: PriceSnapshotSourceKind },
  values: PriceSnapshotValues,
  observedAt: Date,
  touchMinIntervalMinutes = 10,
): PriceSnapshotWrite {
  return {
    appId: key.appId,
    platform: 'taobao',
    productKey: key.productKey,
    skuKey: null,
    sourceKind: key.sourceKind ?? 'detail',
    values,
    goodsSignPlan: null,
    observedAt,
    touchMinIntervalMinutes,
  };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A configuration reader that answers `value` for the interval key (or rejects). */
export function intervalConfig(value: unknown, fail = false) {
  const configValue = vi.fn(async (_appId: string, key: string) => {
    if (fail) throw new Error('config store down');
    if (key !== INTERVAL_KEY || value === undefined) return null;
    return { value: value as never, version: 1 };
  });
  return { configValue };
}

/** A fake store whose write is a vi.fn; `impl` decides each call. */
export function fakeStore(
  impl: (input: PriceSnapshotWrite) => Promise<PriceSnapshotWriteOutcome> = async () => 'inserted',
) {
  const write = vi.fn(impl);
  const store: PriceSnapshotStore = { write };
  return { store, write };
}

/** Recorder options around a fake store, a FixedClock and a warn spy. */
export function recorderSetup(
  overrides: { store?: PriceSnapshotStore; config?: ReturnType<typeof intervalConfig> } = {},
) {
  const clock = new FixedClock(at('08:00'));
  const warn = vi.fn();
  const config = overrides.config ?? intervalConfig(undefined);
  const fake = fakeStore();
  const options = {
    store: overrides.store ?? fake.store,
    clock,
    config,
    logger: { warn },
  } satisfies PriceSnapshotRecorderOptions;
  return { options, clock, warn, config, write: fake.write };
}

/** Lets queued microtasks and immediate callbacks run. */
export async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
