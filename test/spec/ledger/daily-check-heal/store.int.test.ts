// B2-02r: the run store over PostgreSQL (infra createDailyCheckRunStore). stateOf reports the
// actual state of (app, D) from the queue and the results (task brief §9.2): pg-boss on the test
// database holds the `daily` jobs (sent through the B2-02q scheduleDailyCheck), and the state
// changes a worker makes (active, to run again, exhausted into ledger-check.dead, cancelled) are
// written as plain SQL; a completed run is the B2-02q handler actually run, then completed. Nothing
// is remembered in memory: a new store instance (a restarted worker) answers the same.
// claimOverdueAlert is durable and has one winner.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  createDailyCheckRunStore,
  scheduleDailyCheck,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  APP,
  DAY,
  NEXT_DAY,
  OTHER,
  RUN_AT,
  THIRD,
  TIMEOUT,
  completeRun,
  deadCopies,
  failToDead,
  liveJob,
  memoryLogger,
  statesOf,
  transition,
  withDatabase,
  withRealQueue,
} from './kit.ts';

it(
  '[AC-B2-02r#7] stateOf 跟随队列与结果：从未入队 absent；排队（含延迟）、进行中、等待重试都是 pending；重试耗尽进死信（ledger-check.dead 里的副本不算）、被取消都是 absent；跑完是 done；新实例答案相同',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await withRealQueue(db, async (queue) => {
        // 2032-06-16 00:30 +08:00: the job of DAY is deferred to 01:00.
        const clock = new FixedClock('2032-06-15T16:30:00.000Z');
        const { logger } = memoryLogger();
        const runs = createDailyCheckRunStore(db);
        const state = () => runs.stateOf(APP, DAY);

        expect(await state()).toBe('absent');

        await scheduleDailyCheck(queue, null, APP, DAY, clock.now());
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['created']);
        expect(await state()).toBe('pending');

        const first = await liveJob(db, APP, DAY);
        await transition(db, first.id, 'active');
        expect(await state()).toBe('pending');
        await transition(db, first.id, 'retry');
        expect(await state()).toBe('pending');

        await failToDead(db, first.id);
        expect(await deadCopies(db, APP, DAY)).toBe(1);
        expect(await state()).toBe('absent');

        await scheduleDailyCheck(queue, null, APP, DAY, clock.now());
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed', 'created']);
        expect(await state()).toBe('pending');
        await transition(db, (await liveJob(db, APP, DAY)).id, 'cancelled');
        expect(await state()).toBe('absent');

        clock.set(RUN_AT);
        await scheduleDailyCheck(queue, null, APP, DAY, clock.now());
        await completeRun(db, clock, queue, logger, APP, DAY);
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed', 'cancelled', 'completed']);
        expect(await state()).toBe('done');
        // A new instance: the same answers, from the database only.
        const restarted = createDailyCheckRunStore(db);
        expect(await restarted.stateOf(APP, DAY)).toBe('done');
        // The completed run queued the next day; other apps and days are their own.
        expect(await statesOf(db, APP, NEXT_DAY)).toStrictEqual(['created']);
        expect(await restarted.stateOf(APP, NEXT_DAY)).toBe('pending');
        expect(await restarted.stateOf(OTHER, DAY)).toBe('absent');
        expect(await restarted.stateOf(THIRD, NEXT_DAY)).toBe('absent');
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02r#8] 一个 (app, D) 的死信不影响别的 key：他 app 同一天的任务仍 pending，本 app 已完成的前一天仍 done',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await withRealQueue(db, async (queue) => {
        const clock = new FixedClock(RUN_AT);
        const { logger } = memoryLogger();
        const runs = createDailyCheckRunStore(db);
        await scheduleDailyCheck(queue, null, APP, DAY, clock.now());
        await scheduleDailyCheck(queue, null, OTHER, DAY, clock.now());
        await completeRun(db, clock, queue, logger, APP, DAY);
        // APP's chain queued NEXT_DAY; that job dies.
        await failToDead(db, (await liveJob(db, APP, NEXT_DAY)).id);

        expect(await runs.stateOf(APP, NEXT_DAY)).toBe('absent');
        expect(await runs.stateOf(APP, DAY)).toBe('done');
        expect(await runs.stateOf(OTHER, DAY)).toBe('pending');
        expect(await runs.stateOf(OTHER, NEXT_DAY)).toBe('absent');
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02r#9] claimOverdueAlert 持久且只有一个赢家：同一 (app, D) 首次 true、之后 false，新实例（重启）也 false；别的 app 或别的 D 各自首次 true；并发争同一 (app, D) 恰 1 个 true',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const first = createDailyCheckRunStore(db);
      expect(await first.claimOverdueAlert(APP, DAY)).toBe(true);
      expect(await first.claimOverdueAlert(APP, DAY)).toBe(false);
      const restarted = createDailyCheckRunStore(db);
      expect(await restarted.claimOverdueAlert(APP, DAY)).toBe(false);
      expect(await restarted.claimOverdueAlert(OTHER, DAY)).toBe(true);
      expect(await first.claimOverdueAlert(APP, NEXT_DAY)).toBe(true);
      expect(await first.claimOverdueAlert(OTHER, DAY)).toBe(false);

      const racers = [1, 2, 3, 4].map(() => createDailyCheckRunStore(db));
      const results = await Promise.all(racers.map((store) => store.claimOverdueAlert(THIRD, DAY)));
      expect(results.filter((won) => won)).toHaveLength(1);
      expect(await first.claimOverdueAlert(THIRD, DAY)).toBe(false);
    });
  },
  TIMEOUT,
);
