// B2-15m daily-chain rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07（每日 T+1 用渠道的交易账单
// 逐笔核对：每个账单日都要核对，停机或死信隔日重放都不能漏日）；specs/ledger-rules.md 第 10 节（PAY_FEE 每个
// （渠道、账单日）一张，uniq key PAY_FEE:{pay_channel}:{bill_date}）。The next daily run is computed from the
// bill day just reconciled (bill day + 1), never from the clock: B2-15j money review r2 S2. The jobs
// run the way the worker runs them: bill.recon on queue pay through createPayJobHandler, each next
// run taken from what the previous one enqueued. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import type { JobPayload } from '../../../../apps/api/src/modules/platform/index.ts';
import { enable, suite } from '../orders/kit.ts';
import {
  AMOUNT,
  diffs,
  expectDiff,
  feeVoucherOf,
  lineOf,
  paidOrder,
  recon,
  settled,
  shape,
  vouchersLike,
  type Recon,
} from '../recon/kit.ts';
import {
  AT_ONCE_SECONDS,
  billDateOf,
  catchUpSends,
  cleanDay,
  dailySends,
  dayEndMs,
  dueMs,
  inDay,
  reconHandler,
} from './kit.ts';

const s = suite();

/** 2026-10-24 12:00 +08:00: the worker comes back after being stopped since 2026-10-22. */
const BACK = '2026-10-24T04:00:00.000Z';
/** 2026-10-23 15:00 +08:00: the dead-lettered run of the 10-21 bill is replayed. */
const REPLAYED = '2026-10-23T07:00:00.000Z';

/** The PAY_FEE vouchers of the app as uniq key → shape. */
async function fees(r: Recon) {
  return (await vouchersLike(r, 'PAY_FEE:')).map(shape);
}

it('[AC-B2-15m#4] worker 停机两天后补跑（2026-10-24 12:00 +08:00 才执行队列里 10-21 的日跑）：下一日按「已对账账单日 + 1」推算，依次补出 10-22、10-23（已过应到时段即立即到期），每个账单日各对账一次、每渠道每日 PAY_FEE 各一张、不跳日；追上后 10-24 的日跑不早于 10-24 结束', async () => {
  const r = await recon(s, BACK);
  await enable(r.f);
  const days = ['2026-10-21', '2026-10-22', '2026-10-23'];
  const dayFees: Record<string, { wechat_pay: bigint; alipay: bigint }> = {
    '2026-10-21': { wechat_pay: 21n, alipay: 121n },
    '2026-10-22': { wechat_pay: 22n, alipay: 122n },
    '2026-10-23': { wechat_pay: 23n, alipay: 123n },
  };
  for (const day of days) await cleanDay(r, day, dayFees[day]!);
  const appId = r.f.subject.app_id;
  const run = await reconHandler(r.kit);

  // The daily run of 10-21, queued before the worker stopped, runs now; then whatever each run
  // enqueued for the next day, as long as it is due at once.
  const ran: string[] = [];
  let payload: JobPayload | null = { app_id: appId, bill_date: '2026-10-21' };
  for (let step = 0; step < 6 && payload !== null; step += 1) {
    expect(await settled(run(payload)), `the run of ${String(payload['bill_date'])}`).toBe(
      'resolved',
    );
    ran.push(String(payload['bill_date']));
    const next = dailySends(r.kit, appId).at(-1);
    payload =
      next !== undefined &&
      !ran.includes(billDateOf(next)) &&
      (next.options.delaySeconds ?? 0) <= AT_ONCE_SECONDS
        ? next.payload
        : null;
  }
  expect(ran, 'every bill day reconciled, none skipped').toEqual(days);
  expect(r.channels.wechat_pay.billDates).toEqual(days);
  expect(r.channels.alipay.billDates).toEqual(days);
  const sent = dailySends(r.kit, appId);
  expect(sent.map(billDateOf)).toEqual(['2026-10-22', '2026-10-23', '2026-10-24']);
  const last = sent.at(-1);
  expect(last, 'the run of 10-24').toBeDefined();
  expect(dueMs(r.f.clock, last!), 'not before 10-24 is over').toBeGreaterThanOrEqual(
    dayEndMs('2026-10-24'),
  );
  expect(new Set(sent.map((job) => job.options.singletonKey)).size).toBe(3);

  expect(await diffs(r)).toEqual([]);
  const want = days.flatMap((day) =>
    (['wechat_pay', 'alipay'] as const).map((channel) =>
      feeVoucherOf(channel, day, dayFees[day]![channel]),
    ),
  );
  const got = await fees(r);
  expect(got).toHaveLength(want.length);
  expect(got).toEqual(expect.arrayContaining(want));
}, 120_000);

