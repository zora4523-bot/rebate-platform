// BR-WDR-23 / BR-WDR-16, D10-632: late_paid_check reads stored bills, never reruns R2.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  BILL_DATE,
  IN_DAY,
  LINE_FAIL,
  LINE_UNKNOWN,
  NEXT_BILL_DATE,
  NEXT_RUN,
  alertsAbout,
  books,
  channelOrderId,
  diffs,
  diffsOf,
  expectDiff,
  expectReconHold,
  holdsOf,
  lineOf,
  reconRows,
  runs,
  type ReconFixture,
} from '../recon-channel/kit.ts';
import {
  compete,
  expectClean,
  expectMissing,
  expectRetry,
  incomplete,
  jobs,
  lateJob,
  lateJobs,
  runLate,
  stored,
  suite,
} from './late-paid-harness.ts';

const s = suite();

async function emptyDay(f: ReconFixture, day = BILL_DATE) {
  f.setBill(day, []);
  await f.runDay(day);
  expect((await runs(f)).find((r) => r.bill_date === day)?.status).toBe('succeeded');
}

it('[AC-B2-09t#11] 已跑账单无成功行：一张 missing 差错、永久冻结、告警，账本与已存账单完全不动', async () => {
  const f = await s.setup();
  await emptyDay(f);
  const w = await f.seedManual(IN_DAY, { net: 12_347n });
  const before = {
    stored: await stored(f),
    books: await books(f),
    jobs: await jobs(f),
    calls: f.billCalls(),
  };
  expect(await diffsOf(f, [w.id])).toEqual([]);
  await runLate(f, w.id);
  await expectMissing(f, w);
  expect(alertsAbout(f, [w.id])).toHaveLength(1);
  expect(await stored(f)).toEqual(before.stored);
  expect(await books(f)).toEqual(before.books);
  expect(await jobs(f)).toEqual(before.jobs);
  expect(f.billCalls()).toEqual(before.calls);
}, 60_000);

it('[AC-B2-09t#7] 先落 unknown_line 后补同流水号：核上，不新增或关闭旧差错，不冻结', async () => {
  const f = await s.setup();
  const order = channelOrderId();
  f.setBill(BILL_DATE, [
    lineOf({ outBizNo: 'unrelated', net: 12_347n }, { outBizNo: null, channelOrderId: order }),
  ]);
  await f.runDay();
  const prior = await diffs(f);
  expect(prior).toHaveLength(1);
  expect(prior[0]).toMatchObject({ status: 'open', resolution: { case: 'unknown_line' } });
  const w = await f.seedManual(IN_DAY, { net: 12_347n });
  await sql`UPDATE app.withdrawals SET channel_order_id = ${order}
    WHERE app_id = ${f.appId} AND id = ${w.id}`.execute(f.h.db);
  const before = {
    stored: await stored(f),
    books: await books(f),
    jobs: await jobs(f),
    calls: f.billCalls(),
  };
  await runLate(f, w.id);
  await expectClean(f, w);
  expect(await diffs(f)).toEqual(prior);
  expect(await stored(f)).toEqual(before.stored);
  expect(await books(f)).toEqual(before.books);
  expect(await jobs(f)).toEqual(before.jobs);
  expect(f.billCalls()).toEqual(before.calls);
}, 60_000);

it('[AC-B2-09t#8] paid_at 倒填 D，D−3 的成功行仍能核上；多个成功金额中任一等于 net 即结束', async () => {
  const f = await s.setup();
  const order = channelOrderId();
  f.setBill('2026-10-15', [
    lineOf(
      { outBizNo: 'old', net: 12_347n },
      { outBizNo: null, channelOrderId: order, bookedAt: '2026-10-15T10:00:00+08:00' },
    ),
  ]);
  await f.runDay('2026-10-15');
  f.setBill('2026-10-16', [
    lineOf(
      { outBizNo: 'old', net: 12_346n },
      { outBizNo: null, channelOrderId: order, bookedAt: '2026-10-16T10:00:00+08:00' },
    ),
  ]);
  await f.runDay('2026-10-16');
  await emptyDay(f);
  const w = await f.seedManual(IN_DAY, { net: 12_347n });
  await sql`UPDATE app.withdrawals SET channel_order_id = ${order} WHERE id = ${w.id} AND app_id = ${f.appId}`.execute(
    f.h.db,
  );
  const before = await diffs(f);
  await runLate(f, w.id);
  await expectClean(f, w);
  expect(await diffs(f)).toEqual(before);
}, 60_000);

