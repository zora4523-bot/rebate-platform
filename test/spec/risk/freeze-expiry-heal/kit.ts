import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterEach, expect, vi } from 'vitest';
import { createScan, ports, type Job, type Options, type Scan } from '../freeze-expiry/kit.ts';

export { job } from '../freeze-expiry/kit.ts';
export const HEAL_INTERVAL_MS = 5 * 60_000;
export type Name = 'freeze-expiry' | 'daily-alerts';
export interface Healer extends Scan {
  heal(): Promise<void>;
}
export interface Control {
  stop(): void;
}
export type Schedule = (tick: () => Promise<void>, intervalMs: number) => Control;
export interface HealModule {
  RISK_SCAN_HEAL_INTERVAL_MS?: number;
  startRiskScanHeal(
    resolve: () => unknown,
    logger: unknown,
    stopping: () => boolean,
    schedule?: Schedule,
  ): Control;
}

export async function healModule(): Promise<HealModule> {
  return (await import(
    new URL('../../../../apps/api/src/modules/risk/index.ts', import.meta.url).href
  )) as HealModule;
}

const databases: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

export async function fixture() {
  const p = await ports();
  const queries: string[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      queries.push(event.query.sql);
    },
  });
  databases.push(db);
  const writes = vi.fn(async () => undefined);
  const options: Options = { ...p, db, riskState: { setRiskState: writes } };
  const scan = await createScan(options);
  const logs = () => p.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { ...p, options, scan, queries, writes, logs };
}

// Do not turn an absent new method into TypeError: baseline red is an assertion failure.
export function healer(scan: Scan): Healer {
  expect(scan).toHaveProperty('heal', expect.any(Function));
  return scan as Healer;
}

/** Records exclusive ownership while queued AND active; completed keys can be sent again. */
export function exclusiveQueue(f: Awaited<ReturnType<typeof fixture>>) {
  interface Pending {
    job: Job;
    due: number;
    active: boolean;
  }
  const pending = new Map<string, Pending>();
  const accepted: string[] = [];
  const completed: string[] = [];
  f.send.mockImplementation(async (queue, name, payload, options) => {
    expect(queue).toBe('risk-scan');
    expect(payload).toEqual({});
    expect(options.trx).toBeNull();
    expect(options.singletonKey).toEqual(expect.any(String));
    const key = options.singletonKey!;
    if (pending.has(key)) return null;
    accepted.push(key);
    pending.set(key, {
      job: { id: `recorded-${accepted.length}`, queue, name, payload: {}, attempt: 1 },
      due: f.clock.now().getTime() + (options.delaySeconds ?? 0) * 1000,
      active: false,
    });
    return `recorded-${accepted.length}`;
  });
  return {
    pending,
    accepted,
    completed,
    async consume(key: string, beforeComplete?: () => Promise<void>) {
      const item = pending.get(key);
      expect(item, 'a queued job must exist').toBeDefined();
      expect(item!.due).toBeLessThanOrEqual(f.clock.now().getTime());
      expect(item!.active).toBe(false);
      item!.active = true;
      await beforeComplete?.();
      await f.scan.handle(item!.job);
      pending.delete(key);
      completed.push(key);
    },
  };
}

export function manualSchedule() {
  let tick: (() => Promise<void>) | undefined;
  const cancel = vi.fn();
  const schedule = vi.fn<Schedule>((callback) => {
    tick = callback;
    return { stop: cancel };
  });
  return {
    schedule,
    cancel,
    // Retain even a cancelled callback to model one already queued in the event loop.
    async fire() {
      expect(tick).toEqual(expect.any(Function));
      await tick!();
    },
  };
}
