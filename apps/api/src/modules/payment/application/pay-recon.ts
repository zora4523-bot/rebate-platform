// B2-15j: the T+1 collection reconciliation (08 BR-PAY-07 对账 and 细则, BR-PAY-05 ④ 异常收款;
// specs/ledger-rules.md 第 10 节 PAY_ANOMALY / PAY_FEE).
//
// runPayBillRecon — downloads the bill of one (app, channel, bill date) through PayChannel
//   .downloadBill and checks it line by line against our pay orders (by out_trade_no) and refunds
//   (by out_refund_no). Every disagreement is an R4 recon diff registered through ledger's port
//   (period = the bill date, dedupe key per channel, bill date and reference) plus an alert:
//     trade line in a success state, our order PENDING          pay_mismatch  pay_order  0 / bill
//     our order PAID (paid inside the bill day), no trade line  pay_mismatch  pay_order  ours / 0
//     PAID, the line's amount differs                           pay_mismatch  pay_order  ours / bill
//     PAID, the line's state not in success_states             pay_mismatch  pay_order  ours / 0
//     refund line in a refund success state, no refund of ours  pay_mismatch  out_refund_no 0 / bill
//     … our refund PROCESSING or FAILED                         pay_mismatch  pay_refund 0 / bill
//     our refund SUCCESS, the amount differs                    pay_mismatch  pay_refund ours / bill
//     our refund SUCCESS, the line's state not a success        pay_mismatch  pay_refund ours / 0
//     our refund SUCCESS (inside the bill day), no refund line  pay_mismatch  pay_refund ours / 0
//   («ours / bill» = expected_fen / actual_fen, diff_fen = expected − actual, contract
//   AdminPayReconDiff.) A trade line in a success state for a CLOSED order of ours, or for a merchant
//   number we have no order of on that channel in that app, is an anomaly receipt (BR-PAY-05 ④): the
//   pay_anomalies row (once per channel trade number, evidence source recon and the bill date), its
//   PAY_ANOMALY voucher (借 CASH_PAY:{pay_channel} / 贷 PAY_SUSPENSE) and the R4 pay_anomaly diff of the
//   bill date (amounts as B2-15c's registration, D10-360: expected 0, actual and diff the received
//   amount; dedupe key pay_anomaly:<id>, the same as B2-15c), all on one transaction under the
//   order's business object lock. An anomaly already registered (by a notification, a query or an
//   earlier run) is found and nothing more is booked or registered. A line whose state is not a
//   success never counts as money received (BR-PAY-04 细则 state lists).
//   Orders and refunds are never moved, no receipt or refund voucher is written, no fulfilment is
//   enqueued (更正经差错单处理; the three ways to end a diff — query again and settle by BR-PAY-04 /
//   05, refund the anomaly receipt by BR-PAY-06, close after checking — have no operation in the
//   contract yet, the refs ref_type / ref_id are what they need). Nothing touches a user account, no
//   withdrawal is held, nothing of R2 is applied (payment/AGENTS.md rule 1).
//   The bill's fees are one PAY_FEE voucher per (channel, bill date) (借 PAY_CHANNEL_FEE / 贷
//   CASH_PAY:{pay_channel}, uniq key PAY_FEE:{pay_channel}:{bill_date}), none when the total is 0.
//   Idempotent per (app, channel, bill date), at least once delivered: recon diffs dedupe on their
//   key, anomalies on (channel, channel trade number), vouchers on their uniq key. A bill the channel
//   cannot give yet (unknown) is never read as an empty bill: nothing is written, the run fails and
//   the queue retries it. A malformed bill is refused as a whole (fail closed).
// runBillReconJob — the handler of job `bill.recon` (payload: the app only): the bill day is the
//   +08:00 accounting day before clock.now() (@couli/domain), each channel whose
//   pay.channel_enabled.<pay_channel> is on is reconciled, then the next daily run is enqueued
//   (singletonKey bill.recon:<app_id>:<bill date>). A failed channel fails the job after the others
//   ran; the retry reconciles all of them again, which changes nothing that already holds.
// Also compiled by the `test` project: erasable syntax only.
import { chinaDayRange } from '@couli/domain';
import { subFen } from '@couli/money';
import type { PostingVoucher } from '../../ledger/index.ts';
import { newUuidV7 } from '../../platform/index.ts';
import {
  billFeeTotal,
  nextBillReconRun,
  parseBillRows,
  pickLines,
  previousBillDate,
  type BillLine,
} from '../domain/pay-recon.ts';
import { delaySecondsUntil } from '../domain/pay-result.ts';
import { isSwitchOn } from '../domain/sellability.ts';
import type { PayChannelCode } from '../domain/types.ts';
import {
  findOrderById,
  findOrderByOutTradeNo,
  lockBizObject,
  registerAnomalyRow,
  type PayOrderRow,
} from '../infra/pay-order-store.ts';
import {
  findReconRefund,
  paidOrdersOfDay,
  succeededRefundsOfDay,
  type ReconRefundRow,
} from '../infra/pay-recon-store.ts';
import {
  BILL_RECON_JOB,
  PAY_QUEUE,
  billReconKey,
  type PayBillReconPayload,
} from '../jobs/names.ts';
import type { PayJobDeps } from '../jobs/pay-jobs.ts';
import type { PayBillResult, PayChannel } from './pay-channel.ts';
import { channelEnabledKey } from './pay-orders.ts';
import { refundStatesFor } from './pay-refund-result.ts';
import {
  PAY_OPERATOR,
  anomalyVoucher,
  rawConfigValue,
  successStatesFor,
} from './pay-settlement.ts';

