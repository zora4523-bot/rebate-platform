// B2-02s end to end on pg-boss (task brief §9.1 / §9.2): the B2-02q handler, the B2-02r run store and
// heal. The attempt of (app, D) runs to the end — the check, the execution step, D+1 enqueued and
// the completion record written — but the queue judges it failed afterwards (it took longer than
// ledger-check's expireInSeconds) and its copy goes to ledger-check.dead. That (app, D) is done:
// no later heal, nor a restarted one, queues it again, and it is not alerted as overdue; the chain's
// D+1 stays a single job. An app whose attempt threw before the end leaves no record and is healed
// as in B2-02r (sent again, alerted once when overdue). A re-delivery of a finished attempt (the
// queue runs an expired attempt again while attempts are left) adds no record and no second D+1.
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
  OTHER,
  RUN_AT,
  TIMEOUT,
  attempt,
  attemptThenDead,
  broken,
  cleanFiles,
  deadCopies,
  doneRecords,
  failToDead,
  iso,
  ledgerCodes,
  liveJob,
  memoryLogger,
  messages,
  overdueLines,
  sentFor,
  statesOf,
  transition,
  userAccount,
  withDatabase,
  withRealQueue,
  type FakeQueue,
  type LogLine,
} from './kit.ts';

/** The sends of (app, D) recorded on the queue. */
function sendsOf(queue: FakeQueue, appId: string, day: string) {
  return sentFor(queue, appId).filter((job) => job.payload['accounting_date'] === day);
}

/** The (app_id, D) of every overdue alert line. */
function overduePairs(lines: readonly LogLine[]): unknown[][] {
  return overdueLines(lines).map((line) => [line.fields['app_id'], line.fields['accounting_date']]);
}

/** Invariant files breaking the output contract: the check itself fails. */
function brokenFiles() {
  return [broken('03_fixture-broken.sql', '03')];
}

it(
  '[AC-B2-02s#6] 处理跑完但该次尝试被判 failed 进死信（超过 expireInSeconds）：(app, D) 是 done，之后的修复与重启后的修复都不再入队，到期也不告警，链上的 D+1 只有 1 个；没跑完就进死信的 app 不留完成记录，照常再入队并告警 1 次',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await withRealQueue(db, async (queue) => {
        const clock = new FixedClock(RUN_AT);
        await userAccount(db, clock, APP);
        await userAccount(db, clock, OTHER);
        const first = memoryLogger();
        const { logger } = first;
        const runs = createDailyCheckRunStore(db);
        const heal = () => healDailyCheck({ db, clock, queue, logger, runs });

        await heal();
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['created']);
        expect(await statesOf(db, OTHER, DAY)).toStrictEqual(['created']);

        // APP: the attempt finishes its work, then the queue judges it failed (expired).
        const ran = await attemptThenDead(db, clock, queue, logger, APP, DAY, cleanFiles);
        expect(ran).toBeNull();
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed']);
        expect(await deadCopies(db, APP, DAY)).toBe(1);
        expect(await statesOf(db, APP, NEXT_DAY)).toStrictEqual(['created']);
        expect(await doneRecords(db, APP, DAY)).toBe(1);

        // OTHER: the attempt throws before the end (the check fails), then dies the same way.
        const failed = await attemptThenDead(db, clock, queue, logger, OTHER, DAY, brokenFiles);
        expect(ledgerCodes(failed), messages(failed)).toContain('DAILY_CHECK_FAILED');
        expect(await statesOf(db, OTHER, DAY)).toStrictEqual(['failed']);
        expect(await statesOf(db, OTHER, NEXT_DAY)).toStrictEqual([]);
        expect(await doneRecords(db, OTHER, DAY)).toBe(0);

        expect(await runs.stateOf(APP, DAY)).toBe('done');
        expect(await runs.stateOf(OTHER, DAY)).toBe('absent');

        // The next heal re-sends OTHER only.
        await heal();
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed']);
        expect(await statesOf(db, OTHER, DAY)).toStrictEqual(['failed', 'created']);

        // Overdue: OTHER (not done) is alerted once; the finished APP is not.
        clock.set(iso(dailyCheckOverdueAtMs(DAY)));
        await heal();
        expect(overduePairs(first.lines)).toStrictEqual([[OTHER, DAY]]);
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed']);

        // A restarted worker heals later: nothing for APP, no alert at all.
        clock.set(iso(dailyCheckOverdueAtMs(DAY) + 60_000));
        const second = memoryLogger();
        await healDailyCheck({
          db,
          clock,
          queue,
          logger: second.logger,
          runs: createDailyCheckRunStore(db),
        });
        expect(overduePairs(second.lines)).toStrictEqual([]);
        expect(overduePairs(first.lines)).toStrictEqual([[OTHER, DAY]]);
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed']);
        expect(sendsOf(queue, APP, DAY)).toHaveLength(1);
        expect(await statesOf(db, APP, NEXT_DAY)).toStrictEqual(['created']);
        expect(sendsOf(queue, APP, NEXT_DAY)).toHaveLength(1);
        expect(await doneRecords(db, APP, DAY)).toBe(1);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02s#7] 跑完的尝试超时后队列再投（还有剩余次数）：等待再跑期间已是 done；再跑一遍不报错，完成记录仍 1 条、D+1 仍只 1 个；之后该任务进死信，(app, D) 仍是 done，修复不再入队、到期不告警',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await withRealQueue(db, async (queue) => {
        const clock = new FixedClock(RUN_AT);
        await userAccount(db, clock, APP);
        const memory = memoryLogger();
        const { logger } = memory;
        const runs = createDailyCheckRunStore(db);
        const heal = () => healDailyCheck({ db, clock, queue, logger, runs });

        await heal();
        const job = await liveJob(db, APP, DAY);
        expect(await attempt(db, clock, queue, logger, APP, DAY, cleanFiles)).toBeNull();
        expect(await doneRecords(db, APP, DAY)).toBe(1);

        // The attempt expired with attempts left: it waits to be run again.
        await transition(db, job.id, 'retry');
        expect(await runs.stateOf(APP, DAY)).toBe('done');
        await heal();
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['retry']);

        // Run again (the attempt is left active): same outcome, nothing added.
        expect(await attempt(db, clock, queue, logger, APP, DAY, cleanFiles)).toBeNull();
        expect(await doneRecords(db, APP, DAY)).toBe(1);
        expect(await statesOf(db, APP, NEXT_DAY)).toStrictEqual(['created']);

        // Expired again with no attempts left: failed, its copy in ledger-check.dead.
        await failToDead(db, job.id);
        expect(await deadCopies(db, APP, DAY)).toBe(1);
        expect(await runs.stateOf(APP, DAY)).toBe('done');

        clock.set(iso(dailyCheckOverdueAtMs(DAY)));
        await heal();
        const restarted = memoryLogger();
        await healDailyCheck({
          db,
          clock,
          queue,
          logger: restarted.logger,
          runs: createDailyCheckRunStore(db),
        });
        expect(overdueLines(memory.lines)).toStrictEqual([]);
        expect(overdueLines(restarted.lines)).toStrictEqual([]);
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed']);
        expect(sendsOf(queue, APP, DAY)).toHaveLength(1);
        expect(await statesOf(db, APP, NEXT_DAY)).toStrictEqual(['created']);
      });
    });
  },
  TIMEOUT,
);