it('[AC-B2-09t#9] PAID_API 仅 out_biz_no 命中与仅 channel_order_id 命中均核上；无下载、查询或次日入队 [AC-B2-09t#10]', async () => {
  for (const key of ['out_biz_no', 'channel_order_id']) {
    const f = await s.setup();
    const w = await f.seedPaid(IN_DAY);
    f.setBill(BILL_DATE, [
      lineOf(w, key === 'out_biz_no' ? { channelOrderId: channelOrderId() } : { outBizNo: null }),
    ]);
    await f.runDay();
    expect(await reconRows(f)).toHaveLength(1);
    const before = {
      stored: await stored(f),
      jobs: await jobs(f),
      calls: f.billCalls(),
      books: await books(f),
    };
    await runLate(f, w.id);
    await expectClean(f, w);
    expect(await stored(f)).toEqual(before.stored);
    expect(await jobs(f)).toEqual(before.jobs);
    expect(f.billCalls()).toEqual(before.calls);
    expect(await books(f)).toEqual(before.books);
  }
}, 60_000);

it('[AC-B2-09t#12] 金额多一分与少一分：按 net_fen，差错 period 是成功行的账单日', async () => {
  for (const actual of [12_346n, 12_348n]) {
    const f = await s.setup();
    const order = channelOrderId();
    f.setBill('2026-10-15', [
      lineOf(
        { outBizNo: 'old', net: actual },
        { outBizNo: null, channelOrderId: order, bookedAt: '2026-10-15T10:00:00+08:00' },
      ),
    ]);
    await f.runDay('2026-10-15');
    const w = await f.seedManual(IN_DAY, { net: 12_347n });
    expect(w.amount).toBe(12_847n);
    await sql`UPDATE app.withdrawals SET channel_order_id = ${order} WHERE id = ${w.id} AND app_id = ${f.appId}`.execute(
      f.h.db,
    );
    const before = await books(f);
    await runLate(f, w.id);
    const found = await diffsOf(f, [w.id]);
    expect(found).toHaveLength(1);
    expectDiff(f, found[0], {
      refType: 'withdrawal',
      refIds: [w.id],
      expectedFen: 12_347n,
      actualFen: actual,
      periods: ['2026-10-15'],
    });
    expect(found[0]?.resolution).toMatchObject({ case: 'amount_mismatch' });
    await expectReconHold(f, w.userId, found[0]);
    expect(alertsAbout(f, [w.id]).length).toBeGreaterThan(0);
    expect(await books(f)).toEqual(before);
  }
}, 60_000);

it('[AC-B2-09t#13] LINE_FAIL、LINE_UNKNOWN 都不是成功；已跑完时同流水号也报 missing', async () => {
  for (const status of [LINE_FAIL, LINE_UNKNOWN]) {
    const f = await s.setup();
    const order = channelOrderId();
    f.setBill(BILL_DATE, [
      lineOf(
        { outBizNo: 'unknown', net: 1000n },
        { outBizNo: null, channelOrderId: order, status },
      ),
    ]);
    await f.runDay();
    const w = await f.seedManual(IN_DAY);
    await sql`UPDATE app.withdrawals SET channel_order_id = ${order} WHERE id = ${w.id} AND app_id = ${f.appId}`.execute(
      f.h.db,
    );
    await runLate(f, w.id);
    await expectMissing(f, w);
  }
}, 60_000);

