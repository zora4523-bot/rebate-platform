// B2-04ze: the scan of due batches (D10-443; 08 BR-FUND-04 ⑥ ⑦, 细则「结算批次迁移表」SB5 / SB9):
// one `batch_execute` job per batch that is CONFIRMED and due (IMMEDIATE, or SCHEDULED with
// scheduled_at ≤ now), not stopped by a switch (paused_by_switch_at null; only the manual continue
// restarts it), and per EXECUTING batch (the executor's SB9 take-over after a crash or a day
// rollover). DRAFT, PARTIAL (no automatic resume), DONE and CANCELLED batches are never sent. The
// queue's singletonKey keeps one queued or running job per batch.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { scanDueBatches } from '../../../../apps/api/src/modules/settlement/worker/index.ts';
import {
  APP,
  CONFIRMED_AT,
  JD,
  OTHER,
  SCAN_NOW,
  TIMEOUT,
  byKey,
  executeKey,
  executeSend,
  fakeQueue,
  liveJobsUnder,
  memoryLogger,
  messages,
  rejection,
  seedBatch,
  sendView,
  transition,
  withDatabase,
  withRealQueue,
} from './kit.ts';

/** SCAN_NOW − 1 minute, SCAN_NOW, SCAN_NOW + 1 minute (+08:00 10:00). */
const JUST_BEFORE = '2032-07-24T09:59:00+08:00';
const EXACTLY = '2032-07-24T10:00:00+08:00';
const JUST_AFTER = '2032-07-24T10:01:00+08:00';

it(
  '[AC-B2-04ze#17] 扫描：CONFIRMED 立即结算、CONFIRMED 定时且 scheduled_at ≤ 当前（含恰好等于）、EXECUTING 各送 1 个 batch_execute（各 app）；定时未到、被开关停住（paused_by_switch_at）、DRAFT / PARTIAL / DONE / CANCELLED 不送；事务外、立即',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const due = [
        await seedBatch(db, APP, { status: 'CONFIRMED' }),
        await seedBatch(db, APP, {
          status: 'CONFIRMED',
          settleMode: 'SCHEDULED',
          scheduledAt: JUST_BEFORE,
        }),
        await seedBatch(db, APP, {
          status: 'CONFIRMED',
          settleMode: 'SCHEDULED',
          scheduledAt: EXACTLY,
        }),
        await seedBatch(db, APP, { status: 'EXECUTING' }),
      ];
      const otherDue = await seedBatch(db, OTHER, { status: 'CONFIRMED', platform: JD });
      const later = await seedBatch(db, APP, {
        status: 'CONFIRMED',
        settleMode: 'SCHEDULED',
        scheduledAt: JUST_AFTER,
      });
      await seedBatch(db, APP, { status: 'CONFIRMED', pausedBySwitchAt: CONFIRMED_AT });
      await seedBatch(db, APP, { status: 'DRAFT' });
      await seedBatch(db, APP, { status: 'PARTIAL' });
      await seedBatch(db, APP, { status: 'DONE' });
      await seedBatch(db, APP, { status: 'CANCELLED' });
      const { logger } = memoryLogger();

      const queue = fakeQueue();
      await scanDueBatches({ db, clock: new FixedClock(SCAN_NOW), queue, logger });
      expect(byKey(queue.sent.map(sendView))).toStrictEqual(
        byKey([...due.map((id) => executeSend(APP, id)), executeSend(OTHER, otherDue)]),
      );
      expect(queue.sent.every((job) => job.options.trx === null && !job.inTransaction)).toBe(true);

      // Two minutes later the scheduled batch is due as well.
      const next = fakeQueue();
      await scanDueBatches({
        db,
        clock: new FixedClock('2032-07-24T02:02:00.000Z'),
        queue: next,
        logger,
      });
      expect(next.sent.map(sendView)).toContainEqual(executeSend(APP, later));
      expect(next.sent).toHaveLength(due.length + 2);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04ze#18] 一批送失败不挡其他批次：其余照送，失败在全部试完后抛出',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const mine = await seedBatch(db, APP, { status: 'CONFIRMED' });
      await seedBatch(db, OTHER, { status: 'CONFIRMED' });
      const queue = fakeQueue();
      queue.failing.add(OTHER);
      const { logger } = memoryLogger();
      const error = await rejection(() =>
        scanDueBatches({ db, clock: new FixedClock(SCAN_NOW), queue, logger }),
      );
      expect(messages(error)).toContain('synthetic send failure');
      expect(queue.sent.map(sendView)).toStrictEqual([executeSend(APP, mine)]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04ze#19] 真实队列上按 singletonKey 去重：连续两次扫描每批只有 1 个排队任务；任务完成而批次仍到点（如快照未完成）时下一次扫描再送 1 个',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const batch = await seedBatch(db, APP, { status: 'CONFIRMED' });
      const running = await seedBatch(db, APP, { status: 'EXECUTING' });
      const { logger } = memoryLogger();
      const clock = new FixedClock(SCAN_NOW);
      await withRealQueue(db, async (queue) => {
        await scanDueBatches({ db, clock, queue, logger });
        await scanDueBatches({ db, clock, queue, logger });
        const live = await liveJobsUnder(db, executeKey(APP, batch));
        expect(live).toHaveLength(1);
        expect(live[0]?.payload).toStrictEqual({ app_id: APP, batch_id: batch });
        expect(await liveJobsUnder(db, executeKey(APP, running))).toHaveLength(1);

        await transition(db, live[0]?.id ?? '', 'active');
        await transition(db, live[0]?.id ?? '', 'completed');
        await scanDueBatches({ db, clock, queue, logger });
        expect(await liveJobsUnder(db, executeKey(APP, batch))).toHaveLength(1);
        expect(await liveJobsUnder(db, executeKey(APP, running))).toHaveLength(1);
      });
    });
  },
  TIMEOUT,
);
