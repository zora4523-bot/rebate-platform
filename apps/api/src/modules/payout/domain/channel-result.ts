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
  readonly result!: QueryResult;

  constructor() {
    super('CHANNEL_DISABLED');
    throw new Error('NotImplemented: ChannelDisabledError');
  }
}

/** Missing injected credentials or payout.biz_scene: fail closed before any transport call. */
export class PayoutChannelNotConfiguredError extends Error {
  constructor() {
    super('PAYOUT_CHANNEL_NOT_CONFIGURED');
    throw new Error('NotImplemented: PayoutChannelNotConfiguredError');
  }
}

/** FakeChannel exists only for PAYOUT_MODE=dry_run. */
export class PayoutModeMustBeDryRunError extends Error {
  constructor() {
    super('PAYOUT_MODE_MUST_BE_DRY_RUN');
    throw new Error('NotImplemented: PayoutModeMustBeDryRunError');
  }
}

/** BR-WDR-22: the payee name is always sent; empty or blank names never reach the transport. */
export class PayoutPayeeNameRequiredError extends Error {
  constructor() {
    super('PAYOUT_PAYEE_NAME_REQUIRED');
    throw new Error('NotImplemented: PayoutPayeeNameRequiredError');
  }
}
