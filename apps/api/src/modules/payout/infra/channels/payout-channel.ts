import type { QueryResult, TransferResult } from '../../domain/channel-result.ts';

export type PayoutChannelName = 'alipay' | 'bank_card' | 'wechat';

export interface TransferRequest {
  outBizNo: string;
  netFen: bigint;
  payee: { identity: string; name: string };
  channel: PayoutChannelName;
}

/** Called only after the transfer attempt transaction commits; no transaction is accepted. */
export interface PayoutChannel {
  transfer(request: TransferRequest): Promise<TransferResult>;
  query(outBizNo: string): Promise<QueryResult>;
}
