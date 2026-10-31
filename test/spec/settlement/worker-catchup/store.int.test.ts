// B2-04zg: the catch-up's state store over PostgreSQL (D10-476 / task brief §9.2: decided from
// settle_bills / settle_jobs / the pg-boss queue, never from process memory). 'generated' when
// settle_jobs holds the done row of (app, bill, platform, D* 00:00 +08:00) or settle_bills holds the
// bill month M of D* with the platform counted; else 'pending' while a job under
// bill:<app>:<platform>:<D*> is queued, active or waiting for a retry on queue settle; else
// 'absent' — a completed job alone (deferred and not_due complete the delivery), a failed run, a
// cancelled job or a settle.dead copy do not stop the catch-up. Checked against pg-boss on the test
// database.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  createSettleCatchUpStore,
  scheduleSettleBill,
} from '../../../../apps/api/src/modules/settlement/worker/index.ts';
import {
  APP,
  BILL_DAY,
  BILL_DAY_START,
  BILL_MONTH,
  JD,
  OTHER,
  PDD,
  TAOBAO,
  TIMEOUT,
  billKey,
  failToDead,
  liveJobsUnder,
  seedSettleJob,
  transition,
  withDatabase,
  withRealQueue,
} from '../worker/kit.ts';
import { PREV_BILL_DAY, PREV_BILL_DAY_START, seedGeneratedBill } from './kit.ts';

it(
  '[AC-B2-04zg#8] 补出账状态存储：未送 absent；排队、执行中、等待重试 pending；只完成了投递（deferred / not_due）、失败进死信、被取消、settle_jobs failed 行仍 absent；settle_jobs 有 (bill, 平台, D* 00:00 +08:00) done 行或 settle_bills 账单月已记该平台即 generated（队列里有任务也一样）；别的平台 / 别的 run_at / 别的 app 不算；新实例判定相同',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const store = createSettleCatchUpStore(db);
      const state = (appId: string, platform: string, day: string) =>
        store.billCatchUpStateOf(appId, platform, day);

      await withRealQueue(db, async (queue) => {
        const send = (appId: string, platform: string) =>
          scheduleSettleBill(queue, null, { appId, platform, accountingDate: BILL_DAY });

        // Nothing yet.
        expect(await state(APP, TAOBAO, BILL_DAY)).toBe('absent');

        // Queued, active, or waiting to be tried again: pending.
        await send(APP, TAOBAO);
        const [first] = await liveJobsUnder(db, billKey(APP, TAOBAO, BILL_DAY));
        expect(first?.state).toBe('created');
        const firstId = first?.id ?? '';
        expect(await state(APP, TAOBAO, BILL_DAY)).toBe('pending');
        await transition(db, firstId, 'active');
        expect(await state(APP, TAOBAO, BILL_DAY)).toBe('pending');
        await transition(db, firstId, 'retry');
        expect(await state(APP, TAOBAO, BILL_DAY)).toBe('pending');
        // Other platform, other day, other app: untouched.
        expect(await state(APP, JD, BILL_DAY)).toBe('absent');
        expect(await state(APP, TAOBAO, PREV_BILL_DAY)).toBe('absent');
        expect(await state(OTHER, TAOBAO, BILL_DAY)).toBe('absent');

        // The delivery completed without a bill (deferred): absent.
        await transition(db, firstId, 'active');
        await transition(db, firstId, 'completed');
        expect(await state(APP, TAOBAO, BILL_DAY)).toBe('absent');

        // Failed for good (copy in settle.dead): absent.
        await send(APP, TAOBAO);
        const [second] = await liveJobsUnder(db, billKey(APP, TAOBAO, BILL_DAY));
        await failToDead(db, second?.id ?? '');
        expect(await state(APP, TAOBAO, BILL_DAY)).toBe('absent');

        // Cancelled: absent.
        await send(APP, TAOBAO);
        const [third] = await liveJobsUnder(db, billKey(APP, TAOBAO, BILL_DAY));
        await transition(db, third?.id ?? '', 'cancelled');
        expect(await state(APP, TAOBAO, BILL_DAY)).toBe('absent');

        // A failed run of the bill (CouliSettleBillJobFailed): absent, the catch-up runs it again.
        await seedSettleJob(db, APP, TAOBAO, BILL_DAY_START, 'failed');
        expect(await state(APP, TAOBAO, BILL_DAY)).toBe('absent');

        // A done run of (bill, JD, D* 00:00): generated, with or without a job in the queue.
        await seedSettleJob(db, APP, JD, BILL_DAY_START, 'done');
        expect(await state(APP, JD, BILL_DAY)).toBe('generated');
        await send(APP, JD);
        expect(await state(APP, JD, BILL_DAY)).toBe('generated');

        // settle_bills of M (2032-06) with PDD counted: generated for PDD only.
        await seedGeneratedBill(db, APP, BILL_MONTH, { [PDD]: 0 }, '2032-07-24T08:00:00+08:00');
        expect(await state(APP, PDD, BILL_DAY)).toBe('generated');
        expect(await state(APP, TAOBAO, BILL_DAY)).toBe('absent');

        // Another app: a done run under another run_at (the supplement's +1 ms) or of the previous
        // bill day does not make 07-24 generated; the previous bill day's own run does.
        await seedSettleJob(db, OTHER, TAOBAO, '2032-07-23T16:00:00.001Z', 'done');
        await seedSettleJob(db, OTHER, TAOBAO, PREV_BILL_DAY_START, 'done');
        expect(await state(OTHER, TAOBAO, BILL_DAY)).toBe('absent');
        expect(await state(OTHER, TAOBAO, PREV_BILL_DAY)).toBe('generated');
        // M of the previous bill day (2032-05) counted for JD does not make 2032-06 generated.
        await seedGeneratedBill(db, OTHER, '2032-05', { [JD]: 3 }, '2032-06-24T08:00:00+08:00');
        expect(await state(OTHER, JD, BILL_DAY)).toBe('absent');
        expect(await state(OTHER, JD, PREV_BILL_DAY)).toBe('generated');

        // A fresh store (a restarted worker) answers the same.
        const fresh = createSettleCatchUpStore(db);
        expect([
          await fresh.billCatchUpStateOf(APP, TAOBAO, BILL_DAY),
          await fresh.billCatchUpStateOf(APP, JD, BILL_DAY),
          await fresh.billCatchUpStateOf(APP, PDD, BILL_DAY),
          await fresh.billCatchUpStateOf(OTHER, TAOBAO, BILL_DAY),
        ]).toStrictEqual(['absent', 'generated', 'generated', 'absent']);
      });
    });
  },
  TIMEOUT,
);
