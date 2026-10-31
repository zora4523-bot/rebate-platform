// B2-04zg on the production worker queue runtime and a real PostgreSQL (D10-476 / task brief §10):
// a worker started on the bill day while the asset snapshot of D−1 is still pending. Nobody sends a
// bill job and nobody calls the catch-up: the module's own timer (real timers) does everything.
// - the first bill delivery answers deferred and completes (no queue retry used, nothing in
//   settle.dead, nothing written);
// - then the snapshot completes and the injected Clock moves on within the bill day; a later tick
//   of the module's timer sends the period again and 2032-06 is generated exactly once, every
//   delivery still without a queue retry.
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { createQueueRuntime } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import {
  APP,
  BILL_DAY,
  BILL_DAY_NOW,
  BILL_DAY_START,
  BILL_MONTH,
  DEAD_QUEUE,
  FAKE_CRYPTO,
  QUEUE,
  TAOBAO,
  fakeEventBus,
  seedOrder,
  settlementModule,
  silentRootLogger,
  workerContext,
  type NestContext,
  type PortState,
} from '../worker/kit.ts';
import {
  billJobsFor,
  billRunsOf,
  billsOf,
  makeDue,
  recordingPorts,
  runtimeQueue,
  until,
  withPools,
  type BillJobRow,
  type PortSwitches,
} from './kit.ts';

const TEST_TIMEOUT = 300_000;
/** BILL_DAY 09:00 +08:00: where the Clock is moved once the snapshot is complete. */
const LATER_SAME_DAY = '2032-07-24T01:00:00.000Z';
const DONE_RUN = { job: 'bill', platform: TAOBAO, run_at: BILL_DAY_START, status: 'done' };

const LIVE = ['created', 'retry', 'active'];
/** Not yet run, or running (a job failed into a retry counts as ended here). */
const NOT_ENDED = ['created', 'active'];

interface Worker {
  readonly switches: PortSwitches;
  close(): Promise<void>;
}

/** The worker module on a started production worker runtime over `db`; no job is sent here. */
async function startWorker(db: Kysely<DB>, clock: FixedClock, state: PortState): Promise<Worker> {
  const runtime = createQueueRuntime({ entry: 'worker', db, logger: silentRootLogger() });
  const queue = runtimeQueue(runtime);
  const { ports, calls, switches } = recordingPorts(state);
  const SettlementModule = await settlementModule();
  // Registers the handler on the runtime (before its start) and starts the module's timer.
  const context: NestContext = await workerContext(SettlementModule.forWorker(ports), {
    clock,
    logger: silentRootLogger(),
    db,
    queue,
    crypto: FAKE_CRYPTO,
    events: fakeEventBus(calls),
  }).catch(async (error: unknown) => {
    await runtime.stop();
    throw error;
  });
  try {
    await runtime.start();
  } catch (error) {
    await context.close();
    await runtime.stop();
    throw error;
  }
  return {
    switches,
    async close() {
      await context.close();
      await runtime.stop();
    },
  };
}

function retriesUsed(jobs: readonly BillJobRow[]) {
  return jobs
    .filter((job) => job.retryCount !== 0 || job.state === 'retry' || job.state === 'failed')
    .map((job) => ({ state: job.state, retryCount: job.retryCount }));
}

it(
  '[AC-B2-04zg#13] 真实 worker 账单日启动、D−1 快照未完成：模块定时器投出的首个 bill 答 deferred 并完成（retry_count 0，无 retry / failed，settle.dead 无副本，不写 settle_jobs / settle_bills）；随后快照完成、注入 Clock 推进到当日 09:00，不手动补种也不手动投递，靠定时器后续跳生成 2032-06 恰一次，全部投递不耗队列重试',
  async () => {
    await withPools(createTestDatabase, 10, async (db, observer) => {
      await seedOrder(db, APP, TAOBAO);
      const clock = new FixedClock(BILL_DAY_NOW);
      const state: PortState = { snapshot: 'pending', config: new Map() };
      const worker = await startWorker(db, clock, state);
      try {
        const jobs = () => billJobsFor(observer, APP, TAOBAO, BILL_DAY, QUEUE);
        const dead = () => billJobsFor(observer, APP, TAOBAO, BILL_DAY, DEAD_QUEUE);

        // The module's timer sends the bill day's job by itself (first tick within 60 s); its
        // first delivery meets the pending snapshot. A delayed send is let pass.
        const ended = await until(async () => {
          await makeDue(db, APP);
          return (await jobs()).some((job) => !NOT_ENDED.includes(job.state));
        }, 320);
        expect(ended).toBe(true);
        expect((await jobs())[0]?.state).toBe('completed');
        expect((await jobs())[0]?.retryCount).toBe(0);
        expect(retriesUsed(await jobs())).toStrictEqual([]);
        expect(await dead()).toStrictEqual([]);
        expect(await billRunsOf(observer, APP)).toStrictEqual([]);
        expect(await billsOf(observer, APP)).toStrictEqual([]);
        expect(worker.switches.snapshotDays.length).toBeGreaterThan(0);

        // The snapshot completes; the Clock moves on within the bill day. Only the timer acts.
        state.snapshot = 'complete';
        clock.set(LATER_SAME_DAY);
        const generated = await until(async () => {
          await makeDue(db, APP);
          return (await billRunsOf(observer, APP)).some((run) => run.status === 'done');
        }, 480);
        expect(generated).toBe(true);
        const settled = await until(async () => {
          const rows = await jobs();
          return rows.length > 0 && rows.every((job) => !LIVE.includes(job.state));
        }, 160);
        expect(settled).toBe(true);

        expect(await billRunsOf(observer, APP)).toStrictEqual([DONE_RUN]);
        expect(
          (await billsOf(observer, APP)).map((bill) => ({
            billId: bill.billId,
            generatedAt: bill.generatedAt,
          })),
        ).toStrictEqual([{ billId: BILL_MONTH, generatedAt: LATER_SAME_DAY }]);
        // A new delivery after the deferred one (sent by the module, not by this test).
        expect((await jobs()).length).toBeGreaterThanOrEqual(2);
        expect((await jobs()).every((job) => job.state === 'completed')).toBe(true);
        expect(retriesUsed(await jobs())).toStrictEqual([]);
        expect(await dead()).toStrictEqual([]);
        // The snapshot is judged on the run day (the bill day's D−1).
        expect([...new Set(worker.switches.snapshotDays)]).toStrictEqual(['2032-07-23']);
      } finally {
        await worker.close();
      }
    });
  },
  TEST_TIMEOUT,
);
