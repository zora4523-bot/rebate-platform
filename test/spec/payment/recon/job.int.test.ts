// B2-15j worker-entry rule test (claude-independent, SPEC_REF 736d24c5; rule-test review r1): 08 BR-PAY-07
// （每日 T+1 用渠道的交易账单核对：账单日是 +08:00 会计日，运行日 D+1 核对 D），payment/AGENTS.md 硬规则 5
// （会计日只用 @couli/domain，时间只读注入的 Clock）。The reconciliation is driven the way the worker
// does: job `bill.recon` on queue pay through createPayJobHandler (apps/api/src/modules/payment/jobs/
// names.ts PayBillReconPayload: the app only, no bill date). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { enable, suite } from '../orders/kit.ts';
import { payJobHandler, received } from '../result/kit.ts';
import {
  AMOUNT,
  BILL_DATE,
  NEXT_DAY,
  NOW,
  diffs,
  expectDiff,
  lineOf,
  paidOrder,
  recon,
  settled,
} from './kit.ts';

const s = suite();

/** The reconciliation job of one app (payment/jobs/names.ts, PayJobName). */
const BILL_RECON_JOB = 'bill.recon';

const RUNS: [string, string][] = [
  ['2026-10-22 10:00 +08:00（UTC 同为 10-22）', NOW],
  ['2026-10-22 01:00 +08:00（UTC 仍是 10-21）', NEXT_DAY],
];

it.each(RUNS)(
  '[AC-B2-15j#28] 队列 pay 的 bill.recon 任务（只带 app_id、不带账单日）在 %s 运行：每个已开启渠道各下载一次 2026-10-21（+08:00 的前一会计日）的账单并核对，不取当天、不取 UTC 日期的前一天',
  async (_label, instant) => {
    const r = await recon(s, instant);
    await enable(r.f);
    const listed = await paidOrder(r, 'wechat_pay');
    // Paid inside the bill day, absent from the alipay bill: one diff proves the bill was checked.
    const missing = await paidOrder(r, 'alipay');
    r.channels.wechat_pay.setBill(BILL_DATE, [lineOf(listed)]);
    r.channels.alipay.setBill(BILL_DATE, []);
    const handler = await payJobHandler(r.kit);
    const job = received(BILL_RECON_JOB, { app_id: r.f.subject.app_id });
    expect(await settled(handler(job))).toBe('resolved');
    expect(r.channels.wechat_pay.billDates).toEqual([BILL_DATE]);
    expect(r.channels.alipay.billDates).toEqual([BILL_DATE]);
    const rows = await diffs(r);
    expect(rows).toHaveLength(1);
    expectDiff(r, rows[0], {
      type: 'pay_mismatch',
      refType: 'pay_order',
      refId: missing.id,
      expectedFen: AMOUNT,
      actualFen: 0n,
    });
  },
  60_000,
);
