// B2-02s: the run store (infra createDailyCheckRunStore) reads the completion record first (task
// brief §9.2). An (app, D) with its record (consumer ledger.daily_check_done, event_id
// dailyCheckDoneEventId(app, D)) is 'done' whatever the queue holds under its key — only a failed
// job and its ledger-check.dead copy, a cancelled one, none at all, or a job queued / waiting to be
// run again. Without its record stateOf answers as in B2-02r: never queued, failed (dead-lettered)
// or cancelled → absent; queued or waiting for a retry → pending. Records of other apps or days,
// and a row of another consumer with the same event_id (the overdue alert claim), are not its
// record. pg-boss on the test database holds the jobs; the record a finished earlier run left
// behind is written directly. A new store instance (a restarted worker) answers the same.
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
  OVERDUE_ALERT_CONSUMER,
  RUN_AT,
  THIRD,
  TIMEOUT,
  deadCopies,
  failToDead,
  liveJob,
  markDone,
  statesOf,
  transition,
  withDatabase,
  withRealQueue,
  writeRecord,
} from './kit.ts';

it(
  '[AC-B2-02s#4] stateOf 先认完成记录：(app, D) 有完成记录即 done——该 key 只有 failed 及其死信副本、被取消、从未入队、或又有一次排队 / 等待重试时都是 done；新实例同样',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await withRealQueue(db, async (queue) => {
        const clock = new FixedClock(RUN_AT);
        const runs = createDailyCheckRunStore(db);

        // The attempt that finished the work was judged failed afterwards (expireInSeconds) and
        // its copy went to ledger-check.dead.
        await scheduleDailyCheck(queue, null, APP, DAY, clock.now());
        const first = await liveJob(db, APP, DAY);
        await transition(db, first.id, 'active');
        await failToDead(db, first.id);
        expect(await deadCopies(db, APP, DAY)).toBe(1);
        expect(await runs.stateOf(APP, DAY)).toBe('absent');
        await markDone(db, APP, DAY);
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed']);
        expect(await runs.stateOf(APP, DAY)).toBe('done');
        expect(await createDailyCheckRunStore(db).stateOf(APP, DAY)).toBe('done');

        // Another job of the key queued, then waiting to be run again, then cancelled: still done.
        await scheduleDailyCheck(queue, null, APP, DAY, clock.now());
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed', 'created']);
        expect(await runs.stateOf(APP, DAY)).toBe('done');
        const second = await liveJob(db, APP, DAY);
        await transition(db, second.id, 'active');
        await transition(db, second.id, 'retry');
        expect(await runs.stateOf(APP, DAY)).toBe('done');
        await transition(db, second.id, 'cancelled');
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed', 'cancelled']);
        expect(await runs.stateOf(APP, DAY)).toBe('done');

        // A record without any job of its key (the queue's rows were archived or never seen here).
        await markDone(db, OTHER, NEXT_DAY);
        expect(await statesOf(db, OTHER, NEXT_DAY)).toStrictEqual([]);
        expect(await runs.stateOf(OTHER, NEXT_DAY)).toBe('done');

        // A restarted worker: the same answers, from the database only.
        const restarted = createDailyCheckRunStore(db);
        expect(await restarted.stateOf(APP, DAY)).toBe('done');
        expect(await restarted.stateOf(OTHER, NEXT_DAY)).toBe('done');
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02s#5] 没有本 (app, D) 的完成记录时 stateOf 同 B2-02r：从未入队、死信、被取消是 absent，排队与等待重试是 pending；别的 app、别的 D 的完成记录与同 event_id 的断链告警认领都不算本 (app, D) 完成',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await withRealQueue(db, async (queue) => {
        const clock = new FixedClock(RUN_AT);
        const runs = createDailyCheckRunStore(db);
        // Records of the neighbours of (APP, DAY), and B2-02r's alert claim of (APP, DAY) itself.
        await markDone(db, OTHER, DAY);
        await markDone(db, APP, NEXT_DAY);
        expect(await runs.claimOverdueAlert(APP, DAY)).toBe(true);
        // A row of another consumer that happens to carry the completion event_id of (APP, DAY).
        await writeRecord(db, OVERDUE_ALERT_CONSUMER, APP, DAY);

        expect(await runs.stateOf(APP, DAY)).toBe('absent');
        await scheduleDailyCheck(queue, null, APP, DAY, clock.now());
        expect(await runs.stateOf(APP, DAY)).toBe('pending');
        const first = await liveJob(db, APP, DAY);
        await transition(db, first.id, 'active');
        expect(await runs.stateOf(APP, DAY)).toBe('pending');
        await transition(db, first.id, 'retry');
        expect(await runs.stateOf(APP, DAY)).toBe('pending');
        await failToDead(db, first.id);
        expect(await runs.stateOf(APP, DAY)).toBe('absent');
        await scheduleDailyCheck(queue, null, APP, DAY, clock.now());
        await transition(db, (await liveJob(db, APP, DAY)).id, 'cancelled');
        expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed', 'cancelled']);
        expect(await runs.stateOf(APP, DAY)).toBe('absent');

        // The neighbours are done by their own records; a key with nothing is absent.
        expect(await runs.stateOf(OTHER, DAY)).toBe('done');
        expect(await runs.stateOf(APP, NEXT_DAY)).toBe('done');
        expect(await runs.stateOf(THIRD, DAY)).toBe('absent');
        expect(await createDailyCheckRunStore(db).stateOf(APP, DAY)).toBe('absent');
      });
    });
  },
  TIMEOUT,
);
