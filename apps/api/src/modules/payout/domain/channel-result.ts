// B2-06b: the normalised outcome of one payout channel call (规划/08 BR-WDR-14 / BR-WDR-28). The
// raw evidence (code, sub_code, msg) is kept next to the decision so the attempt record and the
// manual-resolution pages can show what the channel actually returned.
//
// Also compiled by the `test` project: erasable syntax only.

/** B2-06b: raw channel evidence is retained independently of the normalized decision. */
export interface ChannelRaw {
  code: string;
  subCode?: string;
  msg?: string;
}

export type QueryKind = 'success' | 'fail' | 'unknown';
export type TransferKind = QueryKind | 'payer_side';

export interface QueryResult {
  kind: QueryKind;
  raw: ChannelRaw;
  /** The channel's order status the kind was mapped from (payout.query_status_map), when given. */
  status?: string;
  channelOrderId?: string;
  /** ISO timestamp with an explicit offset; provider time takes precedence over Clock. */
  paidAt?: string;
}

export interface TransferResult extends Omit<QueryResult, 'kind'> {
  kind: TransferKind;
  latencyMs: number;
  pauseQueue?: boolean;
}

/**
 * B2-07b (BR-WDR-23): one line of the channel's bill of one accounting day, normalised by the
 * adapter. The reconciliation matches interface transfers by outBizNo and manual successes by
 * channelOrderId, and compares amountFen with net_fen.
 */
export interface ChannelBillLine {
  /** Our out_biz_no; null when the line carries none (a manual transfer; BR-WDR-22 ⑧ unverified). */
  outBizNo: string | null;
  channelOrderId: string;
  /** The transferred amount in integer fen. */
  amountFen: bigint;
  /** The channel's own status of the line, as the bill gives it. */
  status: string;
  /** 入账时间: ISO timestamp with an explicit offset. */
  bookedAt: string;
}

/**
 * B2-07b: the bill of the day cannot be had (not downloadable, not recorded, not injected). Never
 * answered with an empty bill: an empty bill would report every paid withdrawal as missing.
 */
export class PayoutBillUnavailableError extends Error {
  constructor() {
    super('PAYOUT_BILL_UNAVAILABLE');
    throw new Error('NotImplemented: PayoutBillUnavailableError');
  }
}

/** Closed adapters reject; the normalized evidence travels on the rejection. */
export class ChannelDisabledError extends Error {
  readonly result: QueryResult;
  constructor() {
    super('CHANNEL_DISABLED');
    this.name = 'ChannelDisabledError';
    this.result = { kind: 'unknown', raw: { code: 'CHANNEL_DISABLED' } };
  }
}

/** Missing injected credentials or payout.biz_scene: fail closed before any transport call. */
export class PayoutChannelNotConfiguredError extends Error {
  constructor() {
    super('PAYOUT_CHANNEL_NOT_CONFIGURED');
    this.name = 'PayoutChannelNotConfiguredError';
  }
}

/** FakeChannel exists only for PAYOUT_MODE=dry_run. */
export class PayoutModeMustBeDryRunError extends Error {
  constructor() {
    super('PAYOUT_MODE_MUST_BE_DRY_RUN');
    this.name = 'PayoutModeMustBeDryRunError';
  }
}

/** BR-WDR-22: the payee name is always sent; empty or blank names never reach the transport. */
export class PayoutPayeeNameRequiredError extends Error {
  constructor() {
    super('PAYOUT_PAYEE_NAME_REQUIRED');
    this.name = 'PayoutPayeeNameRequiredError';
  }
}

/** A transfer amount that is not a positive fen amount never reaches the gateway (money r1 S1). */
export class PayoutAmountInvalidError extends Error {
  constructor() {
    super('PAYOUT_AMOUNT_INVALID');
    this.name = 'PayoutAmountInvalidError';
  }
}
