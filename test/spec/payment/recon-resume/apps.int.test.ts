// B2-15n resume rule test, per App and across processes (claude-independent, SPEC_REF 736d24c5): 08
// BR-PAY-07（每日 T+1 逐笔核对：每个账单日都要核对、不能漏日）；rule-test review r1 S1 (a seed that reads the
// last reconciled bill day without its App, or carries one App's day into the next App it walks,
// started a fresh App after the other's reconciled days: the fresh App's earlier bill days never
// reconciled, no diff, no alert) and S2 (a reconciled day kept in payment's module memory passed for
// persisted, because ./kit.ts workers share one module graph). App A has its first three bill days
// reconciled by process one; App B has collection from a bill day before A's resume day and nothing
// reconciled. B is the App the seed walks after A (B2-15m seedBillRecon: app_id ascending), so a
// day carried over from A moves B. Process two is a new process on a module graph of its own
// (./fresh.ts freshWorker): A resumes at the day after its own last reconciled day, B starts at its
// own first bill day, and no reconciled day of A is downloaded again. Top-level it() only (规划/11
// §4.3).
import { expect, it } from 'vitest';
import { enable, suite } from '../orders/kit.ts';
import { diffs, feeVoucherOf, paidOrder, recon } from '../recon/kit.ts';
import { billDateOf, cleanDay, dayEndMs, dueMs, inDay } from '../recon-schedule/kit.ts';
import { freshWorker } from './fresh.ts';
import { daily, drain, dueAtOnce, feeShapes } from './kit.ts';

const s = suite();

/** 2026-10-24 12:00 +08:00. */
const BACK = '2026-10-24T04:00:00.000Z';
const DAYS = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
/** A's bill days reconciled by process one. */
const DONE = ['2026-10-19', '2026-10-20', '2026-10-21'];
/** B's first bill day: before A's resume day 10-22 (a day of A's carried over moves it). */
const B_FIRST = '2026-10-19';
const FEES: Record<string, { wechat_pay: bigint; alipay: bigint }> = {
  '2026-10-19': { wechat_pay: 31n, alipay: 131n },
  '2026-10-20': { wechat_pay: 32n, alipay: 132n },
  '2026-10-21': { wechat_pay: 33n, alipay: 133n },
  '2026-10-22': { wechat_pay: 34n, alipay: 134n },
  '2026-10-23': { wechat_pay: 35n, alipay: 135n },
};

it('[AC-B2-15n#5] 已对账日按 App 各自续跑、只认库里的记录：进程一（2026-10-24 12:00 +08:00）对账 App A 的 10-19～10-21；App B（种子遍历次序在 A 之后）自 10-19 起有支付单、从未对账。全新模块图的进程二（不沿用进程一的任何内存）的种子为 A 只入队 10-22、为 B 只入队其首个账单日 10-19（都立即到期、singletonKey 含各自的 App 与账单日），不把 A 的已对账日用到 B；A 的链续跑 10-22、10-23，两渠道每个账单日只下载一次，PAY_FEE 每渠道每日一张', async () => {
  // Two Apps of one database, named so that the seed walks A first, then B.
  const apps = [await recon(s, BACK), await recon(s, BACK)].sort((x, y) =>
    x.f.subject.app_id < y.f.subject.app_id ? -1 : 1,
  );
  const r = apps[0]!;
  const other = apps[1]!;
  await enable(r.f);
  await enable(other.f);
  for (const day of DAYS) await cleanDay(r, day, FEES[day]!);
  await paidOrder(other, 'wechat_pay', { paidAt: inDay(B_FIRST) });
  await paidOrder(other, 'alipay', { paidAt: inDay('2026-10-20') });
  const appId = r.f.subject.app_id;
  const otherId = other.f.subject.app_id;
  expect(appId < otherId, 'the seed walks A before B').toBe(true);

  // Process one: nothing reconciled; A's first three bill days reconciled, then it stops.
  const first = await freshWorker(r);
  try {
    await first.seed();
    const seeded = daily(first.sent, appId);
    expect(seeded.map(billDateOf), 'nothing reconciled yet: the first bill day').toEqual([DAYS[0]]);
    expect(daily(first.sent, otherId).map(billDateOf), 'B: its first bill day').toEqual([B_FIRST]);
    const ran = await drain(first, appId, seeded[0]!.payload, DONE.length);
    expect(ran).toEqual(DONE.map((billDate) => ({ billDate, outcome: 'resolved' })));
  } finally {
    first.release();
  }
  expect(r.channels.wechat_pay.billDates).toEqual(DONE);
  expect(r.channels.alipay.billDates).toEqual(DONE);

  // Process two: a module graph of its own; only what process one stored reaches it.
  const second = await freshWorker(r);
  try {
    await second.seed();
    const resumed = daily(second.sent, appId);
    expect(resumed.map(billDateOf), 'A: the day after its last reconciled bill day').toEqual([
      '2026-10-22',
    ]);
    const job = resumed[0]!;
    expect(job.payload).toMatchObject({ app_id: appId, bill_date: '2026-10-22' });
    expect(job.options.singletonKey ?? '', 'singletonKey').toContain(appId);
    expect(job.options.singletonKey ?? '', 'singletonKey').toContain('2026-10-22');
    expect(dueAtOnce(job), 'overdue: due at once').toBe(true);

    const fresh = daily(second.sent, otherId);
    expect(fresh.map(billDateOf), "B: its own first bill day, nothing of A's").toEqual([B_FIRST]);
    expect(fresh[0]!.payload).toMatchObject({ app_id: otherId, bill_date: B_FIRST });
    expect(fresh[0]!.options.singletonKey ?? '', 'singletonKey').toContain(otherId);
    expect(fresh[0]!.options.singletonKey ?? '', 'singletonKey').toContain(B_FIRST);
    expect(dueAtOnce(fresh[0]!), 'overdue: due at once').toBe(true);

    const ran = await drain(second, appId, job.payload, 6);
    expect(ran).toEqual([
      { billDate: '2026-10-22', outcome: 'resolved' },
      { billDate: '2026-10-23', outcome: 'resolved' },
    ]);
    const last = daily(second.sent, appId).at(-1);
    expect(last, 'the run of 10-24').toBeDefined();
    expect(billDateOf(last!)).toBe('2026-10-24');
    expect(dueMs(r.f.clock, last!), 'not before 10-24 is over').toBeGreaterThanOrEqual(
      dayEndMs('2026-10-24'),
    );
  } finally {
    second.release();
  }

  expect(r.channels.wechat_pay.billDates, 'each bill of A downloaded once').toEqual(DAYS);
  expect(r.channels.alipay.billDates, 'each bill of A downloaded once').toEqual(DAYS);
  const want = DAYS.flatMap((day) =>
    (['wechat_pay', 'alipay'] as const).map((channel) =>
      feeVoucherOf(channel, day, FEES[day]![channel]),
    ),
  );
  const got = await feeShapes(r);
  expect(got).toHaveLength(want.length);
  expect(got).toEqual(expect.arrayContaining(want));
  expect(await diffs(r)).toEqual([]);
}, 240_000);
