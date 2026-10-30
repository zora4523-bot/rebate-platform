// B2-02q: one `daily` job of queue ledger-check (08 BR-FUND-19; task brief §9.1 / §9.2): the run of
// the payload's (app, D) — never a D taken from the clock — through createDailyCheck and the B2-02p
// execution step, each difference with the invariant file it came from (pay- files are only
// registered, D10-358 ②); then D+1 enqueued on a transaction, due at D+2 01:00 +08:00 or at once
// when that has passed. A failed run is thrown to the queue (retried; a rerun is idempotent).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { LedgerInvariantFile } from '../../../../apps/api/src/modules/ledger/index.ts';
import type { JobPayload } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  APP,
  DAY,
  NEXT_DAY,
  NEXT_RUN_AT,
  OTHER,
  RUN_AT,
  SWITCH_KEY,
  TIMEOUT,
  broken,
  clean,
  dailyJob,
  diffsOf,
  differing,
  expectedSend,
  holdsOf,
  ledgerCodes,
  messages,
  rejection,
  sendView,
  sourceOf,
  userAccount,
  withJobHarness,
} from './kit.ts';

/** 2032-06-20 12:00 +08:00: days after DAY (a late or replayed run). */
const LATE = '2032-06-20T04:00:00.000Z';

it(
  '[AC-B2-02q#10] 一次 daily 任务按负载的 (app, D) 跑校验并交执行段：本 app 的非 pay- 账户级差异登记 R3 差错单（期间 D）并冻结账户 owner，pay- 差异只登记不冻结，他 app 的差异不登记；D 不取时钟',
  async () => {
    let files: LedgerInvariantFile[] = [];
    await withJobHarness(createTestDatabase, { now: LATE, files: () => files }, async (h) => {
      const mine = await userAccount(h.db, h.clock, APP);
      const theirs = await userAccount(h.db, h.clock, OTHER);
      files = [
        differing('01_fixture-balance.sql', '01', [
          { scope: 'account', appId: APP, accountId: mine.accountId },
          { scope: 'account', appId: OTHER, accountId: theirs.accountId },
        ]),
        clean('02_fixture-vouchers.sql', '02'),
        differing('pay-09_fixture-receipts.sql', 'pay-09', [
          { scope: 'account', appId: APP, accountId: mine.accountId },
        ]),
      ];
      await h.job(dailyJob({ app_id: APP, accounting_date: DAY }));

      const diffs = await diffsOf(h.db, APP);
      expect(diffs.map((row) => [row.ref_id, row.period, row.source, row.type])).toStrictEqual([
        [`01:${mine.accountId}`, DAY, 'R3', 'ledger_mismatch'],
        [`pay-09:${mine.accountId}`, DAY, 'R3', 'ledger_mismatch'],
      ]);
      // The runner ran for D (couli.check_date), and the detail reached the diff.
      for (const row of diffs) {
        expect(JSON.stringify(row.resolution), row.ref_id).toContain(`"check_date":"${DAY}"`);
      }
      const balance = diffs[0]!;
      expect(h.holds.calls).toStrictEqual([
        {
          appId: APP,
          userId: mine.userId,
          reason: 'ledger_mismatch',
          sourceRef: sourceOf(balance.id),
          createdBy: 'system',
          holdUntil: null,
        },
      ]);
      expect((await holdsOf(h.db, APP)).map((row) => [row.user_id, row.source_ref])).toStrictEqual([
        [mine.userId, sourceOf(balance.id)],
      ]);
      expect(await diffsOf(h.db, OTHER)).toStrictEqual([]);
      expect(await holdsOf(h.db, OTHER)).toStrictEqual([]);
      expect(h.settle.turnOffs).toStrictEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02q#11] 跑完在事务内排下一天：准点运行时延迟到 D+2 01:00（86400 秒），晚到的运行立即补跑下一天；无差异的一天照样续排，只排这一条',
  async () => {
    const files = [clean('01_fixture-balance.sql', '01'), clean('pay-09_fixture.sql', 'pay-09')];
    await withJobHarness(createTestDatabase, { now: RUN_AT, files: () => files }, async (h) => {
      await h.job(dailyJob({ app_id: APP, accounting_date: DAY }));
      expect(h.queue.sent.map(sendView)).toStrictEqual([expectedSend(APP, NEXT_DAY, 86_400)]);
      expect(h.queue.sent[0]!.inTransaction).toBe(true);

      // Days late (a worker that was down): the chain catches up at once.
      h.clock.set(LATE);
      await h.job(dailyJob({ app_id: APP, accounting_date: NEXT_DAY }));
      expect(h.queue.sent.map(sendView)).toStrictEqual([
        expectedSend(APP, NEXT_DAY, 86_400),
        expectedSend(APP, '2032-06-17', 0),
      ]);
      expect(h.queue.sent[1]!.inTransaction).toBe(true);

      // A run exactly at the next day's run time: due at once is not early.
      h.clock.set(NEXT_RUN_AT);
      await h.job(dailyJob({ app_id: OTHER, accounting_date: NEXT_DAY }));
      expect(h.queue.sent.map(sendView).at(-1)).toStrictEqual(
        expectedSend(OTHER, '2032-06-17', 86_400),
      );
      expect(await diffsOf(h.db, APP)).toStrictEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02q#12] 同一 (app, D) 的任务重复投递：差错单与冻结都不重复，续排仍是同一 singletonKey（排他队列合并）',
  async () => {
    let files: LedgerInvariantFile[] = [];
    await withJobHarness(createTestDatabase, { now: RUN_AT, files: () => files }, async (h) => {
      const mine = await userAccount(h.db, h.clock, APP);
      files = [
        differing('01_fixture-balance.sql', '01', [
          { scope: 'account', appId: APP, accountId: mine.accountId },
        ]),
      ];
      await h.job(dailyJob({ app_id: APP, accounting_date: DAY }));
      const diffs = await diffsOf(h.db, APP);
      const holds = await holdsOf(h.db, APP);
      expect(diffs).toHaveLength(1);
      expect(holds).toHaveLength(1);

      await h.job(dailyJob({ app_id: APP, accounting_date: DAY }, 2));
      expect(await diffsOf(h.db, APP)).toStrictEqual(diffs);
      expect(await holdsOf(h.db, APP)).toStrictEqual(holds);
      expect(h.holds.calls).toHaveLength(1);
      expect(h.queue.sent.map(sendView)).toStrictEqual([
        expectedSend(APP, NEXT_DAY, 86_400),
        expectedSend(APP, NEXT_DAY, 86_400),
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02q#13] 校验本身失败（不变量文件不合输出约定）：任务以 DAILY_CHECK_FAILED 失败交队列重试，不登记差错单、不冻结、不关开关',
  async () => {
    let files: LedgerInvariantFile[] = [];
    await withJobHarness(createTestDatabase, { now: RUN_AT, files: () => files }, async (h) => {
      const mine = await userAccount(h.db, h.clock, APP);
      files = [
        differing('01_fixture-balance.sql', '01', [
          { scope: 'account', appId: APP, accountId: mine.accountId },
        ]),
        broken('03_fixture-broken.sql', '03'),
      ];
      const error = await rejection(h.job(dailyJob({ app_id: APP, accounting_date: DAY })));
      expect(ledgerCodes(error), messages(error)).toContain('DAILY_CHECK_FAILED');
      expect(await diffsOf(h.db, APP)).toStrictEqual([]);
      expect(await holdsOf(h.db, APP)).toStrictEqual([]);
      expect(h.holds.calls).toStrictEqual([]);
      expect(h.settle.turnOffs).toStrictEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02q#14] 执行段失败（冻结端口抛错）：任务失败交队列重试，该差错单连同冻结整体回滚；重试成功后恰 1 张差错单、1 条冻结',
  async () => {
    let files: LedgerInvariantFile[] = [];
    await withJobHarness(createTestDatabase, { now: RUN_AT, files: () => files }, async (h) => {
      const mine = await userAccount(h.db, h.clock, APP);
      files = [
        differing('01_fixture-balance.sql', '01', [
          { scope: 'account', appId: APP, accountId: mine.accountId },
        ]),
      ];
      h.holds.fail = true;
      const error = await rejection(h.job(dailyJob({ app_id: APP, accounting_date: DAY })));
      expect(ledgerCodes(error), messages(error)).toContain('DAILY_CHECK_FAILED');
      expect(await diffsOf(h.db, APP)).toStrictEqual([]);
      expect(await holdsOf(h.db, APP)).toStrictEqual([]);

      h.holds.fail = false;
      await h.job(dailyJob({ app_id: APP, accounting_date: DAY }, 2));
      const diffs = await diffsOf(h.db, APP);
      expect(diffs.map((row) => row.ref_id)).toStrictEqual([`01:${mine.accountId}`]);
      expect((await holdsOf(h.db, APP)).map((row) => [row.user_id, row.source_ref])).toStrictEqual([
        [mine.userId, sourceOf(diffs[0]!.id)],
      ]);
      expect(sendView(h.queue.sent.at(-1)!)).toStrictEqual(expectedSend(APP, NEXT_DAY, 86_400));
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02q#15] 负载不合法（缺 app_id、空 app_id、缺 D、D 不存在或格式不对、D 不是文本）：任务被拒绝，不跑校验、不登记、不冻结、不续排',
  async () => {
    let files: LedgerInvariantFile[] = [];
    await withJobHarness(createTestDatabase, { now: RUN_AT, files: () => files }, async (h) => {
      const mine = await userAccount(h.db, h.clock, APP);
      files = [
        differing('01_fixture-balance.sql', '01', [
          { scope: 'account', appId: APP, accountId: mine.accountId },
        ]),
      ];
      const payloads: JobPayload[] = [
        { accounting_date: DAY },
        { app_id: '', accounting_date: DAY },
        { app_id: APP },
        { app_id: APP, accounting_date: '2032-02-30' },
        { app_id: APP, accounting_date: '2032-6-15' },
        { app_id: APP, accounting_date: 20_320_615 },
        { app_id: 7, accounting_date: DAY },
      ];
      for (const payload of payloads) {
        const error = await rejection(h.job(dailyJob(payload)));
        expect(messages(error), JSON.stringify(payload)).not.toMatch(/NotImplemented/u);
      }
      expect(h.queue.sent).toStrictEqual([]);
      expect(await diffsOf(h.db, APP)).toStrictEqual([]);
      expect(h.holds.calls).toStrictEqual([]);
      expect(h.settle.turnOffs).toStrictEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02q#16] 本 app 有非 pay- 全局差异：经端口把本 app 的 settle.auto.enabled 置 off 一次并在提交后告警；pay- 全局差异与他 app 的全局差异不关本 app 的开关',
  async () => {
    const voucher = randomUUID();
    const files = [
      differing('02_fixture-vouchers.sql', '02', [
        { scope: 'global', appId: APP, voucherId: voucher },
        { scope: 'global', appId: OTHER, voucherId: randomUUID() },
      ]),
      differing('pay-04_fixture-suspense.sql', 'pay-04', [{ scope: 'global', appId: APP }]),
    ];
    await withJobHarness(createTestDatabase, { now: RUN_AT, files: () => files }, async (h) => {
      await h.job(dailyJob({ app_id: APP, accounting_date: DAY }));
      expect(h.settle.turnOffs.map((input) => [input.appId, input.key])).toStrictEqual([
        [APP, SWITCH_KEY],
      ]);
      expect(h.settle.alerts.map((input) => input.appId)).toStrictEqual([APP]);
      expect((await diffsOf(h.db, APP)).map((row) => row.ref_id)).toStrictEqual([
        `02:${voucher}`,
        `pay-04:${APP}`,
      ]);
      expect(await diffsOf(h.db, OTHER)).toStrictEqual([]);

      // The other app's own job switches the other app only.
      await h.job(dailyJob({ app_id: OTHER, accounting_date: DAY }));
      expect(h.settle.turnOffs.map((input) => input.appId)).toStrictEqual([APP, OTHER]);
    });
  },
  TIMEOUT,
);
