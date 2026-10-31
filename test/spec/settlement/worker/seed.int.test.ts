// B2-04ze: the daily seed of the bill (D10-443 / task brief §9.2): every day, for every app (distinct
// app_id of app.orders) × platform, one `bill` job of the +08:00 day D of the clock, unless the
// (app, platform, D) run is done or already queued / active / retrying — decided from the queue and
// settle_jobs (SettleRunStore), never from process memory; a non-bill day is seeded all the same
// (the bill job answers not_due). The store is checked against pg-boss on the test database.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createSettleRunStore,
  scheduleSettleBill,
  seedSettleBills,
  type SettleBillRunState,
  type SettleRunStore,
} from '../../../../apps/api/src/modules/settlement/worker/index.ts';
import {
  APP,
  BILL_DAY,
  BILL_DAY_NOW,
  BILL_DAY_START,
  JD,
  OTHER,
  PDD,
  PLAIN_DAY,
  PLAIN_DAY_NOW,
  TAOBAO,
  THIRD,
  TIMEOUT,
  billKey,
  billSend,
  byKey,
  failToDead,
  fakeQueue,
  jobsUnder,
  liveJobsUnder,
  memoryLogger,
  messages,
  rejection,
  seedKey,
  seedOrder,
  seedSettleJob,
  sendView,
  transition,
  withDatabase,
  withRealQueue,
} from './kit.ts';

interface FakeRuns extends SettleRunStore {
  /** billKey(app, platform, D) → state; a missing key is 'absent'. */
  readonly states: Map<string, SettleBillRunState>;
  readonly reads: string[];
}

function fakeRuns(): FakeRuns {
  const states = new Map<string, SettleBillRunState>();
  const reads: string[] = [];
  return {
    states,
    reads,
    async billStateOf(appId, platform, day) {
      const key = billKey(appId, platform, day);
      reads.push(key);
      return states.get(key) ?? 'absent';
    },
  };
}

