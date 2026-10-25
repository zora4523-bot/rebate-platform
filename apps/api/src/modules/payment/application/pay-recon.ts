// B2-15j: the T+1 collection reconciliation of one channel bill (08 BR-PAY-07 对账, BR-PAY-05 ④
// 异常收款; specs/ledger-rules.md 第 10 节 PAY_FEE). Skeleton of the rule-test round: types and
// NotImplemented only; the implementation round fills runPayBillRecon in.
//
// runPayBillRecon — downloads the bill of one (app, channel, bill date) through PayChannel
//   .downloadBill and checks it line by line against our pay orders (by out_trade_no) and refunds
//   (by out_refund_no). Every disagreement — the channel has a payment we do not have or that is not
//   PAID, we have a PAID order the channel does not list, the amounts or states differ, a refund
//   differs — is a recon diff of source R4 (type pay_mismatch, or pay_anomaly for a receipt
//   registered as an anomaly) through ledger, plus an alert. Orders and refunds are never moved by
//   the reconciliation (更正经差错单处理). The bill's fees are booked as one PAY_FEE voucher per
//   (channel, bill date). Nothing touches a user account (payment/AGENTS.md rule 1).
// Also compiled by the `test` project: erasable syntax only.
import type { PayChannelCode } from '../domain/types.ts';
import type { PayJobDeps } from '../jobs/pay-jobs.ts';

/**
 * One line of a channel bill as the adapter hands it over in PayBillResult rows. The adapters map
 * the channel's own bill columns onto these keys (WeChat 交易账单, Alipay 账务明细; 待实测, B2-15k)
 * and convert yuan to integer fen through @couli/money; the reconciliation reads nothing else.
 */
export type PayBillRow = {
  /** trade: a payment; refund: a refund of a payment. */
  readonly record_type: 'trade' | 'refund';
  /** Our merchant order number of the payment (of the original payment on a refund line). */
  readonly out_trade_no: string;
  /** The channel's trade number of the payment. */
  readonly channel_trade_no: string;
  /** Our refund number on a refund line; '' on a trade line. */
  readonly out_refund_no: string;
  /** The channel's refund number on a refund line; '' on a trade line. */
  readonly channel_refund_no: string;
  /** Integer fen as decimal digits: the payment total, or the refunded amount on a refund line. */
  readonly amount_fen: string;
  /**
   * The channel's own state of the line, judged against `pay.<pay_channel>.success_states` (trade)
   * or `pay.<pay_channel>.refund_success_states` (refund).
   */
  readonly state: string;
  /** The channel's service fee of the line, integer fen as decimal digits (may be '0'). */
  readonly fee_fen: string;
};

/** Which bill to reconcile. */
export interface PayReconInput {
  readonly app_id: string;
  readonly pay_channel: PayChannelCode;
  /** The bill's accounting day (YYYY-MM-DD, +08:00): day D, reconciled on D+1 (T+1). */
  readonly bill_date: string;
}

/**
 * Reconciles the bill of `input` (BR-PAY-07). Idempotent per (app, channel, bill date): a run
 * delivered again registers no second recon diff, anomaly or PAY_FEE voucher.
 */
export function runPayBillRecon(deps: PayJobDeps, input: PayReconInput): Promise<void> {
  void deps;
  void input;
  throw new Error('NotImplemented: runPayBillRecon');
}
