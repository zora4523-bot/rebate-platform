// B2-02q: the start and heal of the daily chain (task brief §9.2; payment bill.recon / payout-recon
// precedents): for every app with ledger accounts, one `daily` job of D−1 of the clock's +08:00 day,
// keyed per (app, D), due at that day's 01:00 +08:00 or at once when it has passed — a restart does
// not replay history, and the queued chain carries on from there. `started` (one per process)
// remembers the D each app was sent for; a failed send is retried by the next seed.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { seedDailyCheck } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  APP,
  DAY,
  NEXT_DAY,
  NEXT_RUN_AT,
  OTHER,
  RUN_AT,
  THIRD,
  TIMEOUT,
  expectedSend,
  fakeQueue,
  memoryLogger,
  messages,
  rejection,
  sendView,
  sentFor,
  userAccount,
  withDatabase,
} from './kit.ts';

it(
  '[AC-B2-02q#17] 补种：每个有账户的 app 各排 1 个 D−1 的任务（一个 app 多个账户也只 1 个），00:30 +08:00 补种时延迟到 01:00',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      // 2032-06-16 00:30 +08:00.
      const clock = new FixedClock('2032-06-15T16:30:00.000Z');
      await userAccount(db, clock, APP);
      await userAccount(db, clock, APP);
      await userAccount(db, clock, OTHER);
      const queue = fakeQueue();
      const { logger } = memoryLogger();
      await seedDailyCheck({ db, clock, queue, logger });
      expect(sentFor(queue, APP).map(sendView)).toStrictEqual([expectedSend(APP, DAY, 1_800)]);
      expect(sentFor(queue, OTHER).map(sendView)).toStrictEqual([expectedSend(OTHER, DAY, 1_800)]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02q#18] 补种时刻在当天 00:00、01:00 与 23:59 +08:00：D 都是前一天；01:00 前延迟到 01:00，01:00 及之后立即（重启不回补历史）',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const clock = new FixedClock(RUN_AT);
      await userAccount(db, clock, APP);
      const { logger } = memoryLogger();
      const cases: [string, string, number][] = [
        // 2032-06-16 00:00 +08:00
        ['2032-06-15T16:00:00.000Z', DAY, 3_600],
        // 2032-06-16 01:00 +08:00
        [RUN_AT, DAY, 0],
        // 2032-06-16 23:59:59 +08:00
        ['2032-06-16T15:59:59.000Z', DAY, 0],
        // 2032-06-17 01:00 +08:00
        [NEXT_RUN_AT, NEXT_DAY, 0],
      ];
      for (const [now, day, delay] of cases) {
        clock.set(now);
        // A fresh process each time (no memory): one send for the app, never an older day.
        const queue = fakeQueue();
        await seedDailyCheck({ db, clock, queue, logger });
        expect(sentFor(queue, APP).map(sendView), now).toStrictEqual([
          expectedSend(APP, day, delay),
        ]);
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02q#19] 同一进程的修复：已为该 D 排过的 app 不再送，新出现的 app 补上；一个 app 送失败不挡其他 app，失败在全部试完后抛出，下次修复再送；到了下一天各 app 送新的 D',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const clock = new FixedClock(RUN_AT);
      await userAccount(db, clock, APP);
      await userAccount(db, clock, OTHER);
      const { logger } = memoryLogger();
      const queue = fakeQueue();
      const started = new Map<string, string>();

      queue.failing.add(APP);
      const error = await rejection(seedDailyCheck({ db, clock, queue, logger, started }));
      expect(messages(error)).toContain('synthetic send failure');
      expect(queue.sent.map(sendView)).toStrictEqual([expectedSend(OTHER, DAY, 0)]);

      queue.failing.clear();
      await seedDailyCheck({ db, clock, queue, logger, started });
      expect(queue.sent.map(sendView)).toStrictEqual([
        expectedSend(OTHER, DAY, 0),
        expectedSend(APP, DAY, 0),
      ]);

      await userAccount(db, clock, THIRD);
      await seedDailyCheck({ db, clock, queue, logger, started });
      expect(queue.sent.slice(2).map(sendView)).toStrictEqual([expectedSend(THIRD, DAY, 0)]);

      clock.set(NEXT_RUN_AT);
      await seedDailyCheck({ db, clock, queue, logger, started });
      const later = queue.sent.slice(3).map(sendView);
      expect(later).toHaveLength(3);
      expect(later).toEqual(
        expect.arrayContaining([
          expectedSend(APP, NEXT_DAY, 0),
          expectedSend(OTHER, NEXT_DAY, 0),
          expectedSend(THIRD, NEXT_DAY, 0),
        ]),
      );
    });
  },
  TIMEOUT,
);