export type { PayBillRow } from '../domain/pay-recon.ts';

/** Which bill to reconcile. */
export interface PayReconInput {
  readonly app_id: string;
  readonly pay_channel: PayChannelCode;
  /** The bill's accounting day (YYYY-MM-DD, +08:00): day D, reconciled on D+1 (T+1). */
  readonly bill_date: string;
}

/** The channels the daily run looks at, in this order (enum pay_channel). */
const RECON_CHANNELS: readonly PayChannelCode[] = Object.freeze(['wechat_pay', 'alipay']);

/** The channel could not give the bill (yet): nothing was reconciled, the run is retried. */
export class PayBillUnavailable extends Error {
  readonly payChannel: PayChannelCode;
  readonly billDate: string;

  constructor(payChannel: PayChannelCode, billDate: string) {
    super(`payment: the ${payChannel} bill of ${billDate} is not available`);
    this.name = 'PayBillUnavailable';
    this.payChannel = payChannel;
    this.billDate = billDate;
  }
}

/** The bill has a line the reconciliation cannot read: refused as a whole (fail closed). */
export class PayBillMalformed extends Error {
  readonly payChannel: PayChannelCode;
  readonly billDate: string;

  constructor(payChannel: PayChannelCode, billDate: string) {
    super(`payment: the ${payChannel} bill of ${billDate} has an unreadable line`);
    this.name = 'PayBillMalformed';
    this.payChannel = payChannel;
    this.billDate = billDate;
  }
}

/** One run's fixed facts. */
interface Run {
  readonly deps: PayJobDeps;
  readonly appId: string;
  readonly channel: PayChannelCode;
  readonly billDate: string;
  readonly base: {
    readonly app_id: string;
    readonly pay_channel: PayChannelCode;
    readonly bill_date: string;
  };
}

interface Mismatch {
  readonly refType: 'pay_order' | 'pay_refund' | 'out_refund_no';
  readonly refId: string;
  readonly expectedFen: bigint;
  readonly actualFen: bigint;
  readonly reason: string;
  readonly outTradeNo?: string;
  readonly outRefundNo?: string;
}

async function downloadBill(adapter: PayChannel, billDate: string): Promise<PayBillResult> {
  try {
    return await adapter.downloadBill(billDate);
  } catch (error: unknown) {
    // A throwing adapter is an unknown answer (payment/AGENTS.md rule 7), never an empty bill.
    return {
      kind: 'unknown',
      reason: error instanceof Error ? `adapter_error:${error.name}` : 'adapter_error',
    };
  }
}

/** The R4 pay_mismatch of one reference and its alert (ids, numbers and amounts only). */
async function registerMismatch(run: Run, mismatch: Mismatch): Promise<void> {
  const diffFen = subFen(mismatch.expectedFen, mismatch.actualFen);
  await run.deps.db.transaction().execute((trx) =>
    run.deps.ledger.registerReconDiff(trx, {
      appId: run.appId,
      type: 'pay_mismatch',
      source: 'R4',
      period: run.billDate,
      refType: mismatch.refType,
      refId: mismatch.refId,
      expectedFen: mismatch.expectedFen,
      actualFen: mismatch.actualFen,
      diffFen,
      dedupeKey: `pay_recon:${run.channel}:${run.billDate}:${mismatch.refType}:${mismatch.refId}`,
      resolution: null,
    }),
  );
  run.deps.logger.warn(
    {
      ...run.base,
      ref_type: mismatch.refType,
      ref_id: mismatch.refId,
      ...(mismatch.outTradeNo === undefined ? {} : { out_trade_no: mismatch.outTradeNo }),
      ...(mismatch.outRefundNo === undefined ? {} : { out_refund_no: mismatch.outRefundNo }),
      reason: mismatch.reason,
      expected_fen: mismatch.expectedFen.toString(),
      actual_fen: mismatch.actualFen.toString(),
      diff_fen: diffFen.toString(),
    },
    'pay_recon_mismatch',
  );
}

