// B2-04zu rule tests on a real PostgreSQL (BR-FUND-04 ⑦, BR-TEXT-09; D10-719 ②, FU-B204ZF-CLOCK-SKEW):
// the start of a run's next execution (app.settle_runs.part_started_at) must not fall behind what the
// run already did, when the executor that publishes a rest runs on a clock that lags the worker that
// finished a batch or credited an order. Each executor process injects its own Clock; the next rest
// decides "did this execution credit anything" by comparing finished_at / credited_at / closed_at
// with part_started_at, so a lagging publisher would count an earlier execution's work again and send
// one more partial part (and one more CREDITED notification). BR-TEXT-09: CREDITED only for what was
// credited, 0 笔不发.
//
// Layout of every case: two executors on the same database, each with its own FixedClock — worker Y
// on the harness clock (the one the credit writes credited_at with) and worker X on a FixedClock
// SKEW_MS behind it (re-synced to that lag at the start of each of its deliveries). One run of two
// taobao batches: A (one order) finishes on Y; B (three orders) runs on X and is stopped by
// settle.auto.enabled. The executors are built here (the frozen run-done kit's build() always uses the
// harness clock); seeding, the credit, the switch map, resume (SB8) and the event reads come from
// ../run-done/kit.ts unchanged. No beneficiary items are seeded (closed_at is not exercised).
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { getAssetSnapshotStatus } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock, createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createBatchExecutor,
  type BatchExecuteResult,
} from '../../../../apps/api/src/modules/settlement/batch/executor/executor.ts';
import type { SeededOrder } from '../credit/kit.ts';
import {
  BILL,
  TIMEOUT,
  at,
  creditedOnce,
  databaseFixture,
  fixture,
  nth,
  untouched,
  type Fixture,
  type SeededBatch,
} from '../run-done/kit.ts';

const p = databaseFixture(createTestDatabase);

/** How far worker X's clock is behind worker Y's (the harness clock). */
const SKEW_MS = 30_000;
/** Past the 10-second bound of the switch reads. */
const SWITCH_STEP_MS = 11_000;

interface Worker {
  /** The FixedClock injected into this executor. */
  readonly clock: FixedClock;
  deliver(b: SeededBatch): Promise<BatchExecuteResult>;
}

/** Executors with their own clocks over one fixture, and the switch helpers they share. */
function rig(f: Fixture) {
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write() {
        // Lines are not asserted here.
      },
    },
  );
  /** Runs inside the credit call of that order (on its transaction), before the real credit. */
  const hooks = new Map<string, (trx: Transaction<DB>) => Promise<void>>();

  /** lagMs 0: the harness clock itself; otherwise a FixedClock kept lagMs behind it. */
  function worker(lagMs: number): Worker {
    const clock = lagMs === 0 ? f.clock : new FixedClock(f.clock.now());
    const executor = createBatchExecutor({
      db: f.db,
      clock,
      logger,
      config: f.config,
      snapshotStatus: getAssetSnapshotStatus,
      creditOrder: {
        credit: async (trx, input) => {
          const hook = hooks.get(input.orderId);
          if (hook !== undefined) {
            hooks.delete(input.orderId);
            await hook(trx);
          }
          return f.h.boot().credit(trx, input);
        },
      },
      creditBeneficiary: {
        execute: () => Promise.reject(new Error('the skew tests seed no beneficiary item')),
      },
      events: { publish: (trx, event) => f.write(trx, event) },
    });
    return {
      clock,
      deliver(b) {
        // The lag holds at the start of each delivery; the clock stays put during it.
        if (clock !== f.clock) clock.set(new Date(f.clock.now().getTime() - lagMs));
        return executor.run({ appId: f.appId, batchId: b.batchId });
      },
    };
  }

  /** Inside the credit of `o`, settle.auto.enabled goes off: the run stops before the next item. */
  function stopAfter(o: SeededOrder): void {
    hooks.set(o.orderId, async () => {
      f.switches.set('settle.auto.enabled', false);
      f.clock.advanceMs(SWITCH_STEP_MS);
    });
  }

  /** settle.auto.enabled off before the next delivery. */
  function switchOff(): void {
    f.switches.set('settle.auto.enabled', false);
    f.clock.advanceMs(SWITCH_STEP_MS);
  }

  return { worker, stopAfter, switchOff };
}

