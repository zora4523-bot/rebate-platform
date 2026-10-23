import type { QueryResult, TransferResult } from '../../domain/channel-result.ts';
import type { PayoutChannel, TransferRequest } from './payout-channel.ts';

export class WechatChannel implements PayoutChannel {
  transfer(request: TransferRequest): Promise<TransferResult> {
    void request;
    throw new Error('NotImplemented: WechatChannel.transfer');
  }

  query(outBizNo: string): Promise<QueryResult> {
    void outBizNo;
    throw new Error('NotImplemented: WechatChannel.query');
  }
}
