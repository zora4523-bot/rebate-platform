// B2-02r end to end on pg-boss (task brief §9.2): healDailyCheck over the real run store and a real
// queue. The `daily` job of (app, D) exhausts its retries into ledger-check.dead → the next heal
// enqueues (app, D) again (the exclusive key is free); while that job is queued or retrying nothing
// more is sent; once it has run, the chain goes on (D+1 queued by the run) and neither a later heal
// nor a restarted one queues the completed (app, D) again. An (app, D) not done by its overdue
// instant is alerted once, not again after a restart; a completed one is never alerted.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  createDailyCheckRunStore,
  dailyCheckOverdueAtMs,
  healDailyCheck,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  APP,
  DAY,
  NEXT_DAY,
  NEXT_RUN_AT,
  OTHER,
  RUN_AT,
  TIMEOUT,
  completeRun,
  deadCopies,
  failToDead,
  iso,
  liveJob,
  memoryLogger,
  overdueLines,
  sentFor,
  statesOf,
  transition,
  userAccount,
  withDatabase,
  withRealQueue,
} from './kit.ts';

/** The sends of (app, D) recorded on the queue. */
function sendsOf(queue: Parameters<typeof sentFor>[0], appId: string, day: string) {
  return sentFor(queue, appId).filter((job) => job.payload['accounting_date'] === day);
}

it(
  '[AC-B2-02r#10] 死信后的修复与续排：进死信的 (app, D) 下一次修复重新入队；排队 / 重试中不再送；重跑完成后下一天已排上，之后的修复与重启后的修复都不再排已完成的 D，也不重复排链上的下一天',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await withRealQueue(db, async (queue) => {
        const clock = new FixedClock(RUN_AT);
        await userAccount(db, clock, APP);
        const { logger } = memoryLogger();
        const runs = createDailyCheckRunStore(db);
        const heal = () => healDailyCheck({ db, clock, queue, logger, runs });

        await heal();
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['created']);
        await heal();
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['created']);
        expect(sendsOf(queue, APP, DAY)).toHaveLength(1);

        // Retries exhausted: failed, its copy in ledger-check.dead.
        await failToDead(db, (await liveJob(db, APP, DAY)).id);
        expect(await deadCopies(db, APP, DAY)).toBe(1);
        await heal();
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed', 'created']);

        // The re-sent job fails once and waits to be run again: nothing more is sent.
        await transition(db, (await liveJob(db, APP, DAY)).id, 'retry');
        await heal();
        expect(sendsOf(queue, APP, DAY)).toHaveLength(2);
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed', 'retry']);

        // The retry succeeds: D is done and D+1 is queued by the run (the chain resumes).
        await completeRun(db, clock, queue, logger, APP, DAY);
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed', 'completed']);
        expect(await statesOf(db, APP, NEXT_DAY)).toStrictEqual(['created']);

        await heal();
        const restarted = createDailyCheckRunStore(db);
        await healDailyCheck({ db, clock, queue, logger: memoryLogger().logger, runs: restarted });
        expect(sendsOf(queue, APP, DAY)).toHaveLength(2);
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed', 'completed']);

        // The next day: the chain's job of D+1 is pending; the heal adds nothing.
        clock.set(NEXT_RUN_AT);
        await healDailyCheck({ db, clock, queue, logger, runs: createDailyCheckRunStore(db) });
        expect(await statesOf(db, APP, NEXT_DAY)).toStrictEqual(['created']);
        expect(sendsOf(queue, APP, NEXT_DAY)).toHaveLength(1);
        expect(sendsOf(queue, APP, NEXT_DAY)[0]!.inTransaction).toBe(true);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02r#11] 断链告警（真实存储）：进死信未重跑完成的 (app, D) 到期告警 1 次并照常再入队；重启后的修复不再告警；已完成的 app 不告警也不再入队',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await withRealQueue(db, async (queue) => {
        const clock = new FixedClock(RUN_AT);
        await userAccount(db, clock, APP);
        await userAccount(db, clock, OTHER);
        const first = memoryLogger();
        const runs = createDailyCheckRunStore(db);
        const heal = () => healDailyCheck({ db, clock, queue, logger: first.logger, runs });

        await heal();
        await completeRun(db, clock, queue, first.logger, OTHER, DAY);
        await failToDead(db, (await liveJob(db, APP, DAY)).id);

        clock.set(iso(dailyCheckOverdueAtMs(DAY)));
        await heal();
        expect(
          overdueLines(first.lines).map((line) => [
            line.fields['app_id'],
            line.fields['accounting_date'],
          ]),
        ).toStrictEqual([[APP, DAY]]);
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed', 'created']);
        expect(await statesOf(db, OTHER, DAY)).toStrictEqual(['completed']);

        // The re-sent job dies again; a restarted worker heals: sent again, not alerted again.
        await failToDead(db, (await liveJob(db, APP, DAY)).id);
        clock.set(iso(dailyCheckOverdueAtMs(DAY) + 60_000));
        const second = memoryLogger();
        await healDailyCheck({
          db,
          clock,
          queue,
          logger: second.logger,
          runs: createDailyCheckRunStore(db),
        });
        await heal();
        expect(overdueLines(second.lines)).toStrictEqual([]);
        expect(overdueLines(first.lines)).toHaveLength(1);
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed', 'failed', 'created']);
        expect(await statesOf(db, OTHER, DAY)).toStrictEqual(['completed']);
      });
    });
  },
  TIMEOUT,
);
