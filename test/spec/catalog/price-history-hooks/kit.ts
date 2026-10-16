// B1-17c rule-test helpers (BR-WATCH-19 (1): 商品详情、查返利/链接识别、搜索的联盟返回在响应后异步写入
// price_snapshot，写入失败只计数不重试，不得影响接口；不含用户标识；只写不带用户级参数的返回).
// The hooks are driven through the existing use cases with fake upstreams; the recorder handed to
// them is B1-17b's real createPriceSnapshotRecorder over a fake store, so "交出后被写入器拒写" and
// "不交" both end as "no store write". Expectations in the tests are literals.
import { vi } from 'vitest';
import {
  createPriceSnapshotRecorder,
  type PriceObservation,
  type PriceSnapshotRecorder,
  type PriceSnapshotWrite,
  type PriceSnapshotWriteOutcome,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import type { Clock } from '../../../../apps/api/src/modules/platform/index.ts';

/**
 * A recorder spy: every observation handed to record() is kept (shallow copy, as handed), then
 * passed on to the real B1-17b recorder, whose store only collects the writes it receives.
 */
export function hookRecorder(clock: Clock) {
  const observations: PriceObservation[] = [];
  const writes: PriceSnapshotWrite[] = [];
  const write = vi.fn(async (input: PriceSnapshotWrite): Promise<PriceSnapshotWriteOutcome> => {
    writes.push(input);
    return 'inserted';
  });
  const real = createPriceSnapshotRecorder({
    store: { write },
    clock,
    config: { configValue: async () => null },
    logger: { warn: vi.fn() },
  });
  const record = vi.fn((observation: PriceObservation): void => {
    observations.push({ ...observation });
    real.record(observation);
  });
  const recorder: PriceSnapshotRecorder = {
    record,
    drain: () => real.drain(),
    failureCount: () => real.failureCount(),
  };
  return { recorder, record, observations, writes, write };
}

/** A recorder whose record() always throws (a broken hook must never reach the response). */
export function throwingRecorder() {
  const record = vi.fn((observation: PriceObservation): void => {
    void observation;
    throw new Error('synthetic recorder failure');
  });
  const recorder: PriceSnapshotRecorder = {
    record,
    drain: async () => undefined,
    failureCount: () => 0,
  };
  return { recorder, record };
}

/**
 * A recorder whose record() hands back a promise that never settles. The hook must not await
 * it: a use case that awaited record() would never answer.
 */
export function hangingRecorder() {
  const record = vi.fn((observation: PriceObservation) => {
    void observation;
    return new Promise<void>(() => undefined);
  });
  const recorder = {
    record,
    drain: async () => undefined,
    failureCount: () => 0,
  } as unknown as PriceSnapshotRecorder;
  return { recorder, record };
}

/** Observations sorted by product key (the hooks may hand them off in any order). */
export function byKey<T extends { readonly productKey: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.productKey < b.productKey ? -1 : 1));
}

/** JSON text of anything with bigint values, for "no user identifier anywhere" checks. */
export function textOf(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) =>
    typeof field === 'bigint' ? field.toString() : field,
  );
}

/** Error shape compared between a run with and without the hook. */
export function errorShape(error: unknown): unknown {
  if (!(error instanceof Error)) return { thrown: error };
  const fields = error as Error & { code?: unknown; data?: unknown };
  return { name: error.name, message: error.message, code: fields.code, data: fields.data };
}

/** Outcome of a call as data: the value, or the shape of the rejection. */
export async function outcome<T>(action: () => Promise<T>) {
  try {
    return { kind: 'returned' as const, value: await action() };
  } catch (error: unknown) {
    return { kind: 'rejected' as const, error: errorShape(error) };
  }
}

/** Lets queued microtasks and timers run. */
export async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeTransaction {
  setIsolationLevel(level: string): FakeTransaction;
  execute(work: unknown): Promise<string>;
}

/**
 * A stand-in for the module's DB handle, only as far as B1-17b's createKyselyPriceSnapshotStore
 * uses it (db.transaction().setIsolationLevel(…).execute(…)). Each execute is one store write;
 * the callback is never run. With hold, a write stays in flight until released.
 */
export function fakeDb(hold: boolean) {
  const waiting: (() => void)[] = [];
  const execute = vi.fn((work: unknown): Promise<string> => {
    void work;
    return new Promise<string>((resolve) => {
      const done = (): void => resolve('inserted');
      if (hold) waiting.push(done);
      else done();
    });
  });
  const transaction: FakeTransaction = {
    setIsolationLevel: () => transaction,
    execute,
  };
  return {
    db: { transaction: () => transaction },
    execute,
    inFlight: (): number => waiting.length,
    releaseOne(): void {
      waiting.shift()?.();
    },
    releaseAll(): void {
      while (waiting.length > 0) waiting.shift()?.();
    },
  };
}
