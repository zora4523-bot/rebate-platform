// Shared harness of the B2-04zf rule tests: the settle run event settle.run_done (D10-467 ③ as
// corrected by D10-477; BR-FUND-04 ⑥ ⑦, BR-TEXT-09 「同一月结账单一次确认的批次全部执行完，或因开关停止
// 置 PARTIAL 时对已入账部分」). One event per (settle_run_id, part): outcome 'done' when every batch of
// the run is DONE, outcome 'partial' when the execution was stopped by a switch and a batch moved to
// PARTIAL; after a manual continue (SB8) the next 'done' or 'partial' is part + 1.
//
// Builds on the B2-04p executor harness (test/spec/settlement/batch-executor/kit.ts, imported and
// not changed): orders, the real B2-04m credit, the switch map and the event writer (event_log on
// the caller's transaction) come from there. Batches are seeded with a settle_run_id, as one
// confirmation of a bill leaves them. Every executor built here publishes through its own wrapper,
// so a test can refuse one event, look inside the publishing transaction, or hold one executor's
// completing transaction while the other one finishes.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Insertable, type Kysely, type Transaction } from 'kysely';
import { expect } from 'vitest';
import { getAssetSnapshotStatus } from '../../../../apps/api/src/modules/ledger/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createBatchExecutor,
  type BatchExecuteResult,
  type BatchExecutor,
  type BatchExecutorDependencies,
} from '../../../../apps/api/src/modules/settlement/batch/executor/executor.ts';
import {
  BILL,
  fixture as executorFixture,
  p0Orders,
  type SeededBatch,
} from '../batch-executor/kit.ts';
import type { SeededOrder } from '../credit/kit.ts';

export {
  BILL,
  TIMEOUT,
  creditedOnce,
  databaseFixture,
  nth,
  p0Orders,
  untouched,
  type SeededBatch,
} from '../batch-executor/kit.ts';

/** The run event of this task (02 §11 two-segment naming, next to settle.batch_done). */
export const RUN_DONE = 'settle.run_done';
export const BATCH_DONE = 'settle.batch_done';

export type Publish = BatchExecutorDependencies['events']['publish'];
export type RunOutcome = 'done' | 'partial';

/** What one run event must carry: ids, the part, the outcome and a count; no person, no amount. */
export function runPayload(runId: string, part: number, outcome: RunOutcome, batchCount: number) {
  return { settle_run_id: runId, bill_id: BILL, part, outcome, batch_count: batchCount };
}

export interface ExecutorOptions {
  /** Pool of this executor "process" (default: the fixture's shared pool). */
  readonly via?: Kysely<DB>;
  /** Label recorded with every publish call. */
  readonly by?: string;
  /** Replaces the plain pass-through to the harness writer. */
  readonly publish?: Publish;
}

export interface PublishCall {
  readonly by: string;
  readonly name: string;
}