/**
 * BR-PAY-05 ④ for a trade line in a success state: the anomaly row, its PAY_ANOMALY voucher, the R4
 * pay_anomaly diff of the bill date and the alert, on one transaction. For a CLOSED order of ours
 * the business object lock is taken and the order re-read first (it is never moved).
 */
async function registerReconAnomaly(
  run: Run,
  line: BillLine,
  order: PayOrderRow | null,
): Promise<void> {
  const { deps } = run;
  await deps.db.transaction().execute(async (trx) => {
    if (order !== null) {
      await lockBizObject(trx, {
        appId: order.app_id,
        bizType: order.biz_type,
        bizRef: order.biz_ref,
      });
      const fresh = await findOrderById(trx, order.app_id, order.id);
      if (fresh === undefined || fresh.status !== 'CLOSED') {
        // CLOSED is terminal; anything else here is a broken read, never a reason to book.
        throw new Error('payment: the reconciled CLOSED order changed under the lock');
      }
    }
    const now = deps.clock.now();
    const { anomaly, created } = await registerAnomalyRow(trx, {
      id: newUuidV7(now),
      appId: run.appId,
      payChannel: run.channel,
      channelTradeNo: line.channelTradeNo,
      outTradeNo: line.outTradeNo,
      payOrderId: order === null ? null : order.id,
      amountFen: line.amountFen,
      evidence: {
        source: 'recon',
        bill_date: run.billDate,
        pay_channel: run.channel,
        out_trade_no: line.outTradeNo,
        channel_trade_no: line.channelTradeNo,
        channel_state: line.state,
        amount_fen: line.amountFen.toString(),
        pay_order_id: order === null ? null : order.id,
        observed_at: now.toISOString(),
      },
      createdAt: now,
    });
    // duplicate when registered before: the voucher exists already (uniq key per anomaly).
    await deps.ledger.post(trx, anomalyVoucher(anomaly));
    const fields = {
      ...run.base,
      pay_anomaly_id: anomaly.id,
      pay_order_id: anomaly.pay_order_id,
      out_trade_no: anomaly.out_trade_no,
      amount_fen: anomaly.amount_fen.toString(),
      source: 'recon',
    };
    if (!created) {
      deps.logger.info(fields, 'pay_anomaly_receipt_repeat');
      return;
    }
    await deps.ledger.registerReconDiff(trx, {
      appId: anomaly.app_id,
      type: 'pay_anomaly',
      source: 'R4',
      period: run.billDate,
      refType: 'pay_anomaly',
      refId: anomaly.id,
      expectedFen: 0n,
      actualFen: anomaly.amount_fen,
      diffFen: anomaly.amount_fen,
      dedupeKey: `pay_anomaly:${anomaly.id}`,
      resolution: null,
    });
    // The alert (BR-PAY-05 ④ 告警): ids and our merchant number only.
    deps.logger.warn(fields, 'pay_anomaly_receipt');
  });
}

/** One trade line against our order of its out_trade_no (same app, same channel). */
async function reconcileTrade(
  run: Run,
  line: BillLine,
  successStates: readonly string[],
): Promise<void> {
  const received = successStates.includes(line.state);
  const order = await findOrderByOutTradeNo(run.deps.db, run.appId, run.channel, line.outTradeNo);
  if (order === undefined) {
    if (received) await registerReconAnomaly(run, line, null);
    return;
  }
  const ref = { refType: 'pay_order' as const, refId: order.id, outTradeNo: order.out_trade_no };
  switch (order.status) {
    case 'PAID':
      if (!received) {
        await registerMismatch(run, {
          ...ref,
          expectedFen: order.amount_fen,
          actualFen: 0n,
          reason: 'trade_state_not_success',
        });
      } else if (line.amountFen !== order.amount_fen) {
        await registerMismatch(run, {
          ...ref,
          expectedFen: order.amount_fen,
          actualFen: line.amountFen,
          reason: 'trade_amount_mismatch',
        });
      }
      return;
    case 'PENDING':
      // The bill is no ground for PO2 (BR-PAY-04): reported, settled only by a query.
      if (received) {
        await registerMismatch(run, {
          ...ref,
          expectedFen: 0n,
          actualFen: line.amountFen,
          reason: 'trade_not_paid',
        });
      }
      return;
    case 'CLOSED':
      if (received) await registerReconAnomaly(run, line, order);
      return;
    default:
      throw new Error('payment: pay order in an unknown status');
  }
}

