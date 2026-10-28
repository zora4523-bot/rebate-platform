// B2-06b: the bank-card payout channel in its closed state (规划/08 BR-WDR-32 ①: the supplier is
// not chosen; `payout.channel_enabled.bank_card` stays off). Every call rejects with the normalised
// disabled evidence; the payout review (BR-WDR-13 ③ channel_disabled) stops such withdrawals earlier.
import {
  ChannelDisabledError,
  type ChannelBillLine,
  type QueryResult,
  type TransferResult,
} from '../../domain/channel-result.ts';
import type { PayoutChannel, TransferRequest } from './payout-channel.ts';

export class BankCardChannel implements PayoutChannel {
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
