// B2-02r: one heal of the daily chain decides per (app, D) from the actual state the run store
// reports (task brief §9.2), not from what this process sent before: absent (never queued, failed,
// dead-lettered, cancelled) → the job of (app, D) is sent again; pending (queued / active / waiting
// for a retry) or done → nothing. An (app, D) not done at dailyCheckOverdueAtMs(D) is alerted once
// (pino line, event ledger_daily_check_overdue), also across restarts. The run store here is an
// in-memory stand-in for the database, shared by every heal call ("restarts" share nothing else);
// the apps come from PostgreSQL (ledger_accounts), the queue is a recorder.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  dailyCheckOverdueAtMs,
  dailyCheckRunAtMs,
  healDailyCheck,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  APP,
  DAY,
  HOUR_MS,
  NEXT_DAY,
  NEXT_RUN_AT,
  OTHER,
  OVERDUE_EVENT,
  RUN_AT,
  THIRD,
  TIMEOUT,
  expectedSend,
  fakeQueue,
  fakeRuns,
  iso,
  keyOf,
  memoryLogger,
  messages,
  overdueLines,
  rejection,
  sendView,
  sentFor,
  userAccount,
  withDatabase,
} from './kit.ts';

it(
  '[AC-B2-02r#1] 修复按 (app, D) 的实际状态判定：absent 照常入队，pending / done 不送；同一进程里送过的 (app, D) 进死信后下一次修复照常再送，完成后不再送，重启后同样',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const clock = new FixedClock(RUN_AT);
      await userAccount(db, clock, APP);
      await userAccount(db, clock, OTHER);
      await userAccount(db, clock, THIRD);
      const runs = fakeRuns();
      runs.states.set(keyOf(OTHER, DAY), 'pending');
      runs.states.set(keyOf(THIRD, DAY), 'done');
      const queue = fakeQueue();
      const { logger } = memoryLogger();
      const heal = () => healDailyCheck({ db, clock, queue, logger, runs });

      await heal();
      expect(queue.sent.map(sendView)).toStrictEqual([expectedSend(APP, DAY, 0)]);
      expect(runs.reads).toEqual(
        expect.arrayContaining([keyOf(APP, DAY), keyOf(OTHER, DAY), keyOf(THIRD, DAY)]),
      );

      // APP's job is queued: the next heal leaves it alone.
      runs.states.set(keyOf(APP, DAY), 'pending');
      await heal();
      expect(queue.sent).toHaveLength(1);

      // Retries exhausted, the job went to ledger-check.dead: same process, sent again.
      runs.states.set(keyOf(APP, DAY), 'absent');
      await heal();
      expect(sentFor(queue, APP).map(sendView)).toStrictEqual([
        expectedSend(APP, DAY, 0),
        expectedSend(APP, DAY, 0),
      ]);
      // A second dead letter of the same day: sent once more (no "already started" memory).
      await heal();
      expect(sentFor(queue, APP)).toHaveLength(3);

      // OTHER's queued job died too.
      runs.states.set(keyOf(OTHER, DAY), 'absent');
      runs.states.set(keyOf(APP, DAY), 'done');
      await heal();
      expect(sentFor(queue, OTHER).map(sendView)).toStrictEqual([expectedSend(OTHER, DAY, 0)]);
      expect(sentFor(queue, APP)).toHaveLength(3);

      // A restarted process (new queue, new logger, nothing remembered): done and pending stay
      // untouched, only what is absent is sent.
      runs.states.set(keyOf(OTHER, DAY), 'pending');
      const restarted = fakeQueue();
      await healDailyCheck({ db, clock, queue: restarted, logger: memoryLogger().logger, runs });
      expect(restarted.sent).toStrictEqual([]);
      expect(sentFor(queue, THIRD)).toStrictEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02r#2] 修复的 D 是时钟所在 +08:00 日的前一天：01:00 前送出时延迟到 01:00；到了下一天只看新的 D，链上已排好的下一天（pending）不重复送，旧的 D 不回补',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      // 2032-06-16 00:30 +08:00.
      const clock = new FixedClock('2032-06-15T16:30:00.000Z');
      await userAccount(db, clock, APP);
      await userAccount(db, clock, OTHER);
      const runs = fakeRuns();
      const queue = fakeQueue();
      const { logger } = memoryLogger();
      await healDailyCheck({ db, clock, queue, logger, runs });
      expect(sentFor(queue, APP).map(sendView)).toStrictEqual([expectedSend(APP, DAY, 1_800)]);
      expect(sentFor(queue, OTHER).map(sendView)).toStrictEqual([expectedSend(OTHER, DAY, 1_800)]);

      // The next day: APP's run of DAY completed and queued NEXT_DAY; OTHER's DAY died and was
      // never re-run (its chain is broken), so NEXT_DAY is absent for OTHER.
      runs.states.set(keyOf(APP, DAY), 'done');
      runs.states.set(keyOf(APP, NEXT_DAY), 'pending');
      clock.set(NEXT_RUN_AT);
      const later = fakeQueue();
      await healDailyCheck({ db, clock, queue: later, logger, runs });
      expect(later.sent.map(sendView)).toStrictEqual([expectedSend(OTHER, NEXT_DAY, 0)]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02r#3] 一个 app 送失败不挡其他 app，失败在全部试完后抛出；下一次修复（不靠进程记忆）把失败的 app 补上',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const clock = new FixedClock(RUN_AT);
      await userAccount(db, clock, APP);
      await userAccount(db, clock, OTHER);
      const runs = fakeRuns();
      const queue = fakeQueue();
      const { logger } = memoryLogger();

      queue.failing.add(APP);
      const error = await rejection(healDailyCheck({ db, clock, queue, logger, runs }));
      expect(messages(error)).toContain('synthetic send failure');
      expect(queue.sent.map(sendView)).toStrictEqual([expectedSend(OTHER, DAY, 0)]);

      runs.states.set(keyOf(OTHER, DAY), 'pending');
      queue.failing.clear();
      await healDailyCheck({ db, clock, queue, logger, runs });
      expect(queue.sent.map(sendView)).toStrictEqual([
        expectedSend(OTHER, DAY, 0),
        expectedSend(APP, DAY, 0),
      ]);
    });
  },
  TIMEOUT,
);

