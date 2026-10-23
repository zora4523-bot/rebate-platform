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