it('[AC-B2-15m#5] 死信隔日重放：10-21 的日跑（payload 带账单日）在 2026-10-23 15:00 +08:00 重放，只下载、只对账 10-21 的账单（PAY_FEE 只记 10-21），并据 10-21 推算下一日：入队账单日 2026-10-22 的日跑、立即到期，不是按当前时刻的 10-23', async () => {
  const r = await recon(s, REPLAYED);
  await enable(r.f);
  await cleanDay(r, '2026-10-21', { wechat_pay: 31n, alipay: 131n });
  // Later days have bills and paid orders of their own: none of them is touched by this replay.
  await cleanDay(r, '2026-10-22', { wechat_pay: 32n, alipay: 132n });
  await cleanDay(r, '2026-10-23', { wechat_pay: 33n, alipay: 133n });
  const appId = r.f.subject.app_id;
  const run = await reconHandler(r.kit);

  expect(await settled(run({ app_id: appId, bill_date: '2026-10-21' }))).toBe('resolved');
  expect(r.channels.wechat_pay.billDates).toEqual(['2026-10-21']);
  expect(r.channels.alipay.billDates).toEqual(['2026-10-21']);
  const got = await fees(r);
  expect(got).toHaveLength(2);
  expect(got).toEqual(
    expect.arrayContaining([
      feeVoucherOf('wechat_pay', '2026-10-21', 31n),
      feeVoucherOf('alipay', '2026-10-21', 131n),
    ]),
  );
  expect(await diffs(r)).toEqual([]);

  const sent = dailySends(r.kit, appId);
  expect(sent.map(billDateOf), 'the next daily run').toEqual(['2026-10-22']);
  const next = sent[0]!;
  expect(next.payload).toMatchObject({ app_id: appId, bill_date: '2026-10-22' });
  expect(next.payload['pay_channel']).toBeUndefined();
  expect(next.options.singletonKey ?? '').toContain(appId);
  expect(next.options.singletonKey ?? '').toContain('2026-10-22');
  expect(next.options.delaySeconds ?? 0, 'due at once').toBeLessThanOrEqual(AT_ONCE_SECONDS);
}, 60_000);

it('[AC-B2-15m#6] 补跑不影响日跑链、同一账单日不重复记账：停机后 10-21 的日跑里支付宝账单不可得 → 只入队支付宝 10-21 的补跑，日跑链照常入队 10-22；日跑重投一次不新增 PAY_FEE / 差错单；补跑拿到账单后只记支付宝 10-21 的 PAY_FEE、不再入队日跑；10-22 的日跑照常对账', async () => {
  const r = await recon(s, BACK);
  await enable(r.f);
  const appId = r.f.subject.app_id;
  const listed = await paidOrder(r, 'wechat_pay', { paidAt: inDay('2026-10-21') });
  // Paid inside 10-21, missing from the WeChat bill: one pay_mismatch of 10-21.
  const missing = await paidOrder(r, 'wechat_pay', { paidAt: inDay('2026-10-21') });
  r.channels.wechat_pay.setBill('2026-10-21', [lineOf(listed, { feeFen: 41n })]);
  const late = await paidOrder(r, 'alipay', { paidAt: inDay('2026-10-21') });
  r.channels.alipay.setBill('2026-10-21', 'unknown');
  await cleanDay(r, '2026-10-22', { wechat_pay: 42n, alipay: 142n });
  const run = await reconHandler(r.kit);

  expect(await settled(run({ app_id: appId, bill_date: '2026-10-21' }))).toBe('resolved');
  const catchUps = catchUpSends(r.kit, appId);
  expect(catchUps.length, 'a catch-up of the alipay bill').toBeGreaterThanOrEqual(1);
  for (const job of catchUps) {
    expect(job.payload).toMatchObject({
      app_id: appId,
      bill_date: '2026-10-21',
      pay_channel: 'alipay',
    });
  }
  const daily = dailySends(r.kit, appId);
  expect(daily.map(billDateOf), 'the daily chain goes on to 10-22').toEqual(['2026-10-22']);
  expect(daily[0]!.options.delaySeconds ?? 0, 'due at once').toBeLessThanOrEqual(AT_ONCE_SECONDS);
  const wechatFee = feeVoucherOf('wechat_pay', '2026-10-21', 41n);
  expect(await fees(r)).toEqual([wechatFee]);
  const first = await diffs(r);
  expect(first).toHaveLength(1);
  expectDiff(r, first[0], {
    type: 'pay_mismatch',
    refType: 'pay_order',
    refId: missing.id,
    expectedFen: AMOUNT,
    actualFen: 0n,
  });

  // The daily run of 10-21 delivered again (at least once): nothing booked or registered twice.
  expect(await settled(run({ app_id: appId, bill_date: '2026-10-21' }))).toBe('resolved');
  expect(await fees(r)).toEqual([wechatFee]);
  expect(await diffs(r)).toEqual(first);
  expect(new Set(dailySends(r.kit, appId).map(billDateOf))).toEqual(new Set(['2026-10-22']));

  // The catch-up an hour later finds the alipay bill.
  r.f.clock.advanceMs(60 * 60_000);
  r.channels.alipay.setBill('2026-10-21', [lineOf(late, { feeFen: 141n })]);
  const dailyBefore = dailySends(r.kit, appId).length;
  expect(await settled(run(catchUps[0]!.payload))).toBe('resolved');
  expect(dailySends(r.kit, appId), 'a catch-up enqueues no daily run').toHaveLength(dailyBefore);
  const alipayFee = feeVoucherOf('alipay', '2026-10-21', 141n);
  const afterCatchUp = await fees(r);
  expect(afterCatchUp).toHaveLength(2);
  expect(afterCatchUp).toEqual(expect.arrayContaining([wechatFee, alipayFee]));
  expect(await diffs(r)).toEqual(first);

  // The chain's next run: the 10-22 bills.
  const next = dailySends(r.kit, appId).at(-1);
  expect(next, 'the daily run of 10-22').toBeDefined();
  expect(await settled(run(next!.payload))).toBe('resolved');
  const all = await fees(r);
  expect(all).toHaveLength(4);
  expect(all).toEqual(
    expect.arrayContaining([
      wechatFee,
      alipayFee,
      feeVoucherOf('wechat_pay', '2026-10-22', 42n),
      feeVoucherOf('alipay', '2026-10-22', 142n),
    ]),
  );
  expect(await diffs(r)).toEqual(first);
}, 120_000);