it(
  '[AC-B2-04ze#10] 补种：每个有订单的 app × 每个平台各送 1 个当日（+08:00）的 bill 任务（一个 app 多单也只 1 个），事务外、立即；账单日与非账单日一样补种',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await seedOrder(db, APP, TAOBAO);
      await seedOrder(db, APP, TAOBAO);
      await seedOrder(db, OTHER, JD);
      // Only an order key (no orders row): not an app of the seed.
      await seedKey(db, THIRD, TAOBAO);
      const platforms = [TAOBAO, JD, PDD];
      const { logger } = memoryLogger();

      for (const [now, day] of [
        [BILL_DAY_NOW, BILL_DAY],
        [PLAIN_DAY_NOW, PLAIN_DAY],
      ] as const) {
        const queue = fakeQueue();
        const clock = new FixedClock(now);
        await seedSettleBills({ db, clock, queue, logger, runs: fakeRuns(), platforms });
        expect(byKey(queue.sent.map(sendView)), now).toStrictEqual(
          byKey([APP, OTHER].flatMap((app) => platforms.map((p) => billSend(app, p, day)))),
        );
        expect(queue.sent.every((job) => job.options.trx === null && !job.inTransaction)).toBe(
          true,
        );
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04ze#11] 补种的 D 是时钟所在的 +08:00 自然日：07-23 23:59:59.999 +08:00 给 07-23，07-24 00:00 +08:00 给 07-24（跨 UTC 零点不受影响）',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await seedOrder(db, APP, TAOBAO);
      const { logger } = memoryLogger();
      const cases: [string, string][] = [
        ['2032-07-23T15:59:59.999Z', '2032-07-23'],
        ['2032-07-23T16:00:00.000Z', BILL_DAY],
        ['2032-07-24T00:00:00.000Z', BILL_DAY],
        ['2032-07-24T15:59:59.999Z', BILL_DAY],
        ['2032-12-31T16:30:00.000Z', '2033-01-01'],
      ];
      for (const [now, day] of cases) {
        const queue = fakeQueue();
        await seedSettleBills({
          db,
          clock: new FixedClock(now),
          queue,
          logger,
          runs: fakeRuns(),
          platforms: [TAOBAO],
        });
        expect(queue.sent.map(sendView), now).toStrictEqual([billSend(APP, TAOBAO, day)]);
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04ze#12] 补种按运行状态取舍：每个 (app, 平台, D) 都问状态存储；done 或 pending 不送，absent 才送；新进程（新的调用）判定相同',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await seedOrder(db, APP, TAOBAO);
      await seedOrder(db, OTHER, JD);
      const runs = fakeRuns();
      runs.states.set(billKey(APP, TAOBAO, BILL_DAY), 'done');
      runs.states.set(billKey(APP, JD, BILL_DAY), 'pending');
      runs.states.set(billKey(OTHER, TAOBAO, BILL_DAY), 'absent');
      const { logger } = memoryLogger();
      const clock = new FixedClock(BILL_DAY_NOW);
      const platforms = [TAOBAO, JD];

      for (let round = 0; round < 2; round += 1) {
        const queue = fakeQueue();
        await seedSettleBills({ db, clock, queue, logger, runs, platforms });
        expect(byKey(queue.sent.map(sendView)), `round ${String(round)}`).toStrictEqual(
          byKey([billSend(OTHER, TAOBAO, BILL_DAY), billSend(OTHER, JD, BILL_DAY)]),
        );
      }
      expect([...new Set(runs.reads)].sort()).toStrictEqual(
        [
          billKey(APP, TAOBAO, BILL_DAY),
          billKey(APP, JD, BILL_DAY),
          billKey(OTHER, TAOBAO, BILL_DAY),
          billKey(OTHER, JD, BILL_DAY),
        ].sort(),
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04ze#13] 一个 app 送失败不挡其他 app：其余照送，失败在全部试完后抛出；下次补种再送',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await seedOrder(db, APP, TAOBAO);
      await seedOrder(db, OTHER, TAOBAO);
      await seedOrder(db, THIRD, TAOBAO);
      const { logger } = memoryLogger();
      const clock = new FixedClock(BILL_DAY_NOW);
      const queue = fakeQueue();
      queue.failing.add(OTHER);
      const error = await rejection(() =>
        seedSettleBills({ db, clock, queue, logger, runs: fakeRuns(), platforms: [TAOBAO] }),
      );
      expect(messages(error)).toContain('synthetic send failure');
      expect(byKey(queue.sent.map(sendView))).toStrictEqual(
        byKey([billSend(APP, TAOBAO, BILL_DAY), billSend(THIRD, TAOBAO, BILL_DAY)]),
      );

      queue.failing.clear();
      const again = fakeQueue();
      await seedSettleBills({
        db,
        clock,
        queue: again,
        logger,
        runs: fakeRuns(),
        platforms: [TAOBAO],
      });
      expect(again.sent.map(sendView)).toContainEqual(billSend(OTHER, TAOBAO, BILL_DAY));
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04ze#14] 运行状态存储（pg-boss + settle_jobs）：未送 absent；排队、执行中、等待重试 pending；完成 done；失败进 settle.dead 或被取消 absent（死信副本不算 pending）；别的平台 / 别的日子互不影响',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const runs = createSettleRunStore(db);
      await withRealQueue(db, async (queue) => {
        expect(await runs.billStateOf(APP, TAOBAO, BILL_DAY)).toBe('absent');
        await scheduleSettleBill(queue, null, {
          appId: APP,
          platform: TAOBAO,
          accountingDate: BILL_DAY,
        });
        const [job] = await jobsUnder(db, billKey(APP, TAOBAO, BILL_DAY));
        expect(job?.state).toBe('created');
        const id = job?.id ?? '';
        expect(await runs.billStateOf(APP, TAOBAO, BILL_DAY)).toBe('pending');
        // Other platform, other day, other app: untouched.
        expect(await runs.billStateOf(APP, JD, BILL_DAY)).toBe('absent');
        expect(await runs.billStateOf(APP, TAOBAO, PLAIN_DAY)).toBe('absent');
        expect(await runs.billStateOf(OTHER, TAOBAO, BILL_DAY)).toBe('absent');

        await transition(db, id, 'active');
        expect(await runs.billStateOf(APP, TAOBAO, BILL_DAY)).toBe('pending');
        await transition(db, id, 'retry');
        expect(await runs.billStateOf(APP, TAOBAO, BILL_DAY)).toBe('pending');
        await failToDead(db, id);
        expect(await runs.billStateOf(APP, TAOBAO, BILL_DAY)).toBe('absent');

        await scheduleSettleBill(queue, null, {
          appId: APP,
          platform: JD,
          accountingDate: BILL_DAY,
        });
        const [jd] = await liveJobsUnder(db, billKey(APP, JD, BILL_DAY));
        await transition(db, jd?.id ?? '', 'cancelled');
        expect(await runs.billStateOf(APP, JD, BILL_DAY)).toBe('absent');

        await scheduleSettleBill(queue, null, {
          appId: OTHER,
          platform: PDD,
          accountingDate: BILL_DAY,
        });
        const [pdd] = await liveJobsUnder(db, billKey(OTHER, PDD, BILL_DAY));
        await transition(db, pdd?.id ?? '', 'active');
        await transition(db, pdd?.id ?? '', 'completed');
        expect(await runs.billStateOf(OTHER, PDD, BILL_DAY)).toBe('done');
        expect(await runs.billStateOf(OTHER, PDD, PLAIN_DAY)).toBe('absent');
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04ze#15] 持久完成：settle_jobs 有 (app, bill, 平台, D 00:00 +08:00) 的 done 行即 done（队列里没有任务也一样）；failed 行不算完成；别的 run_at（如补充批次顺延 1 ms）或别的平台的 done 行不算',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const runs = createSettleRunStore(db);
      await seedSettleJob(db, APP, TAOBAO, BILL_DAY_START, 'done');
      await seedSettleJob(db, APP, JD, BILL_DAY_START, 'failed');
      // The supplement's key on the bill day (D10-280 ①): the nominal instant shifted by 1 ms.
      await seedSettleJob(db, APP, PDD, '2032-07-23T16:00:00.001Z', 'done');
      await seedSettleJob(db, OTHER, JD, BILL_DAY_START, 'done');

      expect(await runs.billStateOf(APP, TAOBAO, BILL_DAY)).toBe('done');
      expect(await runs.billStateOf(APP, JD, BILL_DAY)).toBe('absent');
      expect(await runs.billStateOf(APP, PDD, BILL_DAY)).toBe('absent');
      expect(await runs.billStateOf(OTHER, TAOBAO, BILL_DAY)).toBe('absent');
      expect(await runs.billStateOf(OTHER, JD, BILL_DAY)).toBe('done');
      // A fresh store (a restarted worker) answers the same.
      expect(await createSettleRunStore(db).billStateOf(APP, TAOBAO, BILL_DAY)).toBe('done');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04ze#16] 补种在真实队列上去重：连续两次补种每个键只有 1 个排队任务（第二次不再送）；任务完成后不再送；任务失败进死信后下一次补种重新送',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await seedOrder(db, APP, TAOBAO);
      const runs = createSettleRunStore(db);
      const { logger } = memoryLogger();
      const clock = new FixedClock(BILL_DAY_NOW);
      const platforms = [TAOBAO, JD];
      await withRealQueue(db, async (queue) => {
        await seedSettleBills({ db, clock, queue, logger, runs, platforms });
        await seedSettleBills({ db, clock, queue, logger, runs, platforms });
        expect(queue.sent).toHaveLength(2);
        expect(await liveJobsUnder(db, billKey(APP, TAOBAO, BILL_DAY))).toHaveLength(1);
        expect(await liveJobsUnder(db, billKey(APP, JD, BILL_DAY))).toHaveLength(1);
        const [taobao] = await liveJobsUnder(db, billKey(APP, TAOBAO, BILL_DAY));
        expect(taobao?.payload).toStrictEqual({
          app_id: APP,
          platform: TAOBAO,
          accounting_date: BILL_DAY,
        });

        await transition(db, taobao?.id ?? '', 'active');
        await transition(db, taobao?.id ?? '', 'completed');
        const [jd] = await liveJobsUnder(db, billKey(APP, JD, BILL_DAY));
        await failToDead(db, jd?.id ?? '');

        await seedSettleBills({ db, clock, queue, logger, runs, platforms });
        expect(queue.sent.slice(2).map(sendView)).toStrictEqual([billSend(APP, JD, BILL_DAY)]);
        expect(await liveJobsUnder(db, billKey(APP, TAOBAO, BILL_DAY))).toHaveLength(0);
        expect(await liveJobsUnder(db, billKey(APP, JD, BILL_DAY))).toHaveLength(1);
      });
    });
  },
  TIMEOUT,
);
