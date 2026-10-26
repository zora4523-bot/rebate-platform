// B2-15n catch-up rule test, a day that fails (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07（每日
// T+1 逐笔核对，每个账单日都要核对、不能漏日）；rule-test review r1 S1 (a run that made its next day due only
// when every channel of its day ended without error — the send after the channel loop skipped on a
// failure, or never reached past a thrown error — left the chain stopped for good at a bill that
// cannot be read: the same bill fails on every retry, so no later bill of either channel was ever
// downloaded and no later diff registered or alerted). One channel's bill of a bill day is
// malformed (refused as a whole on every delivery, B2-15j fail closed); however that run ends, its
// next day becomes due at once once the day's other channel is reconciled, and the chain goes on
// day by day, every later bill of both channels downloaded once. At most one daily run in flight
// stays: each next day is made due only after its previous day's bills were downloaded and the fees
// of the readable ones booked (inside the send's transaction when it has one). The worker's own
// handler and seed (./kit.ts payWorker). Top-level it() only (规划/11 §4.3).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { enable, suite } from '../orders/kit.ts';
import { feeVoucherOf, lineOf, paidOrder, recon } from '../recon/kit.ts';
import {
  BILL_RECON_JOB,
  billDateOf,
  cleanDay,
  dayEndMs,
  dueMs,
  inDay,
} from '../recon-schedule/kit.ts';
import { daily, drain, dueAtOnce, feeKeys, feeShapes, payWorker } from './kit.ts';

const s = suite();

/** 2026-10-24 12:00 +08:00: the worker comes back after being stopped since 2026-10-20. */
const BACK = '2026-10-24T04:00:00.000Z';
const DAYS = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
/** The day whose WeChat bill has a line that cannot be read. */
const BAD = '2026-10-21';
const FEES = { wechat_pay: 70n, alipay: 170n };

/** What had happened when a daily run of `billDate` was made due at once. */
interface AtSend {
  readonly billDate: string;
  readonly wechat: readonly string[];
  readonly alipay: readonly string[];
  readonly fees: readonly string[];
}

it('[AC-B2-15n#6] 某账单日一渠道对账失败不断链：停机后追赶（2026-10-24 12:00 +08:00 新进程，自 10-20 起无一日对账），10-21 微信账单有一行读不了（每次投递都整单拒绝），该日跑无论怎样结束，在本日支付宝账单已对账后立即让 10-22 到期；链照常逐日推进到 10-23、不跳日，此后两渠道每个账单日的账单都下载一次、PAY_FEE 照记；每个日跑仍在前一日账单都已下载、可读账单的 PAY_FEE 已记之后才到期；追上后 10-24 的日跑不早于 10-24 结束', async () => {
  const r = await recon(s, BACK);
  await enable(r.f);
  const appId = r.f.subject.app_id;
  for (const day of DAYS) {
    if (day === BAD) {
      const unreadable = await paidOrder(r, 'wechat_pay', { paidAt: inDay(day) });
      // fee_fen is not integer fen: parseBillRows refuses the bill as a whole.
      r.channels.wechat_pay.setBill(day, [
        { ...lineOf(unreadable, { feeFen: FEES.wechat_pay }), fee_fen: '0.70' },
      ]);
      const listed = await paidOrder(r, 'alipay', { paidAt: inDay(day) });
      r.channels.alipay.setBill(day, [lineOf(listed, { feeFen: FEES.alipay })]);
    } else {
      await cleanDay(r, day, FEES);
    }
  }

  const atSend: AtSend[] = [];
  const w = await payWorker(r, async (job) => {
    if (job.name !== BILL_RECON_JOB || job.payload['app_id'] !== appId) return;
    if (job.payload['pay_channel'] !== undefined || !dueAtOnce(job)) return;
    const handle: Kysely<DB> = job.options.trx ?? r.f.db;
    atSend.push({
      billDate: billDateOf(job),
      wechat: [...r.channels.wechat_pay.billDates],
      alipay: [...r.channels.alipay.billDates],
      fees: await feeKeys(handle, appId),
    });
  });
  try {
    await w.seed();
    const seeded = daily(w.sent, appId);
    expect(seeded.map(billDateOf), 'nothing reconciled: the first bill day').toEqual([DAYS[0]]);
    const ran = await drain(w, appId, seeded[0]!.payload, DAYS.length + 2);

    // Whatever the run of the bad day answered, the next day was made due at once by it.
    expect(
      ran.map((run) => run.billDate),
      `every bill day once, in order: ${JSON.stringify(ran)}`,
    ).toEqual(DAYS);
    for (const run of ran) {
      if (run.billDate !== BAD) expect(run.outcome, `the run of ${run.billDate}`).toBe('resolved');
    }

    const last = daily(w.sent, appId).at(-1);
    expect(last, 'the run of 10-24').toBeDefined();
    expect(billDateOf(last!)).toBe('2026-10-24');
    expect(dueMs(r.f.clock, last!), 'not before 10-24 is over').toBeGreaterThanOrEqual(
      dayEndMs('2026-10-24'),
    );
  } finally {
    w.release();
  }

  expect(r.channels.wechat_pay.billDates, 'every wechat bill downloaded once').toEqual(DAYS);
  expect(r.channels.alipay.billDates, 'every alipay bill downloaded once').toEqual(DAYS);

  // At most one in flight: each next day was made due only after its previous day was done.
  for (const [index, day] of DAYS.entries()) {
    if (index === 0) continue;
    const previous = DAYS[index - 1]!;
    const seen = atSend.filter((entry) => entry.billDate === day);
    expect(seen.length, `the run of ${day} made due at once`).toBeGreaterThanOrEqual(1);
    for (const entry of seen) {
      expect(entry.wechat, `${previous} wechat bill downloaded before ${day} was due`).toContain(
        previous,
      );
      expect(entry.alipay, `${previous} alipay bill downloaded before ${day} was due`).toContain(
        previous,
      );
      expect(entry.fees, `${previous} alipay reconciled before ${day} was due`).toContain(
        `PAY_FEE:alipay:${previous}`,
      );
      if (previous !== BAD) {
        expect(entry.fees, `${previous} wechat reconciled before ${day} was due`).toContain(
          `PAY_FEE:wechat_pay:${previous}`,
        );
      }
    }
  }

  // The unreadable bill booked nothing; every other bill of the days its fee.
  const want = DAYS.flatMap((day) => [
    ...(day === BAD ? [] : [feeVoucherOf('wechat_pay', day, FEES.wechat_pay)]),
    feeVoucherOf('alipay', day, FEES.alipay),
  ]);
  const got = await feeShapes(r);
  expect(got).toHaveLength(want.length);
  expect(got).toEqual(expect.arrayContaining(want));
}, 240_000);