/** One refund line against our refund of its out_refund_no (its target on the same channel). */
async function reconcileRefund(
  run: Run,
  line: BillLine,
  refundSuccessStates: readonly string[],
): Promise<void> {
  const refunded = refundSuccessStates.includes(line.state);
  const refund = await findReconRefund(run.deps.db, run.appId, line.outRefundNo);
  if (refund === undefined || refund.pay_channel !== run.channel) {
    if (refunded) {
      await registerMismatch(run, {
        refType: 'out_refund_no',
        refId: line.outRefundNo,
        expectedFen: 0n,
        actualFen: line.amountFen,
        reason: 'refund_not_ours',
        outTradeNo: line.outTradeNo,
        outRefundNo: line.outRefundNo,
      });
    }
    return;
  }
  const ref = {
    refType: 'pay_refund' as const,
    refId: refund.id,
    outRefundNo: refund.out_refund_no,
  };
  if (refund.status === 'SUCCESS') {
    if (!refunded) {
      await registerMismatch(run, {
        ...ref,
        expectedFen: refund.amount_fen,
        actualFen: 0n,
        reason: 'refund_state_not_success',
      });
    } else if (line.amountFen !== refund.amount_fen) {
      await registerMismatch(run, {
        ...ref,
        expectedFen: refund.amount_fen,
        actualFen: line.amountFen,
        reason: 'refund_amount_mismatch',
      });
    }
    return;
  }
  // PROCESSING or FAILED: the refund result is judged by its notification or query only
  // (BR-PAY-06 ④); the bill is reported, the refund and its held amount stay as they are.
  if (refunded) {
    await registerMismatch(run, {
      ...ref,
      expectedFen: 0n,
      actualFen: line.amountFen,
      reason: 'refund_not_succeeded',
    });
  }
}

/** The PAY_FEE voucher of one (channel, bill date) (specs/ledger-rules.md 第 10 节). */
export function feeVoucher(
  appId: string,
  channel: PayChannelCode,
  billDate: string,
  feeFen: bigint,
): PostingVoucher {
  return {
    appId,
    uniqKey: `PAY_FEE:${channel}:${billDate}`,
    bizType: 'pay_bill',
    bizId: `${channel}:${billDate}`,
    operator: PAY_OPERATOR,
    memo: null,
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: 'PAY_FEE',
    entries: [
      {
        account: { ownerType: 'platform', subject: 'PAY_CHANNEL_FEE' },
        sub_account: 'available',
        amount_fen: feeFen,
        ledger_type: 'PAY_FEE',
        sub_type: channel,
        income_type: null,
      },
      {
        account: { ownerType: 'platform', subject: `CASH_PAY:${channel}` },
        sub_account: 'available',
        amount_fen: subFen(0n, feeFen),
        ledger_type: 'PAY_FEE',
        sub_type: channel,
        income_type: null,
      },
    ],
  };
}

/**
 * Reconciles the bill of `input` (BR-PAY-07). Idempotent per (app, channel, bill date): a run
 * delivered again registers no second recon diff, anomaly or PAY_FEE voucher.
 */
