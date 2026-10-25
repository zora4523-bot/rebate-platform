// B2-15j: the pure part of the T+1 collection reconciliation (08 BR-PAY-07 对账; BR-PAY-05 ④). No
// clock, no database: instants, bill rows and configuration come in as arguments.
//
// parseBillRows  — the adapter's PayBillResult rows (normalised keys, PayBillRow) checked one by one;
//   one malformed row refuses the whole bill (fail closed: a bill read in part would report the
//   rest as missing). Amounts are integer fen as decimal digits, parsed by @couli/money only.
// pickLines      — one line per merchant number (out_trade_no for trades, out_refund_no for
//   refunds): a line in a listed state wins over the others of the same number.
// billFeeTotal   — Σ fee_fen of every line (PAY_FEE: one voucher per channel and bill date).
// previousBillDate / nextBillReconRunAt — the bill day D of a run on D+1 at +08:00 and the instant
//   of the next daily run, from the accounting day of @couli/domain only.
// Also compiled by the `test` project: erasable syntax only.
import { accountingDate, chinaDayRange } from '@couli/domain';
import { InvalidAmount, addFen, parseFen } from '@couli/money';

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

/** A checked bill line: amounts as bigint fen. */
export interface BillLine {
  readonly kind: 'trade' | 'refund';
  readonly outTradeNo: string;
  readonly channelTradeNo: string;
  readonly outRefundNo: string;
  readonly channelRefundNo: string;
  /** Positive integer fen. */
  readonly amountFen: bigint;
  readonly state: string;
  /** Signed integer fen (a refund may give a fee back). */
  readonly feeFen: bigint;
}

export type BillParse =
  | { readonly ok: true; readonly lines: readonly BillLine[] }
  | { readonly ok: false; readonly index: number; readonly reason: string };

const POSITIVE_DIGITS = /^[0-9]+$/;
const SIGNED_DIGITS = /^-?[0-9]+$/;

function textOf(row: Readonly<Record<string, string>>, key: string): string | null {
  const value: unknown = row[key];
  return typeof value === 'string' ? value : null;
}

function fenOf(text: string | null, pattern: RegExp): bigint | null {
  if (text === null || !pattern.test(text)) return null;
  try {
    return parseFen(text);
  } catch (error: unknown) {
    if (error instanceof InvalidAmount) return null;
    throw error;
  }
}

/** Why one row is unusable, or the checked line. */
function lineOf(row: Readonly<Record<string, string>>): BillLine | string {
  const kind = textOf(row, 'record_type');
  if (kind !== 'trade' && kind !== 'refund') return 'record_type';
  const outTradeNo = textOf(row, 'out_trade_no') ?? '';
  const channelTradeNo = textOf(row, 'channel_trade_no') ?? '';
  const outRefundNo = textOf(row, 'out_refund_no') ?? '';
  const channelRefundNo = textOf(row, 'channel_refund_no') ?? '';
  const state = textOf(row, 'state') ?? '';
  // A trade line is matched by our merchant number and, as an anomaly, kept by the channel's trade
  // number (pay_anomalies.channel_trade_no is required); a refund line by our refund number.
  if (kind === 'trade' && (outTradeNo === '' || channelTradeNo === '')) return 'trade_numbers';
  if (kind === 'refund' && outRefundNo === '') return 'out_refund_no';
  if (state === '') return 'state';
  const amountFen = fenOf(textOf(row, 'amount_fen'), POSITIVE_DIGITS);
  if (amountFen === null || amountFen <= 0n) return 'amount_fen';
  const feeFen = fenOf(textOf(row, 'fee_fen'), SIGNED_DIGITS);
  if (feeFen === null) return 'fee_fen';
  return {
    kind,
    outTradeNo,
    channelTradeNo,
    outRefundNo,
    channelRefundNo,
    amountFen,
    state,
    feeFen,
  };
}

/** Every row checked; the first unusable row refuses the bill (its index and the field). */
export function parseBillRows(rows: readonly Readonly<Record<string, string>>[]): BillParse {
  const lines: BillLine[] = [];
  for (const [index, row] of rows.entries()) {
    if (typeof row !== 'object' || row === null) return { ok: false, index, reason: 'row' };
    const line = lineOf(row);
    if (typeof line === 'string') return { ok: false, index, reason: line };
    lines.push(line);
  }
  return { ok: true, lines };
}

/**
 * One line per number of the given kind, in bill order: a line whose state is listed wins over the
 * others of the same number (a bill may list a closed attempt next to the paid one).
 */
export function pickLines(
  lines: readonly BillLine[],
  kind: BillLine['kind'],
  listed: readonly string[],
): ReadonlyMap<string, BillLine> {
  const picked = new Map<string, BillLine>();
  for (const line of lines) {
    if (line.kind !== kind) continue;
    const key = kind === 'trade' ? line.outTradeNo : line.outRefundNo;
    const held = picked.get(key);
    if (held === undefined || (!listed.includes(held.state) && listed.includes(line.state))) {
      picked.set(key, line);
    }
  }
  return picked;
}

/** Σ fee_fen of every line of the bill (bigint fen through @couli/money). */
export function billFeeTotal(lines: readonly BillLine[]): bigint {
  let total = 0n;
  for (const line of lines) total = addFen(total, line.feeFen);
  return total;
}

const MS_PER_DAY = 86_400_000;
/**
 * The daily run reconciles day D on D+1 at 10:00 +08:00, a run time chosen by this task: when each
 * channel's bill of D becomes available (CAP-X-16 / CAP-X-17 交易账单的生成时间) is not verified yet
 * (待实测, B2-15k). A run that finds no bill yet fails and is retried by the queue.
 */
export const BILL_RECON_RUN_OFFSET_MS = 10 * 3_600_000;

/** The bill day reconciled by a run at `now`: the +08:00 accounting day before it. */
export function previousBillDate(now: Date): string {
  const before = structuredClone(now);
  before.setTime(now.getTime() - MS_PER_DAY);
  return accountingDate(before);
}

/**
 * The next daily run after a run at `now`: the start of the next +08:00 accounting day plus the run
 * offset, and the bill day that run reconciles (now's own accounting day).
 */
export function nextBillReconRun(now: Date): { readonly at: Date; readonly billDate: string } {
  const today = accountingDate(now);
  const at = structuredClone(now);
  at.setTime(Date.parse(chinaDayRange(today).end) + BILL_RECON_RUN_OFFSET_MS);
  return { at, billDate: today };
}
