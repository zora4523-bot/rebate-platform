import type { JudgementLists } from '../../application/judgement.ts';
import type { ChannelBillLine, QueryResult, TransferResult } from '../../domain/channel-result.ts';

export type PayoutChannelName = 'alipay' | 'bank_card' | 'wechat';

export interface TransferRequest {
  outBizNo: string;
  netFen: bigint;
  payee: { identity: string; name: string };
  channel: PayoutChannelName;
}

/**
 * B2-06f (BR-WDR-17 / BR-WDR-28 / BR-WDR-13 细则): the withdrawal's app's judgement lists and
 * payout.biz_scene, read from PG by the job for this call. A live adapter judges with them (an
 * empty bizScene keeps its constructed scene); without them it keeps its constructed lists.
 */
export interface ChannelJudgement {
  lists: JudgementLists;
  bizScene?: string;
}

/** Called only after the transfer attempt transaction commits; no transaction is accepted. */
export interface PayoutChannel {
  transfer(request: TransferRequest, judgement?: ChannelJudgement): Promise<TransferResult>;
  query(outBizNo: string, judgement?: ChannelJudgement): Promise<QueryResult>;
  /**
   * B2-07b (BR-WDR-23, BR-WDR-22 ⑧): the channel's bill of one accounting day (`billDate`,
   * YYYY-MM-DD at +08:00) for one app of ours. Resolves only with a bill the channel gave (an
   * empty array is a bill without lines); otherwise rejects with PayoutBillUnavailableError
   * (closed channels: ChannelDisabledError), never with an empty or made-up bill. An adapter
   * without it has no bill: the reconciliation treats that as unavailable too.
   */
  billDetails?(appId: string, billDate: string): Promise<readonly ChannelBillLine[]>;
}