export async function fixture(db: Kysely<DB>) {
  const f = await executorFixture(db);
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write() {
        // Lines are not asserted here.
      },
    },
  );
  /** Every publish call of the executors built here, in call order (refused ones included). */
  const calls: PublishCall[] = [];

  /** The harness writer: one event_log row on the caller's transaction. */
  const write: Publish = (trx, event) => f.h.publish(trx, event);

  /** Runs inside the credit call of that order (on its transaction), before the real credit. */
  const creditHooks = new Map<string, (trx: Transaction<DB>) => Promise<void>>();
  function onCredit(o: SeededOrder, hook: (trx: Transaction<DB>) => Promise<void>): void {
    creditHooks.set(o.orderId, hook);
  }

  // Named build / deliver (not executor / run) so the result stays a superset of the B2-04p
  // fixture and its helpers (creditedOnce, …) accept it.
  function build(options: ExecutorOptions = {}): BatchExecutor {
    const by = options.by ?? 'main';
    const inner = options.publish ?? write;
    return createBatchExecutor({
      db: options.via ?? f.db,
      clock: f.clock,
      logger,
      config: f.config,
      snapshotStatus: getAssetSnapshotStatus,
      creditOrder: {
        credit: async (trx, input) => {
          const hook = creditHooks.get(input.orderId);
          if (hook !== undefined) {
            creditHooks.delete(input.orderId);
            await hook(trx);
          }
          return f.h.boot().credit(trx, input);
        },
      },
      creditBeneficiary: {
        execute: () => Promise.reject(new Error('the run-done tests seed no beneficiary item')),
      },
      events: {
        publish: async (trx, event) => {
          calls.push({ by, name: event.name });
          return inner(trx, event);
        },
      },
    });
  }

  /** One batch_execute delivery of `b` by an executor built here. */
  function deliver(b: SeededBatch, options: ExecutorOptions = {}): Promise<BatchExecuteResult> {
    return build(options).run({ appId: f.appId, batchId: b.batchId });
  }

  /**
   * One batch per group, all with the same settle_run_id (one confirmation); `values[i]` patches
   * the i-th batch (status, kind, …).
   */
  async function seedRun(
    groups: readonly (readonly SeededOrder[])[],
    values: readonly Partial<Insertable<DB['settle_batches']>>[] = [],
    runId: string = randomUUID(),
  ): Promise<{ runId: string; batches: SeededBatch[] }> {
    const batches: SeededBatch[] = [];
    for (const [index, orders] of groups.entries()) {
      batches.push(await f.batch(orders, { settle_run_id: runId, ...values[index] }));
    }
    return { runId, batches };
  }

  /** Fresh P0 orders, one list per batch. */
  async function orderGroups(tag: string, sizes: readonly number[]): Promise<SeededOrder[][]> {
    const groups: SeededOrder[][] = [];
    for (const [index, size] of sizes.entries()) {
      groups.push(await p0Orders(f, `${tag}-${String(index)}`, size));
    }
    return groups;
  }

  /** The run events of this app (event_log), in publish order. */
  async function runDone(): Promise<{ app_id: string; payload: unknown }[]> {
    return (await f.h.published())
      .filter((e) => e.name === RUN_DONE)
      .map((e) => ({ app_id: e.app_id, payload: e.payload }));
  }

  /** One expected run event of this app (app_id in the envelope). */
  function runEvent(runId: string, part: number, outcome: RunOutcome, batchCount: number) {
    return { app_id: f.appId, payload: runPayload(runId, part, outcome, batchCount) };
  }

  /** Labels of the publish calls of settle.run_done, in call order. */
  function runDoneBy(): string[] {
    return calls.filter((call) => call.name === RUN_DONE).map((call) => call.by);
  }

  /** settle.batch_done rows of this app whose payload names batch `b`. */
  async function batchDone(b: SeededBatch): Promise<number> {
    return (await f.h.published()).filter(
      (e) =>
        e.name === BATCH_DONE &&
        typeof e.payload === 'object' &&
        e.payload !== null &&
        (e.payload as Record<string, unknown>).batch_id === b.batchId,
    ).length;
  }

  async function status(b: SeededBatch): Promise<string> {
    return (await f.stored(b)).status;
  }

  /** Runs `b` once and expects SB6 (DONE) by this delivery. */
  async function finish(b: SeededBatch, options: ExecutorOptions = {}): Promise<void> {
    expect(await deliver(b, options)).toMatchObject({ outcome: 'done' });
    expect(await status(b)).toBe('DONE');
  }

  /**
   * Inside the credit transaction of `o`, settle.auto.enabled goes off (and the clock moves past
   * the 10-second bound): the executor credits `o`, then stops before the next item (SB7).
   */
  function stopAfter(o: SeededOrder): void {
    onCredit(o, async () => {
      f.switches.set('settle.auto.enabled', false);
      f.clock.advanceMs(11_000);
    });
  }

  /** settle.auto.enabled back on (and the clock past the 10-second bound). */
  function switchBackOn(): void {
    f.switches.set('settle.auto.enabled', true);
    f.clock.advanceMs(11_000);
  }

  /** Runs `b` once and expects SB7 (PARTIAL, stopped by a switch) by this delivery. */
  async function stop(b: SeededBatch, options: ExecutorOptions = {}): Promise<void> {
    expect(await deliver(b, options)).toMatchObject({ outcome: 'partial' });
    expect(await status(b)).toBe('PARTIAL');
  }

  return {
    ...f,
    calls,
    write,
    onCredit,
    build,
    deliver,
    seedRun,
    orderGroups,
    runDone,
    runEvent,
    runDoneBy,
    batchDone,
    status,
    finish,
    stopAfter,
    switchBackOn,
    stop,
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The i-th element (throws instead of an undefined under noUncheckedIndexedAccess). */
export function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`no element #${String(index)}`);
  return item;
}

/** True while a backend of the named pool (this database) waits on a lock. */
export async function lockWaiting(db: Kysely<DB>, name: string): Promise<boolean> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE application_name = ${name}
      AND datname = current_database()
      AND wait_event_type = 'Lock'`.execute(db);
  return (result.rows[0]?.n ?? 0) > 0;
}

/** Polls `ready` (5 ms apart, at most ~20 s); false when it never became true. */
export async function waitUntil(ready: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    if (await ready()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return false;
}
