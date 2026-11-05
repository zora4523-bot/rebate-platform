// BR-WDR-16 + BR-WDR-23: actual admin HTTP W8, real pg-boss transaction and real recon handler.
import { expect, it } from 'vitest';
import {
  answer,
  approved,
  entryOf,
  expectItems,
  newKey,
  paid,
  payee,
  reviewing,
  skipped,
  state,
  withManualAdmin,
} from '../admin-manual-paid/manual-paid-harness.ts';
import {
  BILL_DATE,
  IN_DAY,
  alertsAbout,
  books,
  channelOrderId,
  diffs,
  diffsOf,
  expectDiff,
  expectReconHold,
  holdsOf,
  lineOf,
  runs,
} from '../recon-channel/kit.ts';
import { expectQueued, jobs, lateJobs, runLate, stored, suite } from './late-paid-harness.ts';

const s = suite(true);

it('[AC-B2-09t#1] alipay W8 成功恰一个 late_paid_check，payload 三字段精确且无延迟；同 key 重放仍一个 [AC-B2-09t#5]', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  await withManualAdmin(a, async (h) => {
    const w = await approved(a, h, await payee(a, h));
    const entry = entryOf(a, w);
    const key = newKey();
    await expectItems(await h.manualPaid([entry], { key }), [paid(w.id)]);
    const job = await expectQueued(f, w.id);
    expect(await lateJobs(f)).toHaveLength(1);
    await expectItems(await h.manualPaid([entry], { key }), [paid(w.id)]);
    expect(await lateJobs(f)).toEqual([job]);
  });
}, 120_000);

it('[AC-B2-09t#2] 银行卡不入队；同批 alipay 成功照常入队，未审核条目不入队 [AC-B2-09t#3]', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  await withManualAdmin(a, async (h) => {
    const who = await payee(a, h);
    const bank = await approved(a, h, who, { method: 'bank_card' });
    const denied = await reviewing(a, h, who);
    const yes = await approved(a, h, who);
    await expectItems(await h.manualPaid([entryOf(a, bank), entryOf(a, denied), entryOf(a, yes)]), [
      paid(bank.id),
      skipped(denied.id, 'not_approved'),
      paid(yes.id),
    ]);
    await expectQueued(f, yes.id);
    expect((await lateJobs(f)).map((j) => j.data.payload['withdrawal_id'])).toEqual([yes.id]);
  });
}, 120_000);

it('[AC-B2-09t#4] audit、voucher、tax_ytd 逐项故障回滚不留任务；恢复后同 key 重试恰一个', async () => {
  for (const point of ['audit', 'voucher', 'tax_ytd'] as const) {
    const f = await s.setup();
    const a = s.admin(f);
    await withManualAdmin(a, async (h) => {
      const w = await approved(a, h, await payee(a, h));
      const entry = entryOf(a, w);
      const key = newKey();
      const before = await state(a);
      h.fault.point = point;
      await answer(await h.manualPaid([entry], { key }), 50001);
      expect(h.fault.tripped).toBe(1);
      expect(await lateJobs(f)).toEqual([]);
      expect(await state(a)).toEqual(before);
      await expectItems(await h.manualPaid([entry], { key }), [paid(w.id)]);
      await expectQueued(f, w.id);
      expect(await lateJobs(f)).toHaveLength(1);
    });
  }
}, 180_000);

it('[AC-B2-09t#6] 贯通：原样消费 W8 的真实队列任务，已 succeeded 无账单行，差错确实由该任务创建', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  f.setBill(BILL_DATE, []);
  await f.runDay();
  expect((await runs(f)).find((r) => r.bill_date === BILL_DATE)?.status).toBe('succeeded');
  await withManualAdmin(a, async (h) => {
    const who = await payee(a, h);
    const w = await approved(a, h, who, { created_at: new Date('2026-10-17T02:00:00Z') });
    await expectItems(await h.manualPaid([entryOf(a, w, { paid_at: IN_DAY.toISOString() })]), [
      paid(w.id),
    ]);
    const job = await expectQueued(f, w.id);
    expect(await diffsOf(f, [w.id])).toEqual([]);
    expect(await holdsOf(f, who.userId)).toEqual([]);
    const before = {
      stored: await stored(f),
      books: await books(f),
      calls: f.billCalls(),
      jobs: await jobs(f),
    };
    // No daily run between the empty baseline and these assertions; name/payload are untouched.
    await runLate(f, w.id, 0, {
      id: job.id,
      queue: job.name,
      name: job.data.name,
      payload: job.data.payload,
      attempt: 1,
    });
    const found = await diffsOf(f, [w.id]);
    expect(found).toHaveLength(1);
    expectDiff(f, found[0], {
      refType: 'withdrawal',
      refIds: [w.id],
      expectedFen: 12_347n,
      actualFen: 0n,
    });
    expect(found[0]).toMatchObject({
      dedupe_key: `R2:alipay:missing:wd:${w.id}`,
      resolution: { case: 'paid_not_in_bill' },
    });
    await expectReconHold(f, who.userId, found[0]);
    expect(alertsAbout(f, [w.id])).toHaveLength(1);
    expect(await stored(f)).toEqual(before.stored);
    expect(await books(f)).toEqual(before.books);
    expect(f.billCalls()).toEqual(before.calls);
    expect(await jobs(f)).toEqual(before.jobs);
  });
}, 120_000);

it('[AC-B2-09t#26] 真实 W8 补录历史 unknown_line 的流水，消费真实任务后旧差错原样保留且不冻结', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const order = channelOrderId();
  f.setBill(BILL_DATE, [
    lineOf({ outBizNo: 'manual', net: 12_347n }, { outBizNo: null, channelOrderId: order }),
  ]);
  await f.runDay();
  const before = await diffs(f);
  expect(before).toHaveLength(1);
  expect(before[0]?.resolution).toMatchObject({ case: 'unknown_line' });
  await withManualAdmin(a, async (h) => {
    const who = await payee(a, h);
    const w = await approved(a, h, who, { created_at: new Date('2026-10-17T02:00:00Z') });
    await expectItems(
      await h.manualPaid([
        entryOf(a, w, { channel_order_id: order, paid_at: IN_DAY.toISOString() }),
      ]),
      [paid(w.id)],
    );
    const job = await expectQueued(f, w.id);
    await runLate(f, w.id, 0, {
      id: job.id,
      queue: job.name,
      name: job.data.name,
      payload: job.data.payload,
      attempt: 1,
    });
    expect(await diffs(f)).toEqual(before);
    expect(await holdsOf(f, who.userId)).toEqual([]);
  });
}, 120_000);
