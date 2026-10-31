// B2-04zg on the production worker queue runtime (createQueueRuntime, entry worker, production
// catalog and plan) and a real PostgreSQL (D10-476 / task brief §9.2): SettlementModule.forWorker
// registers its settle handler on the runtime and runs its own timer (real timers: the first tick
// within 60 s of start is the worker's self-heal). The other modules' ports are synthetic.
// - a deferred bill (asset snapshot of the run day not complete) uses no queue retries; the job
//   completes with retry_count 0, nothing goes to settle.dead, nothing is written; the catch-up
//   sends the same period again, and once the snapshot is complete the bill month is generated
//   exactly once — every delivery still without a retry;
// - a worker started the day after a bill day that was missed entirely generates that bill month
//   by itself (nobody calls the seed), the snapshot judged on its own day; the earlier period is
//   not sent.
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { createQueueRuntime } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import {
  createSettleCatchUpStore,
  scheduleSettleBill,
  seedSettleBillCatchUp,
  type SettlementWorkerPorts,
} from '../../../../apps/api/src/modules/settlement/worker/index.ts';
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
  billKey,
  fakeEventBus,
  memoryLogger,
  seedOrder,
  settlementModule,
  silentRootLogger,
  workerContext,
  type FakeQueue,
  type NestContext,
  type PortState,
} from '../worker/kit.ts';
import {
  DAY_AFTER_NOW,
  PREV_BILL_DAY,
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

const WORKER_TIMEOUT = 240_000;
const DONE_RUN = { job: 'bill', platform: TAOBAO, run_at: BILL_DAY_START, status: 'done' };

interface Worker {
  readonly queue: FakeQueue;
  readonly ports: SettlementWorkerPorts;
  readonly switches: PortSwitches;
  close(): Promise<void>;
}

/** The worker module on a started production worker runtime over `db`. */
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
    queue,
    ports,
    switches,
    async close() {
      await context.close();
      await runtime.stop();
    },
  };
}

const LIVE = ['created', 'retry', 'active'];
/** Not yet run, or running (a retry counts as ended here). */
const NOT_ENDED = ['created', 'active'];

function retriesUsed(jobs: readonly BillJobRow[]) {
  return jobs
    .filter((job) => job.retryCount !== 0 || job.state === 'retry' || job.state === 'failed')
    .map((job) => ({ state: job.state, retryCount: job.retryCount }));
}

