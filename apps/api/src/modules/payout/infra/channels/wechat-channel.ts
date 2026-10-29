// B2-06b: placeholder for the WeChat balance channel (规划/08 BR-WDR-33; implemented after the Alipay
// sandbox run, `payout.channel_enabled.wechat` off). Every call rejects with the disabled evidence.
import {
  ChannelDisabledError,
  type ChannelBillLine,
  type QueryResult,
  type TransferResult,
} from '../../domain/channel-result.ts';
import type { PayoutChannel, TransferRequest } from './payout-channel.ts';

export class WechatChannel implements PayoutChannel {
  transfer(request: TransferRequest): Promise<TransferResult> {
    void request;
    return Promise.reject(new ChannelDisabledError());
  }
  query(outBizNo: string): Promise<QueryResult> {
    void outBizNo;
    return Promise.reject(new ChannelDisabledError());
  }
  billDetails(appId: string, billDate: string): Promise<readonly ChannelBillLine[]> {
    void appId;
    void billDate;
    return Promise.reject(new ChannelDisabledError());
  }
}
