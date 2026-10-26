// B2-15n resume rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07（每日 T+1 用渠道的交易账单
// 逐笔核对：每个账单日都要核对、不能漏日）；B2-15m money review r2 S2 (every new process restarted each App's
// chain at its first bill day: one download of every past bill per channel on every restart). A daily
// run that reconciled an App's bill day of a channel leaves that day recorded as reconciled, in
// payment's own storage (the record's name is the implementation's); a new process seeds the chain
// at the day after the last reconciled bill day and never downloads or reconciles a reconciled day
// again; an App with no reconciled day starts, as in B2-15m, at its first bill day (first pay order
// or anomaly receipt). The new process is a new worker (./kit.ts payWorker) whose seed has no memory
// of started Apps; the bills downloaded are the channels' downloadBill dates. Top-level it() only
// (规划/11 §4.3).
import { expect, it } from 'vitest';
import { enable, suite } from '../orders/kit.ts';
import { diffs, feeVoucherOf, paidOrder, recon } from '../recon/kit.ts';
import { billDateOf, cleanDay, dayEndMs, dueMs, inDay } from '../recon-schedule/kit.ts';
import { daily, drain, dueAtOnce, feeShapes, payWorker } from './kit.ts';

const s = suite();

/** 2026-10-24 12:00 +08:00. */
const BACK = '2026-10-24T04:00:00.000Z';
const DAYS = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
const FEES: Record<string, { wechat_pay: bigint; alipay: bigint }> = {
  '2026-10-19': { wechat_pay: 19n, alipay: 119n },
  '2026-10-20': { wechat_pay: 20n, alipay: 120n },
  '2026-10-21': { wechat_pay: 21n, alipay: 121n },
  '2026-10-22': { wechat_pay: 22n, alipay: 122n },
  '2026-10-23': { wechat_pay: 23n, alipay: 123n },
};

function wantFees(days: readonly string[]) {
  return days.flatMap((day) =>
    (['wechat_pay', 'alipay'] as const).map((channel) =>
      feeVoucherOf(channel, day, FEES[day]![channel]),
    ),
  );
}