/** One delivery of `b` by `w`, with the outcome and the batch status it must leave. */
async function delivered(
  f: Fixture,
  w: Worker,
  b: SeededBatch,
  outcome: 'done' | 'partial',
): Promise<void> {
  expect(await w.deliver(b)).toMatchObject({ outcome });
  expect(await f.status(b)).toBe(outcome === 'done' ? 'DONE' : 'PARTIAL');
}

interface RunRow {
  readonly part: number;
  readonly last_outcome: string | null;
  readonly part_started_at: Date;
}

function runRow(f: Fixture, runId: string): Promise<RunRow | undefined> {
  return f.db
    .selectFrom('settle_runs')
    .select(['part', 'last_outcome', 'part_started_at'])
    .where('app_id', '=', f.appId)
    .where('settle_run_id', '=', runId)
    .executeTakeFirst();
}

async function storedRun(f: Fixture, runId: string): Promise<RunRow> {
  const row = await runRow(f, runId);
  if (row === undefined) throw new Error('the run has no settle_runs row');
  return row;
}

/** part and last_outcome of the run (part 0 and no outcome while there is no row). */
async function published(f: Fixture, runId: string) {
  const row = await runRow(f, runId);
  return { part: row?.part ?? 0, last_outcome: row?.last_outcome ?? null };
}

async function creditedAt(f: Fixture, o: SeededOrder): Promise<Date | null> {
  const row = await f.db
    .selectFrom('orders')
    .select('credited_at')
    .where('app_id', '=', f.appId)
    .where('order_id', '=', o.orderId)
    .executeTakeFirstOrThrow();
  return row.credited_at;
}

/** The run events of this app without the run id (checked to be `runId`), in publish order. */
async function shapes(f: Fixture, runId: string): Promise<Record<string, unknown>[]> {
  return (await f.runDone()).map((e) => {
    const { settle_run_id: id, ...rest } = e.payload as Record<string, unknown>;
    expect(id).toBe(runId);
    return rest;
  });
}

function shape(part: number, outcome: 'done' | 'partial') {
  return { bill_id: BILL, part, outcome, batch_count: 2 };
}

/** Seeds the run (A: one order, B: three orders) and builds Y (harness clock) and X (lagging). */
async function setUp(tag: string, lagMs: number) {
  const f = await fixture(p.db);
  const r = rig(f);
  const groups = await f.orderGroups(tag, [1, 3]);
  const { runId, batches } = await f.seedRun(groups);
  return {
    f,
    r,
    y: r.worker(0),
    x: r.worker(lagMs),
    runId,
    a: at(batches, 0),
    b: at(batches, 1),
    aOrders: at(groups, 0),
    bOrders: at(groups, 1),
  };
}

/**
 * A finishes on Y (the run does not rest: B still waits); then B starts on X, credits its first
 * order and is stopped by the switch → part=1 partial, published by X.
 */
async function opening(s: Awaited<ReturnType<typeof setUp>>): Promise<void> {
  const { f, r, x, y, a, b, runId, bOrders } = s;
  await delivered(f, y, a, 'done');
  expect(await f.runDone()).toEqual([]);
  f.clock.advanceMs(1_000);
  r.stopAfter(nth(bOrders, 0));
  await delivered(f, x, b, 'partial');
  expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'partial', 2)]);
}

/** The lower bound part_started_at must keep (all instants in ms). */
async function floorOf(
  f: Fixture,
  publisher: FixedClock,
  batches: readonly SeededBatch[],
  orders: readonly SeededOrder[],
): Promise<number> {
  const instants = [publisher.now().getTime()];
  for (const b of batches) {
    const finished = (await f.stored(b)).finished_at;
    if (finished !== null) instants.push(finished.getTime());
  }
  for (const o of orders) {
    const credited = await creditedAt(f, o);
    if (credited !== null) instants.push(credited.getTime());
  }
  return Math.max(...instants);
}