it('[AC-B2-09t#14] 手动单的业务单号命中另一成功流水：duplicate_line 优先，即使同时有本流水成功', async () => {
  for (const ownLine of [false, true]) {
    const f = await s.setup();
    const w = await f.seedPaid(IN_DAY, { net: 12_347n });
    const stray = lineOf(w, { channelOrderId: channelOrderId() });
    f.setBill(BILL_DATE, [stray]);
    await f.runDay();
    if (ownLine) {
      f.setBill('2026-10-17', [lineOf(w)]);
      await f.runDay('2026-10-17');
    }
    // Fixture represents a later W8 snapshot; don't touch needs_manual (couli_payout only).
    await sql`UPDATE app.withdrawals SET status = 'PAID_MANUAL', manual_entry_by = ${randomUUID()},
      manual_confirm_by = ${randomUUID()} WHERE id = ${w.id} AND app_id = ${f.appId}`.execute(
      f.h.db,
    );
    expect(await diffs(f)).toEqual([]);
    await runLate(f, w.id);
    const found = await diffs(f);
    expect(found).toHaveLength(1);
    expectDiff(f, found[0], {
      refType: 'channel_order_id',
      refIds: [stray.channelOrderId],
      expectedFen: 0n,
      actualFen: 12_347n,
    });
    expect(found[0]?.resolution).toMatchObject({ case: 'duplicate_line', withdrawal_id: w.id });
    await expectReconHold(f, w.userId, found[0]);
  }
}, 60_000);

it('[AC-B2-09t#15] D 未运行、failed、partial 各自等一小时，真实 R2 跑成后才判', async () => {
  for (const status of ['absent', 'failed', 'partial'] as const) {
    const f = await s.setup();
    if (status !== 'absent') await incomplete(f, status);
    const w = await f.seedManual(IN_DAY);
    const before = await stored(f);
    await runLate(f, w.id, 7);
    await expectRetry(f, w, 7);
    expect(await stored(f)).toEqual(before);
    // Move paid_at outside D only while running the formerly incomplete bill, so R2 does
    // not preempt the worker's missing judgment. This is fixture setup, not a business write.
    await sql`UPDATE app.withdrawals SET paid_at = ${new Date('2026-10-20T02:00:00Z')}
      WHERE app_id = ${f.appId} AND id = ${w.id}`.execute(f.h.db);
    await emptyDay(f);
    await sql`UPDATE app.withdrawals SET paid_at = ${IN_DAY} WHERE app_id = ${f.appId} AND id = ${w.id}`.execute(
      f.h.db,
    );
    await expectClean(f, w);
    const next = (await lateJobs(f))[0]!;
    f.clock.set(new Date(f.clock.now().getTime() + 3_600_000));
    await runLate(f, w.id, 8, {
      id: next.id,
      queue: next.name,
      name: next.data.name,
      payload: next.data.payload,
      attempt: 1,
    });
    await expectMissing(f, w);
  }
}, 60_000);

it('[AC-B2-09t#16] round 94 入队 95；round 95 只告警点名单号，不下结论、不再排队', async () => {
  for (const round of [94, 95]) {
    const f = await s.setup();
    const w = await f.seedPaid(IN_DAY);
    await runLate(f, w.id, round);
    if (round === 94) await expectRetry(f, w, 94);
    else {
      expect(await lateJobs(f)).toEqual([]);
      expect(alertsAbout(f, [w.id]).length).toBeGreaterThan(0);
      await expectClean(f, w);
    }
  }
}, 60_000);

it('[AC-B2-09t#17] 日界含恰好十分钟：D+1 未跑要等，早一毫秒不等，两天无行才差错，次日有行核上', async () => {
  for (const scenario of ['wait', 'early', 'missing', 'next_success']) {
    const f = await s.setup();
    await emptyDay(f);
    const order = channelOrderId();
    if (scenario === 'missing' || scenario === 'next_success') {
      f.clock.set(NEXT_RUN);
      f.setBill(
        NEXT_BILL_DATE,
        scenario === 'missing'
          ? []
          : [
              lineOf(
                { outBizNo: 'next', net: 1000n },
                { outBizNo: null, channelOrderId: order, bookedAt: '2026-10-19T00:00:01+08:00' },
              ),
            ],
      );
      await f.runDay(NEXT_BILL_DATE);
    }
    const paidAt = new Date(
      scenario === 'early' ? '2026-10-18T15:49:59.999Z' : '2026-10-18T15:50:00.000Z',
    );
    const w = await f.seedManual(paidAt);
    await sql`UPDATE app.withdrawals SET channel_order_id = ${order} WHERE id = ${w.id} AND app_id = ${f.appId}`.execute(
      f.h.db,
    );
    await runLate(f, w.id);
    if (scenario === 'wait') await expectRetry(f, w, 0);
    else if (scenario === 'next_success') await expectClean(f, w);
    else await expectMissing(f, w);
  }
}, 60_000);

