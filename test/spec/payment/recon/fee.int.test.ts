// B2-15j channel-fee rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07（PAY_FEE：对账时按
// 账单记渠道手续费，借 PAY_CHANNEL_FEE / 贷 CASH_PAY:{pay_channel}，按（渠道、账单日）一张）；
// specs/ledger-rules.md 第 10 节（唯一键 PAY_FEE:{pay_channel}:{bill_date}，金额为账单手续费合计，sub_type
// 为渠道；凭证经 ledger 的 post() 落账，重放返回同一结果、不重复记账）。Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { suite } from '../orders/kit.ts';
import { vouchers } from '../result/kit.ts';
import {
  BILL_DATE,
  CHANNELS,
  PREVIOUS_DAY,
  diffs,
  feeVoucherOf,
  lineOf,
  noFulfilment,
  orderRefund,
  paidOrder,
  recon,
  refundLineOf,
  shape,
  userTraces,
  vouchersLike,
} from './kit.ts';

const s = suite();

it.each(CHANNELS)(
  '[AC-B2-15j#17] %s 账单手续费合计 80 分（两行交易 74 + 6、退款行 0）→ 恰一张 PAY_FEE 凭证（唯一键 PAY_FEE:{渠道}:{账单日}，借 PAY_CHANNEL_FEE 80 / 贷 CASH_PAY:{渠道} 80，只记平台科目）；账单各行都对得上，不生成差错单',
  async (channel) => {
    const r = await recon(s);
    const a = await paidOrder(r, channel);
    const b = await paidOrder(r, channel, { amountFen: 990n });
    const earlier = await paidOrder(r, channel, { paidAt: PREVIOUS_DAY });
    const refund = await orderRefund(r, earlier, { amountFen: 500n });
    r.channels[channel].setBill(BILL_DATE, [
      lineOf(a, { feeFen: 74n }),
      lineOf(b, { feeFen: 6n }),
      refundLineOf(earlier, refund, { feeFen: 0n }),
    ]);
    await r.run(channel);
    expect(await diffs(r)).toEqual([]);
    expect((await vouchersLike(r, 'PAY_FEE:')).map(shape)).toEqual([
      feeVoucherOf(channel, BILL_DATE, 80n),
    ]);
    noFulfilment(r);
    expect(await userTraces(r.f)).toEqual({ user_accounts: 0, balances: 0, user_entries: 0 });
  },
  60_000,
);

it('[AC-B2-15j#18] PAY_FEE 按（渠道、账单日）一张：同一账单日重跑不重复记账、金额不变；另一账单日、另一渠道各自一张', async () => {
  const r = await recon(s);
  const a = await paidOrder(r, 'wechat_pay');
  const b = await paidOrder(r, 'alipay');
  const c = await paidOrder(r, 'wechat_pay', { paidAt: PREVIOUS_DAY });
  r.channels.wechat_pay.setBill(BILL_DATE, [lineOf(a, { feeFen: 30n })]);
  r.channels.wechat_pay.setBill('2026-10-20', [lineOf(c, { feeFen: 12n })]);
  r.channels.alipay.setBill(BILL_DATE, [lineOf(b, { feeFen: 45n })]);
  await r.run('wechat_pay');
  const once = await vouchers(r.f);
  r.f.clock.advanceMs(60 * 60_000);
  await r.run('wechat_pay');
  expect(await vouchers(r.f)).toEqual(once);
  await r.run('alipay');
  await r.run('wechat_pay', '2026-10-20');
  const fees = (await vouchersLike(r, 'PAY_FEE:'))
    .map(shape)
    .sort((x, y) => (x.uniq_key < y.uniq_key ? -1 : x.uniq_key > y.uniq_key ? 1 : 0));
  expect(fees).toEqual([
    feeVoucherOf('alipay', BILL_DATE, 45n),
    feeVoucherOf('wechat_pay', '2026-10-20', 12n),
    feeVoucherOf('wechat_pay', BILL_DATE, 30n),
  ]);
  expect(await diffs(r)).toEqual([]);
}, 60_000);

it('[AC-B2-15j#19] 账单手续费合计为 0 → 不写 PAY_FEE 凭证（分录金额不得为 0），其他凭证不变', async () => {
  const r = await recon(s);
  const a = await paidOrder(r, 'alipay');
  r.channels.alipay.setBill(BILL_DATE, [lineOf(a, { feeFen: 0n })]);
  const before = await vouchers(r.f);
  await r.run('alipay');
  expect(r.channels.alipay.billDates).toEqual([BILL_DATE]);
  expect(await vouchersLike(r, 'PAY_FEE:')).toEqual([]);
  expect(await vouchers(r.f)).toEqual(before);
  expect(await diffs(r)).toEqual([]);
}, 60_000);