it('[AC-B2-02r#4] 断链告警的时刻：D+1 01:00 +08:00 之后一个固定宽限（同一宽限适用于每一天，且早于 D+1 结束）', () => {
  const days = [DAY, NEXT_DAY, '2032-06-30', '2032-12-31', '2032-02-29'];
  const graces = days.map((day) => dailyCheckOverdueAtMs(day) - dailyCheckRunAtMs(day));
  for (const [index, grace] of graces.entries()) {
    expect(grace, days[index]).toBeGreaterThan(0);
    // D+1 ends 23 hours after its 01:00.
    expect(grace, days[index]).toBeLessThan(23 * HOUR_MS);
    expect(grace, days[index]).toBe(graces[0]);
  }
});

it(
  '[AC-B2-02r#5] 断链告警：到期未完成的 (app, D)（absent 或仍 pending）在宽限到时告警 1 次（error，event ledger_daily_check_overdue，带 app_id 与 D，不带个人信息）；宽限前不告警，已完成的不告警；之后的修复与重启都不再告警，absent 的照常再送',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const clock = new FixedClock(RUN_AT);
      const absent = await userAccount(db, clock, APP);
      const pending = await userAccount(db, clock, OTHER);
      const done = await userAccount(db, clock, THIRD);
      const runs = fakeRuns();
      runs.states.set(keyOf(OTHER, DAY), 'pending');
      runs.states.set(keyOf(THIRD, DAY), 'done');
      const queue = fakeQueue();
      const memory = memoryLogger();
      const heal = () => healDailyCheck({ db, clock, queue, logger: memory.logger, runs });
      const overdueAt = dailyCheckOverdueAtMs(DAY);

      clock.set(RUN_AT);
      await heal();
      clock.set(iso(overdueAt - 1));
      await heal();
      expect(overdueLines(memory.lines)).toStrictEqual([]);

      clock.set(iso(overdueAt));
      await heal();
      const alerts = overdueLines(memory.lines);
      expect(alerts.map((line) => line.fields['app_id']).sort()).toStrictEqual([APP, OTHER]);
      for (const line of alerts) {
        expect(line.level).toBe('error');
        expect(line.fields).toMatchObject({ event: OVERDUE_EVENT, accounting_date: DAY });
        const text = JSON.stringify(line);
        for (const account of [absent, pending, done]) {
          expect(text).not.toContain(account.userId);
          expect(text).not.toContain(account.accountId);
        }
        for (const key of ['user_id', 'account_id', 'nickname', 'phone', 'mobile']) {
          expect(Object.keys(line.fields)).not.toContain(key);
        }
      }
      // The absent run is still sent again at every heal; the pending and the done one never.
      expect(sentFor(queue, APP).map(sendView)).toStrictEqual([
        expectedSend(APP, DAY, 0),
        expectedSend(APP, DAY, 0),
        expectedSend(APP, DAY, 0),
      ]);
      expect([...sentFor(queue, OTHER), ...sentFor(queue, THIRD)]).toStrictEqual([]);

      // Later heals of this process, and a restarted one: no second alert of (APP|OTHER, DAY).
      clock.set(iso(overdueAt + 60_000));
      await heal();
      const restarted = memoryLogger();
      await healDailyCheck({ db, clock, queue: fakeQueue(), logger: restarted.logger, runs });
      expect(overdueLines(memory.lines)).toHaveLength(2);
      expect(overdueLines(restarted.lines)).toStrictEqual([]);
      expect(sentFor(queue, APP)).toHaveLength(4);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02r#6] 告警按 (app, D) 各 1 次：同一 app 的下一天到期未完成时另告警 1 次；他 app 已告警不影响本 app',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const clock = new FixedClock(RUN_AT);
      await userAccount(db, clock, APP);
      await userAccount(db, clock, OTHER);
      const runs = fakeRuns();
      runs.states.set(keyOf(OTHER, DAY), 'done');
      const memory = memoryLogger();
      const heal = () =>
        healDailyCheck({ db, clock, queue: fakeQueue(), logger: memory.logger, runs });

      clock.set(iso(dailyCheckOverdueAtMs(DAY)));
      await heal();
      expect(overdueLines(memory.lines).map((line) => line.fields['app_id'])).toStrictEqual([APP]);

      // DAY of APP finally completed; NEXT_DAY of both apps is overdue the next day.
      runs.states.set(keyOf(APP, DAY), 'done');
      clock.set(iso(dailyCheckOverdueAtMs(NEXT_DAY)));
      await heal();
      await heal();
      const alerts = overdueLines(memory.lines).map((line) => [
        line.fields['app_id'],
        line.fields['accounting_date'],
      ]);
      expect(alerts.slice(0, 1)).toStrictEqual([[APP, DAY]]);
      expect(alerts.slice(1).sort()).toStrictEqual([
        [APP, NEXT_DAY],
        [OTHER, NEXT_DAY],
      ]);
    });
  },
  TIMEOUT,
);
