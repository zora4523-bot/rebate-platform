// B2-02s: the `daily` handler writes the completion record of (app, D) (task brief §9.2). Once the
// runner and the B2-02p execution step have run to the end, one row of app.processed_events
// (consumer ledger.daily_check_done, event_id dailyCheckDoneEventId(app, D)) is written on the same
// transaction that enqueues D+1 — the row's xmin is the id of the transaction the D+1 send was given;
// a re-delivered run adds nothing (ON CONFLICT DO NOTHING) and does not fail. A run that throws
// before the end — the check itself, the execution step, or the enqueue of D+1 — leaves no row.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { LedgerInvariantFile } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  APP,
  DAY,
  NEXT_DAY,
  OTHER,
  RUN_AT,
  TIMEOUT,
  allDoneRecords,
  broken,
  clean,
  cleanFiles,
  dailyJob,
  diffsOf,
  differing,
  doneRecordXid,
  doneRecords,
  expectedSend,
  holdsOf,
  ledgerCodes,
  messages,
  rejection,
  sendView,
  userAccount,
  withDoneHarness,
} from './kit.ts';

it(
  '[AC-B2-02s#2] daily 处理器跑完（运行器 + 执行段）即写 1 条完成记录（processed_events，consumer ledger.daily_check_done，event_id = dailyCheckDoneEventId(app, D)），与续排 D+1 在同一事务；有差异的一天同样记；重投不多记、不报错；只记本 (app, D)',
  async () => {
    let files: LedgerInvariantFile[] = [];
    await withDoneHarness(createTestDatabase, { now: RUN_AT, files: () => files }, async (h) => {
      const mine = await userAccount(h.db, h.clock, APP);
      files = [
        differing('01_fixture-balance.sql', '01', [
          { scope: 'account', appId: APP, accountId: mine.accountId },
        ]),
        clean('02_fixture-vouchers.sql', '02'),
      ];
      await h.job(dailyJob({ app_id: APP, accounting_date: DAY }));

      // The execution step ran (one diff, one hold) and D+1 was enqueued on a transaction.
      expect(await diffsOf(h.db, APP)).toHaveLength(1);
      expect(await holdsOf(h.db, APP)).toHaveLength(1);
      expect(h.queue.sent.map(sendView)).toStrictEqual([expectedSend(APP, NEXT_DAY, 86_400)]);
      expect(h.queue.sent[0]!.inTransaction).toBe(true);
      expect(h.queue.xids).toHaveLength(1);

      // Exactly one completion record of (APP, DAY), written by the transaction of the D+1 send.
      expect(await doneRecords(h.db, APP, DAY)).toBe(1);
      expect(await allDoneRecords(h.db)).toBe(1);
      expect(await doneRecordXid(h.db, APP, DAY)).toBe(h.queue.xids[0]);
      expect(await doneRecords(h.db, APP, NEXT_DAY)).toBe(0);
      expect(await doneRecords(h.db, OTHER, DAY)).toBe(0);

      // The queue delivers the same (app, D) again: it runs, enqueues D+1 again, adds no record.
      await h.job(dailyJob({ app_id: APP, accounting_date: DAY }, 2));
      expect(h.queue.sent.map(sendView)).toStrictEqual([
        expectedSend(APP, NEXT_DAY, 86_400),
        expectedSend(APP, NEXT_DAY, 86_400),
      ]);
      expect(await doneRecords(h.db, APP, DAY)).toBe(1);
      expect(await allDoneRecords(h.db)).toBe(1);

      // Another app's run of the same day has its own record; a clean day is recorded too.
      files = cleanFiles();
      await h.job(dailyJob({ app_id: OTHER, accounting_date: DAY }));
      expect(await doneRecords(h.db, OTHER, DAY)).toBe(1);
      expect(await doneRecords(h.db, APP, DAY)).toBe(1);
      expect(await allDoneRecords(h.db)).toBe(2);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02s#3] 处理没跑完就抛错时不写完成记录：校验本身失败、执行段失败（冻结端口抛错）、续排 D+1 失败（同一事务回滚）都不留记录，任务照常以失败交队列；之后重跑成功才记 1 条',
  async () => {
    let files: LedgerInvariantFile[] = [];
    await withDoneHarness(createTestDatabase, { now: RUN_AT, files: () => files }, async (h) => {
      const mine = await userAccount(h.db, h.clock, APP);
      const mismatch = differing('01_fixture-balance.sql', '01', [
        { scope: 'account', appId: APP, accountId: mine.accountId },
      ]);

      // The check itself fails (an invariant file breaks the output contract).
      files = [mismatch, broken('03_fixture-broken.sql', '03')];
      const checkFailed = await rejection(h.job(dailyJob({ app_id: APP, accounting_date: DAY })));
      expect(ledgerCodes(checkFailed), messages(checkFailed)).toContain('DAILY_CHECK_FAILED');
      expect(h.queue.sent).toStrictEqual([]);
      expect(await allDoneRecords(h.db)).toBe(0);

      // The execution step fails (the hold port throws): its diff rolls back, no record.
      files = [mismatch];
      h.holds.fail = true;
      const executionFailed = await rejection(
        h.job(dailyJob({ app_id: APP, accounting_date: DAY }, 2)),
      );
      expect(ledgerCodes(executionFailed), messages(executionFailed)).toContain(
        'DAILY_CHECK_FAILED',
      );
      expect(await diffsOf(h.db, APP)).toStrictEqual([]);
      expect(h.queue.sent).toStrictEqual([]);
      expect(await allDoneRecords(h.db)).toBe(0);

      // The run and the execution step finish, but the enqueue of D+1 throws: the transaction of
      // the send rolls back, and with it any record written on it.
      h.holds.fail = false;
      h.queue.failing.add(APP);
      const sendFailed = await rejection(h.job(dailyJob({ app_id: APP, accounting_date: DAY }, 3)));
      expect(messages(sendFailed)).toContain('synthetic send failure');
      expect(await diffsOf(h.db, APP)).toHaveLength(1);
      expect(h.queue.sent).toStrictEqual([]);
      expect(await allDoneRecords(h.db)).toBe(0);
      expect(await doneRecords(h.db, APP, DAY)).toBe(0);

      // The next delivery runs to the end: now, and only now, (APP, DAY) is recorded.
      h.queue.failing.clear();
      await h.job(dailyJob({ app_id: APP, accounting_date: DAY }, 4));
      expect(h.queue.sent.map(sendView)).toStrictEqual([expectedSend(APP, NEXT_DAY, 86_400)]);
      expect(await doneRecords(h.db, APP, DAY)).toBe(1);
      expect(await allDoneRecords(h.db)).toBe(1);
      expect(await doneRecordXid(h.db, APP, DAY)).toBe(h.queue.xids.at(-1));
    });
  },
  TIMEOUT,
);