export async function runPayBillRecon(deps: PayJobDeps, input: PayReconInput): Promise<void> {
  const channel = input.pay_channel;
  const billDate = input.bill_date;
  // RangeError for anything but an existing YYYY-MM-DD (the bill day's [start, end) at +08:00).
  const day = chinaDayRange(billDate);
  const run: Run = {
    deps,
    appId: input.app_id,
    channel,
    billDate,
    base: { app_id: input.app_id, pay_channel: channel, bill_date: billDate },
  };
  const adapter = deps.channels.of(channel);
  const bill = await downloadBill(adapter, billDate);
  if (bill.kind === 'unknown') {
    deps.logger.warn({ ...run.base, reason: bill.reason }, 'pay_bill_unavailable');
    throw new PayBillUnavailable(channel, billDate);
  }
  const parsed = parseBillRows(bill.rows);
  if (!parsed.ok) {
    deps.logger.error(
      { ...run.base, row_index: parsed.index, field: parsed.reason },
      'pay_bill_malformed',
    );
    throw new PayBillMalformed(channel, billDate);
  }
  const [successStates, refundStates] = await Promise.all([
    successStatesFor(deps, input.app_id, channel),
    refundStatesFor(deps, input.app_id, channel),
  ]);

  // out_trade_no: every trade line, then our PAID orders of the bill day the bill does not list.
  const trades = pickLines(parsed.lines, 'trade', successStates);
  for (const line of trades.values()) await reconcileTrade(run, line, successStates);
  const paid = await paidOrdersOfDay(deps.db, input.app_id, channel, day.start, day.end);
  for (const order of paid) {
    if (trades.has(order.out_trade_no)) continue;
    await registerMismatch(run, {
      refType: 'pay_order',
      refId: order.id,
      outTradeNo: order.out_trade_no,
      expectedFen: order.amount_fen,
      actualFen: 0n,
      reason: 'trade_missing',
    });
  }

  // out_refund_no: every refund line, then our SUCCESS refunds of the bill day the bill does not list.
  const refunds = pickLines(parsed.lines, 'refund', refundStates.success);
  for (const line of refunds.values()) await reconcileRefund(run, line, refundStates.success);
  const succeeded: ReconRefundRow[] = await succeededRefundsOfDay(
    deps.db,
    input.app_id,
    channel,
    day.start,
    day.end,
  );
  for (const refund of succeeded) {
    if (refunds.has(refund.out_refund_no)) continue;
    await registerMismatch(run, {
      refType: 'pay_refund',
      refId: refund.id,
      outRefundNo: refund.out_refund_no,
      expectedFen: refund.amount_fen,
      actualFen: 0n,
      reason: 'refund_missing',
    });
  }

  // PAY_FEE: one voucher per (channel, bill date); an entry amount is never 0, so none for 0.
  const feeFen = billFeeTotal(parsed.lines);
  if (feeFen !== 0n) {
    const voucher = feeVoucher(input.app_id, channel, billDate, feeFen);
    await deps.db.transaction().execute((trx) => deps.ledger.post(trx, voucher));
  }
  deps.logger.info(
    {
      ...run.base,
      trade_lines: trades.size,
      refund_lines: refunds.size,
      fee_fen: feeFen.toString(),
    },
    'pay_bill_reconciled',
  );
}

function isPayload(value: unknown): value is PayBillReconPayload {
  if (typeof value !== 'object' || value === null) return false;
  const appId = (value as Record<string, unknown>)['app_id'];
  return typeof appId === 'string' && appId !== '';
}

/**
 * Enqueues the daily run after `now` for the app: the start of the next +08:00 accounting day plus
 * the run offset (domain/pay-recon.ts), keyed by the bill day it reconciles.
 */
export async function scheduleBillRecon(
  deps: Pick<PayJobDeps, 'queue'>,
  appId: string,
  now: Date,
): Promise<void> {
  const next = nextBillReconRun(now);
  const payload: PayBillReconPayload = { app_id: appId };
  await deps.queue.send(PAY_QUEUE, BILL_RECON_JOB, payload, {
    trx: null,
    singletonKey: billReconKey(appId, next.billDate),
    delaySeconds: delaySecondsUntil(now, next.at),
  });
}

// TODO(规划/11 §2.3): enqueue the first bill.recon of each app with collection on (the run then
// enqueues its own next day) — blocked on a recurring-job hook of the worker entry (platform, not
// in B2-15j's paths); until then the first run is enqueued by hand or by the task that adds it.

/** The handler of `bill.recon`: the bill day before now (+08:00) of every enabled channel. */
export async function runBillReconJob(deps: PayJobDeps, payload: unknown): Promise<void> {
  if (!isPayload(payload)) throw new Error('payment: bill.recon payload is malformed');
  const appId = payload.app_id;
  const now = deps.clock.now();
  const billDate = previousBillDate(now);
  const failed: PayChannelCode[] = [];
  for (const channel of RECON_CHANNELS) {
    const enabled = isSwitchOn(
      await rawConfigValue(deps.config, appId, channelEnabledKey(channel)),
    );
    if (!enabled) continue;
    try {
      await runPayBillRecon(deps, { app_id: appId, pay_channel: channel, bill_date: billDate });
    } catch (error: unknown) {
      failed.push(channel);
      deps.logger.error(
        {
          app_id: appId,
          pay_channel: channel,
          bill_date: billDate,
          error_name: error instanceof Error ? error.name : 'unknown',
        },
        'pay_bill_recon_failed',
      );
    }
  }
  await scheduleBillRecon(deps, appId, now);
  if (failed.length > 0) {
    throw new Error(`payment: bill reconciliation of ${billDate} failed for ${failed.join(', ')}`);
  }
}
