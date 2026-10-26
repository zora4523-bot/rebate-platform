// B2-15n alert rule test (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07（对账差错生成差错单并告警）；
// B2-15m money review r1 S2-a (a bill day reconciled again — a dead-lettered run replayed, a catch-up
// — alerted pay_recon_mismatch again for every diff it had already registered). A diff is
// registered once (ledger's dedupe key; registerReconDiff's answer unchanged) and alerted once: when
// it is new. A day reconciled again still registers and alerts what is new on it. Diffs, vouchers
// and dedupe keys stay as they were. bill.recon runs through the worker's own handler (./kit.ts
// payWorker: payment's production wiring of ledger). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { enable, suite } from '../orders/kit.ts';
import {
  AMOUNT,
  BILL_DATE,
  diffs,
  expectDiff,
  feeVoucherOf,
  lineOf,
  paidOrder,
  recon,
  type DiffRow,
} from '../recon/kit.ts';
import { inDay } from '../recon-schedule/kit.ts';
import { feeShapes, mismatchAlerts, payWorker } from './kit.ts';

const s = suite();

/** 2026-10-22 15:00 +08:00: the daily run of the 10-21 bills. */
const RUN = '2026-10-22T07:00:00.000Z';

/** Rows in id order (rows registered at one clock instant have no order of their own). */
function byId(rows: readonly DiffRow[]): DiffRow[] {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id));
}

it('[AC-B2-15n#3] 同一账单日重跑只对新差错告警：10-21 的日跑登记两张差错单（微信漏单、支付宝金额不符）各告警 pay_recon_mismatch 一次；次日死信重放 10-21 的日跑时又多出一笔漏单 → 只为新差错单登记并告警一次，已有的两张不再告警，其行（含去重键）不变；再跑支付宝 10-21 的补跑不告警、不新增；PAY_FEE 每渠道仍只一张', async () => {
  const r = await recon(s, RUN);
  await enable(r.f);
  const appId = r.f.subject.app_id;
  const listed = await paidOrder(r, 'wechat_pay', { paidAt: inDay(BILL_DATE) });
  const missing = await paidOrder(r, 'wechat_pay', { paidAt: inDay(BILL_DATE) });
  const short = await paidOrder(r, 'alipay', { paidAt: inDay(BILL_DATE) });
  r.channels.wechat_pay.setBill(BILL_DATE, [lineOf(listed, { feeFen: 61n })]);
  r.channels.alipay.setBill(BILL_DATE, [lineOf(short, { amountFen: AMOUNT - 1n, feeFen: 161n })]);
  const fees = [
    feeVoucherOf('wechat_pay', BILL_DATE, 61n),
    feeVoucherOf('alipay', BILL_DATE, 161n),
  ];

  const w = await payWorker(r);
  try {
    expect(await w.run({ app_id: appId, bill_date: BILL_DATE })).toBe('resolved');
    const first = await diffs(r);
    expect(first).toHaveLength(2);
    const missingDiff = first.find((row) => row.ref_id === missing.id);
    const shortDiff = first.find((row) => row.ref_id === short.id);
    expectDiff(r, missingDiff, {
      type: 'pay_mismatch',
      refType: 'pay_order',
      refId: missing.id,
      expectedFen: AMOUNT,
      actualFen: 0n,
    });
    expectDiff(r, shortDiff, {
      type: 'pay_mismatch',
      refType: 'pay_order',
      refId: short.id,
      expectedFen: AMOUNT,
      actualFen: AMOUNT - 1n,
    });
    expect(mismatchAlerts(w.logs, missing.id), 'the new diff alerted').toHaveLength(1);
    expect(mismatchAlerts(w.logs, short.id), 'the new diff alerted').toHaveLength(1);
    const feesFirst = await feeShapes(r);
    expect(feesFirst).toHaveLength(2);
    expect(feesFirst).toEqual(expect.arrayContaining(fees));

    // Settled later with paid_at inside 10-21, missing from the alipay bill: new on the replay.
    const late = await paidOrder(r, 'alipay', { paidAt: inDay(BILL_DATE) });
    r.f.clock.advanceMs(86_400_000);
    expect(await w.run({ app_id: appId, bill_date: BILL_DATE }), 'the replay').toBe('resolved');
    const replayed = await diffs(r);
    expect(replayed).toHaveLength(3);
    expect(replayed.find((row) => row.id === missingDiff!.id)).toEqual(missingDiff);
    expect(replayed.find((row) => row.id === shortDiff!.id)).toEqual(shortDiff);
    const lateDiff = replayed.find((row) => row.ref_id === late.id);
    expectDiff(r, lateDiff, {
      type: 'pay_mismatch',
      refType: 'pay_order',
      refId: late.id,
      expectedFen: AMOUNT,
      actualFen: 0n,
    });
    expect(mismatchAlerts(w.logs, missing.id), 'a known diff: no second alert').toHaveLength(1);
    expect(mismatchAlerts(w.logs, short.id), 'a known diff: no second alert').toHaveLength(1);
    expect(mismatchAlerts(w.logs, late.id), 'the new diff alerted once').toHaveLength(1);
    expect(await feeShapes(r)).toEqual(feesFirst);

    // A catch-up of the alipay 10-21 bill: nothing new, nothing alerted.
    r.f.clock.advanceMs(60 * 60_000);
    const catchUp = { app_id: appId, bill_date: BILL_DATE, pay_channel: 'alipay' };
    expect(await w.run(catchUp), 'the catch-up').toBe('resolved');
    expect(byId(await diffs(r))).toEqual(byId(replayed));
    expect(mismatchAlerts(w.logs, short.id)).toHaveLength(1);
    expect(mismatchAlerts(w.logs, late.id)).toHaveLength(1);
    expect(mismatchAlerts(w.logs, missing.id)).toHaveLength(1);
    expect(await feeShapes(r)).toEqual(feesFirst);
  } finally {
    w.release();
  }
}, 180_000);