it('[AC-B2-15n#1] 已对账账单日持久记录、新进程续跑：进程一（2026-10-24 12:00 +08:00）对账 App A 的 10-19、10-20 后退出；新进程的种子为 A 只入队账单日 10-21（立即到期、singletonKey 含 A 与 10-21），不再从首日 10-19 起；续跑的链依次对账 10-21～10-23，两渠道每个账单日只下载一次（10-19、10-20 不再下载）、PAY_FEE 每渠道每日一张；无任何已对账记录的 App B 照 B2-15m 从其首个支付单会计日 10-22 起步', async () => {
  const r = await recon(s, BACK);
  await enable(r.f);
  for (const day of DAYS) await cleanDay(r, day, FEES[day]!);
  const other = await recon(s, BACK);
  await enable(other.f);
  await paidOrder(other, 'alipay', { paidAt: inDay('2026-10-22') });
  const appId = r.f.subject.app_id;
  const otherId = other.f.subject.app_id;

  // Process one: started with nothing reconciled, reconciles 10-19 and 10-20, then stops.
  const first = await payWorker(r);
  try {
    await first.seed();
    const seeded = daily(first.sent, appId);
    expect(seeded.map(billDateOf), 'nothing reconciled yet: the first bill day').toEqual([
      '2026-10-19',
    ]);
    const ran = await drain(first, appId, seeded[0]!.payload, 2);
    expect(ran).toEqual([
      { billDate: '2026-10-19', outcome: 'resolved' },
      { billDate: '2026-10-20', outcome: 'resolved' },
    ]);
  } finally {
    first.release();
  }
  expect(r.channels.wechat_pay.billDates).toEqual(['2026-10-19', '2026-10-20']);
  expect(r.channels.alipay.billDates).toEqual(['2026-10-19', '2026-10-20']);

  // A new process: nothing of process one's memory, only what was stored.
  const second = await payWorker(r);
  try {
    await second.seed();
    const resumed = daily(second.sent, appId);
    expect(resumed.map(billDateOf), 'the day after the last reconciled bill day').toEqual([
      '2026-10-21',
    ]);
    const job = resumed[0]!;
    expect(job.payload).toMatchObject({ app_id: appId, bill_date: '2026-10-21' });
    expect(job.options.singletonKey ?? '', 'singletonKey').toContain(appId);
    expect(job.options.singletonKey ?? '', 'singletonKey').toContain('2026-10-21');
    expect(dueAtOnce(job), 'overdue: due at once').toBe(true);

    const fresh = daily(second.sent, otherId);
    expect(fresh.map(billDateOf), 'no reconciled day: the first bill day').toEqual(['2026-10-22']);

    const ran = await drain(second, appId, job.payload, 6);
    expect(ran).toEqual([
      { billDate: '2026-10-21', outcome: 'resolved' },
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

  expect(r.channels.wechat_pay.billDates, 'each bill downloaded once').toEqual(DAYS);
  expect(r.channels.alipay.billDates, 'each bill downloaded once').toEqual(DAYS);
  const want = wantFees(DAYS);
  const got = await feeShapes(r);
  expect(got).toHaveLength(want.length);
  expect(got).toEqual(expect.arrayContaining(want));
  expect(await diffs(r)).toEqual([]);
}, 240_000);

it('[AC-B2-15n#2] 追上后重启不重跑历史：App A 的 10-19～10-23 已逐日对账完（2026-10-24 12:00 +08:00），新进程的种子为 A 只入队账单日 10-24 的日跑（singletonKey 含 A 与 10-24、不早于 10-24 结束到期），不入队任何已对账日，也不下载任何账单', async () => {
  const r = await recon(s, BACK);
  await enable(r.f);
  for (const day of DAYS) await cleanDay(r, day, FEES[day]!);
  const appId = r.f.subject.app_id;

  const first = await payWorker(r);
  try {
    await first.seed();
    const seeded = daily(first.sent, appId);
    expect(seeded.map(billDateOf)).toEqual(['2026-10-19']);
    const ran = await drain(first, appId, seeded[0]!.payload, 8);
    expect(ran.map((run) => run.billDate)).toEqual(DAYS);
    expect(
      ran.every((run) => run.outcome === 'resolved'),
      JSON.stringify(ran),
    ).toBe(true);
  } finally {
    first.release();
  }
  const downloaded = {
    wechat_pay: [...r.channels.wechat_pay.billDates],
    alipay: [...r.channels.alipay.billDates],
  };
  expect(downloaded).toEqual({ wechat_pay: DAYS, alipay: DAYS });
  const feesBefore = await feeShapes(r);

  const second = await payWorker(r);
  try {
    await second.seed();
    const resumed = daily(second.sent, appId);
    expect(resumed.map(billDateOf), 'only the day after the last reconciled one').toEqual([
      '2026-10-24',
    ]);
    const job = resumed[0]!;
    expect(job.payload).toMatchObject({ app_id: appId, bill_date: '2026-10-24' });
    expect(job.options.singletonKey ?? '', 'singletonKey').toContain(appId);
    expect(job.options.singletonKey ?? '', 'singletonKey').toContain('2026-10-24');
    expect(dueMs(r.f.clock, job), 'not before 10-24 is over').toBeGreaterThanOrEqual(
      dayEndMs('2026-10-24'),
    );
  } finally {
    second.release();
  }
  expect(r.channels.wechat_pay.billDates).toEqual(downloaded.wechat_pay);
  expect(r.channels.alipay.billDates).toEqual(downloaded.alipay);
  expect(await feeShapes(r)).toEqual(feesBefore);
  expect(feesBefore).toHaveLength(wantFees(DAYS).length);
}, 240_000);