it(
  '[AC-B2-04zu#1][BR-FUND-04][BR-TEXT-09] 跨 worker 时钟落后不多发：批次 A 在 worker Y 上 DONE；批次 B 在时钟慢 Y 若干秒的 worker X 上入账一单后因 settle.auto.enabled 停住 → 恰一条 part=1 partial；开关恢复、续跑 B、处理下一单前开关再关、零入账回到 PARTIAL → 不发（A 与已入账的那单不算本次入账），run_done 仍只有 part=1，不出现 part=2；之后续跑到 DONE → 发 part=2 done',
  async () => {
    const s = await setUp('skew-zero', SKEW_MS);
    const { f, r, x, runId, a, b, aOrders, bOrders } = s;
    await opening(s);
    const partial = f.runEvent(runId, 1, 'partial', 2);
    expect(await f.status(a)).toBe('DONE');

    // 续跑 B，处理第 2 单之前开关再次关闭：本次执行一笔都没入账。
    f.switchBackOn();
    await f.resume(b);
    r.switchOff();
    await delivered(f, x, b, 'partial');
    expect(await f.runDone()).toStrictEqual([partial]);
    expect(await published(f, runId)).toEqual({ part: 1, last_outcome: 'partial' });
    await creditedOnce(f, nth(aOrders, 0));
    await creditedOnce(f, nth(bOrders, 0));
    await untouched(f, nth(bOrders, 1));
    await untouched(f, nth(bOrders, 2));

    // 再续跑到 DONE（时钟先走过偏差）：下一条是 part=2 done。
    f.switchBackOn();
    f.clock.advanceMs(2 * SKEW_MS);
    await f.resume(b);
    await delivered(f, x, b, 'done');
    expect(await f.runDone()).toStrictEqual([partial, f.runEvent(runId, 2, 'done', 2)]);
    for (const o of [...aOrders, ...bOrders]) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zu#2][BR-FUND-04][BR-TEXT-09] 正常续跑仍发、只计本次入账：同上布局，part=1 partial 之后续跑 B 在 X 上真的入账了第 2 单再停住 → 发 part=2 partial；本次执行（part=1 起点之后、part=2 起点及之前）入账的只有第 2 单，A 的订单、A 的完成与 part=1 已入账的第 1 单都不在这次执行里',
  async () => {
    const s = await setUp('skew-more', SKEW_MS);
    const { f, r, x, runId, a, b, aOrders, bOrders } = s;
    await opening(s);
    const first = await storedRun(f, runId);
    expect(first).toMatchObject({ part: 1, last_outcome: 'partial' });

    f.switchBackOn();
    await f.resume(b);
    r.stopAfter(nth(bOrders, 1));
    await delivered(f, x, b, 'partial');
    expect(await f.runDone()).toStrictEqual([
      f.runEvent(runId, 1, 'partial', 2),
      f.runEvent(runId, 2, 'partial', 2),
    ]);
    const second = await storedRun(f, runId);
    expect(second).toMatchObject({ part: 2, last_outcome: 'partial' });

    // 本次执行 = (part=1 起点, part=2 起点]：只含本次入账的第 2 单。
    const from = first.part_started_at.getTime();
    const to = second.part_started_at.getTime();
    const counted: string[] = [];
    for (const o of [...aOrders, ...bOrders]) {
      const credited = await creditedAt(f, o);
      if (credited !== null && credited.getTime() > from && credited.getTime() <= to) {
        counted.push(o.orderId);
      }
    }
    expect(counted).toEqual([nth(bOrders, 1).orderId]);
    const finishedA = (await f.stored(a)).finished_at;
    expect(finishedA).not.toBeNull();
    expect((finishedA?.getTime() ?? 0) > from).toBe(false);

    await creditedOnce(f, nth(aOrders, 0));
    await creditedOnce(f, nth(bOrders, 0));
    await creditedOnce(f, nth(bOrders, 1));
    await untouched(f, nth(bOrders, 2));
  },
  TIMEOUT,
);

interface Step {
  readonly label: string;
  readonly events: Record<string, unknown>[];
  readonly run: { readonly part: number; readonly last_outcome: string | null };
}

/**
 * The whole flow: A done on Y; B on X credits one order and stops; continue, stopped again before
 * any credit; continue, credits one more order and stops; continue to DONE (the clock first moves
 * past the lag). After every step: the run events (without the run id) and the run row.
 */
async function flow(tag: string, lagMs: number): Promise<Step[]> {
  const s = await setUp(tag, lagMs);
  const { f, r, x, runId, b, aOrders, bOrders } = s;
  const steps: Step[] = [];
  async function record(label: string): Promise<void> {
    steps.push({ label, events: await shapes(f, runId), run: await published(f, runId) });
  }

  await delivered(f, s.y, s.a, 'done');
  await record('A 在 Y 上完成');
  f.clock.advanceMs(1_000);
  r.stopAfter(nth(bOrders, 0));
  await delivered(f, x, b, 'partial');
  await record('B 在 X 上入账一单后停住');

  f.switchBackOn();
  await f.resume(b);
  r.switchOff();
  await delivered(f, x, b, 'partial');
  await record('续跑零入账再停');

  f.switchBackOn();
  await f.resume(b);
  r.stopAfter(nth(bOrders, 1));
  await delivered(f, x, b, 'partial');
  await record('续跑入账一单后停住');

  f.switchBackOn();
  f.clock.advanceMs(2 * SKEW_MS);
  await f.resume(b);
  await delivered(f, x, b, 'done');
  await record('续跑到完成');

  for (const o of [...aOrders, ...bOrders]) await creditedOnce(f, o);
  return steps;
}

it(
  '[AC-B2-04zu#3][BR-FUND-04][BR-TEXT-09] 时钟一致时行为不变：两实例用同一 FixedClock 跑完整流程（A 完成 → B 入账一单停住 → 续跑零入账再停 → 续跑入账一单停住 → 续跑到完成），每步的 run_done 序列与 settle_runs 的 part / last_outcome 依次为 无 / part=1 partial / 不变 / part=2 partial / part=3 done；X 时钟落后时同一流程每步结果与之完全相同',
  async () => {
    const empty: Step['events'] = [];
    const expected: Step[] = [
      { label: 'A 在 Y 上完成', events: empty, run: { part: 0, last_outcome: null } },
      {
        label: 'B 在 X 上入账一单后停住',
        events: [shape(1, 'partial')],
        run: { part: 1, last_outcome: 'partial' },
      },
      {
        label: '续跑零入账再停',
        events: [shape(1, 'partial')],
        run: { part: 1, last_outcome: 'partial' },
      },
      {
        label: '续跑入账一单后停住',
        events: [shape(1, 'partial'), shape(2, 'partial')],
        run: { part: 2, last_outcome: 'partial' },
      },
      {
        label: '续跑到完成',
        events: [shape(1, 'partial'), shape(2, 'partial'), shape(3, 'done')],
        run: { part: 3, last_outcome: 'done' },
      },
    ];

    const same = await flow('skew-same', 0);
    expect(same).toStrictEqual(expected);
    const lagging = await flow('skew-lag', SKEW_MS);
    expect(lagging).toStrictEqual(same);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zu#4][BR-FUND-04] 起点只来自注入时钟与已有数据：X 每次发布后直接读 settle_runs 行，part_started_at ≥ 本 run 已完成批次 finished_at 与已入账订单 credited_at 的最大值，且 ≥ 发布方 X 的 clock.now()，且不晚于测试里最快的注入时钟（part=1 partial、part=2 partial、part=3 done 三次都成立）',
  async () => {
    const s = await setUp('skew-floor', SKEW_MS);
    const { f, r, x, runId, a, b, aOrders, bOrders } = s;
    const orders = [...aOrders, ...bOrders];
    async function clamped(part: number, outcome: 'done' | 'partial'): Promise<void> {
      const row = await storedRun(f, runId);
      expect(row).toMatchObject({ part, last_outcome: outcome });
      const start = row.part_started_at.getTime();
      expect(start).toBeGreaterThanOrEqual(await floorOf(f, x.clock, [a, b], orders));
      expect(start).toBeGreaterThanOrEqual(x.clock.now().getTime());
      expect(start).toBeLessThanOrEqual(f.clock.now().getTime());
    }

    await opening(s);
    await clamped(1, 'partial');

    f.switchBackOn();
    await f.resume(b);
    r.stopAfter(nth(bOrders, 1));
    await delivered(f, x, b, 'partial');
    await clamped(2, 'partial');

    f.switchBackOn();
    f.clock.advanceMs(2 * SKEW_MS);
    await f.resume(b);
    await delivered(f, x, b, 'done');
    await clamped(3, 'done');
    for (const o of orders) await creditedOnce(f, o);
  },
  TIMEOUT,
);