it(
  '[AC-B2-04zg#11] 真实 worker：账单日快照未完成时 bill 答 deferred——投递完成、不耗队列重试（retry_count 0、无 retry / failed、settle.dead 无副本），不写 settle_jobs / settle_bills；补出账随后重排同一期（新的投递，仍不耗重试）；快照完成后补跑生成 2032-06 恰一次，之后不再重排',
  async () => {
    await withPools(createTestDatabase, 10, async (db, observer) => {
      await seedOrder(db, APP, TAOBAO);
      const clock = new FixedClock(BILL_DAY_NOW);
      const state: PortState = { snapshot: 'pending', config: new Map() };
      const worker = await startWorker(db, clock, state);
      try {
        const jobs = () => billJobsFor(observer, APP, TAOBAO, BILL_DAY, QUEUE);
        const dead = () => billJobsFor(observer, APP, TAOBAO, BILL_DAY, DEAD_QUEUE);
        const allSettled = async () => {
          const rows = await jobs();
          return rows.length > 0 && rows.every((job) => !LIVE.includes(job.state));
        };
        const catchUp = () =>
          seedSettleBillCatchUp({
            db,
            clock,
            queue: worker.queue,
            logger: memoryLogger().logger,
            runs: createSettleCatchUpStore(db),
            platforms: [TAOBAO],
            config: worker.ports.config(db, clock),
          });

        // The bill day's delivery while the snapshot is still pending.
        await scheduleSettleBill(worker.queue, null, {
          appId: APP,
          platform: TAOBAO,
          accountingDate: BILL_DAY,
        });
        // Ended: completed, or failed into a retry (which this rule forbids).
        const ended = await until(
          async () => (await jobs()).some((job) => !NOT_ENDED.includes(job.state)),
          160,
        );
        expect(ended).toBe(true);
        expect((await jobs())[0]?.state).toBe('completed');
        expect(retriesUsed(await jobs())).toStrictEqual([]);
        expect(await dead()).toStrictEqual([]);
        expect(await billRunsOf(observer, APP)).toStrictEqual([]);
        expect(await billsOf(observer, APP)).toStrictEqual([]);
        expect(worker.switches.snapshotDays.length).toBeGreaterThan(0);

        // Rescheduled: the catch-up sends the same period again (a new delivery); still pending
        // snapshot, still deferred, still no retry.
        await catchUp();
        expect((await jobs()).length).toBeGreaterThanOrEqual(2);
        await makeDue(db, APP);
        expect(await until(allSettled, 160)).toBe(true);
        expect(retriesUsed(await jobs())).toStrictEqual([]);
        expect(await dead()).toStrictEqual([]);
        expect(await billRunsOf(observer, APP)).toStrictEqual([]);

        // The snapshot completes later that day: the next catch-up generates 2032-06.
        state.snapshot = 'complete';
        clock.set('2032-07-24T01:00:00.000Z');
        await catchUp();
        await makeDue(db, APP);
        expect(
          await until(
            async () => (await billRunsOf(observer, APP)).some((run) => run.status === 'done'),
            160,
          ),
        ).toBe(true);
        expect(await until(allSettled, 160)).toBe(true);
        expect(await billRunsOf(observer, APP)).toStrictEqual([DONE_RUN]);
        expect((await billsOf(observer, APP)).map((bill) => bill.billId)).toStrictEqual([
          BILL_MONTH,
        ]);
        expect(retriesUsed(await jobs())).toStrictEqual([]);
        expect(await dead()).toStrictEqual([]);

        // Generated: no further delivery is arranged.
        const count = (await jobs()).length;
        await catchUp();
        expect((await jobs()).length).toBe(count);
      } finally {
        await worker.close();
      }
    });
  },
  WORKER_TIMEOUT,
);

it(
  '[AC-B2-04zg#12] worker 启动自愈：账单日整日停机、次日启动的 worker 由模块自己的定时器（无人调用补种）补投 07-24 的 bill，按 07-25 当天判定快照，生成 2032-06 恰一次，任务一个、不耗重试；更早的 06-24 不补',
  async () => {
    await withPools(createTestDatabase, 10, async (db, observer) => {
      await seedOrder(db, APP, TAOBAO);
      const clock = new FixedClock(DAY_AFTER_NOW);
      const worker = await startWorker(db, clock, { snapshot: 'complete', config: new Map() });
      try {
        // The module's timer ticks within 60 s (a tick lost to the runtime's start: the next one);
        // a short delay of the catch-up send is let pass.
        const generated = await until(async () => {
          await makeDue(db, APP);
          return (await billRunsOf(observer, APP)).some((run) => run.status === 'done');
        }, 400);
        expect(generated).toBe(true);
        const settled = await until(async () => {
          const rows = await billJobsFor(observer, APP, TAOBAO, BILL_DAY, QUEUE);
          return rows.length > 0 && rows.every((job) => !LIVE.includes(job.state));
        }, 160);
        expect(settled).toBe(true);

        expect(await billRunsOf(observer, APP)).toStrictEqual([DONE_RUN]);
        expect(
          (await billsOf(observer, APP)).map((bill) => ({
            billId: bill.billId,
            generatedAt: bill.generatedAt,
          })),
        ).toStrictEqual([{ billId: BILL_MONTH, generatedAt: DAY_AFTER_NOW }]);
        expect(
          (await billJobsFor(observer, APP, TAOBAO, BILL_DAY, QUEUE)).map((job) => ({
            singletonKey: job.singletonKey,
            state: job.state,
            retryCount: job.retryCount,
          })),
        ).toStrictEqual([
          { singletonKey: billKey(APP, TAOBAO, BILL_DAY), state: 'completed', retryCount: 0 },
        ]);
        expect(await billJobsFor(observer, APP, TAOBAO, PREV_BILL_DAY, QUEUE)).toStrictEqual([]);
        expect([...new Set(worker.switches.snapshotDays)]).toStrictEqual(['2032-07-24']);
      } finally {
        await worker.close();
      }
    });
  },
  WORKER_TIMEOUT,
);