it('[AC-B2-09t#18] R2 先判和任务先判，两种顺序都复用 missing 去重键，仅一张差错和一次冻结', async () => {
  for (const first of ['R2', 'late']) {
    const f = await s.setup();
    if (first === 'late') await emptyDay(f);
    const w = await f.seedManual(IN_DAY);
    f.setBill(BILL_DATE, []);
    if (first === 'R2') await f.runDay();
    await runLate(f, w.id);
    if (first === 'late') await f.runDay();
    await expectMissing(f, w);
  }
}, 60_000);

it('[AC-B2-09t#19] 同一任务重投两次，差错冻结各一且不重复告警，不改终态账本', async () => {
  const f = await s.setup();
  await emptyDay(f);
  const w = await f.seedPaid(IN_DAY);
  const job = lateJob(f, w.id);
  const before = await books(f);
  await runLate(f, w.id, 0, job);
  const first = await diffs(f);
  const hold = await holdsOf(f, w.userId);
  await runLate(f, w.id, 0, { ...job, attempt: 2 });
  await expectMissing(f, w);
  expect(await diffs(f)).toEqual(first);
  expect(await holdsOf(f, w.userId)).toEqual(hold);
  expect(alertsAbout(f, [w.id])).toHaveLength(1);
  expect(await books(f)).toEqual(before);
}, 60_000);

it('[AC-B2-09t#20] 外部事务持有同 dedupe_key，PG 证明 worker 等待；提交后沿用差错且不加冻结', async () => {
  const f = await s.setup();
  await emptyDay(f);
  const w = await f.seedManual(IN_DAY);
  await compete(f, w);
}, 60_000);

it('[AC-B2-09t#21] 别的 app 的成功流水和 succeeded 都无效；本 app 才能结束等待，差错冻结不串租户', async () => {
  for (const ownDaySucceeded of [false, true]) {
    const f = await s.setup();
    const other = await s.setup();
    if (ownDaySucceeded) await emptyDay(f);
    const w = await f.seedManual(IN_DAY);
    other.setBill(BILL_DATE, [lineOf(w, { outBizNo: null })]);
    await other.runDay();
    const otherBefore = {
      stored: await stored(other),
      diffs: await diffs(other),
      books: await books(other),
    };
    await expectClean(f, w);
    await runLate(f, w.id);
    if (ownDaySucceeded) await expectMissing(f, w);
    else await expectRetry(f, w, 0);
    expect(await stored(other)).toEqual(otherBefore.stored);
    expect(await diffs(other)).toEqual(otherBefore.diffs);
    expect(await books(other)).toEqual(otherBefore.books);
    expect(await holdsOf(other, w.userId)).toEqual([]);
  }
}, 60_000);

it('[AC-B2-09t#25] 重读后不存在、非 PAID_*、银行卡都结束，不动账本、不排任务、不生差错冻结', async () => {
  const f = await s.setup();
  await emptyDay(f);
  const unpaid = await f.seedWithdrawal({ status: 'APPROVED' });
  const bank = await f.seedWithdrawal({ status: 'PAID_API', channel: 'bank_card' });
  const before = { books: await books(f), stored: await stored(f), jobs: await jobs(f) };
  for (const id of [randomUUID(), unpaid.id, bank.id]) await runLate(f, id);
  expect(await books(f)).toEqual(before.books);
  expect(await stored(f)).toEqual(before.stored);
  expect(await jobs(f)).toEqual(before.jobs);
  expect(await diffs(f)).toEqual([]);
  expect(await holdsOf(f, unpaid.userId)).toEqual([]);
}, 60_000);
