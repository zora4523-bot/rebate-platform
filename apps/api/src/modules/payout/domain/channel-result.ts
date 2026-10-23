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
  channelOrderId?: string;
  /** ISO timestamp with an explicit offset; provider time takes precedence over Clock. */
  paidAt?: string;
}

export interface TransferResult extends Omit<QueryResult, 'kind'> {
  kind: TransferKind;
  latencyMs: number;
  pauseQueue?: boolean;
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
