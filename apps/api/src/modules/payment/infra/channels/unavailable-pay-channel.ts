// B2-15k: the channel of a process without complete credentials (BR-PAY-08 ②, task §9.9). Every
// call answers unknown with reason channel_unconfigured, a notification is rejected, ownerAppOf is
// null; it throws nothing and falls back to nothing. Creating an order therefore answers 50306.
// Also compiled by the `test` project: erasable syntax only.
import {
  PAY_REASON_CHANNEL_UNCONFIGURED as REASON,
  type PayBillResult,
  type PayChannel,
  type PayChannelIdentity,
  type PayCloseResult,
  type PayCreateOrderInput,
  type PayCreateOrderResult,
  type PayNotificationResult,
  type PayQueryResult,
  type PayRawNotification,
  type PayRefundInput,
  type PayRefundOriginal,
  type PayRefundQueryResult,
  type PayRefundResult,
} from '../../application/pay-channel.ts';
import type { PayChannelCode } from '../../domain/types.ts';

function unconfigured(): Promise<{ readonly kind: 'unknown'; readonly reason: string }> {
  return Promise.resolve({ kind: 'unknown', reason: REASON });
}

export class UnavailablePayChannel implements PayChannel {
  readonly channel: PayChannelCode;

  constructor(channel: PayChannelCode) {
    this.channel = channel;
  }

  createOrder(input: PayCreateOrderInput): Promise<PayCreateOrderResult> {
    void input;
    return unconfigured();
  }

  query(outTradeNo: string): Promise<PayQueryResult> {
    void outTradeNo;
    return unconfigured();
  }

  close(outTradeNo: string): Promise<PayCloseResult> {
    void outTradeNo;
    return unconfigured();
  }

  refund(input: PayRefundInput): Promise<PayRefundResult> {
    void input;
    return unconfigured();
  }

  refundQuery(outRefundNo: string, original?: PayRefundOriginal): Promise<PayRefundQueryResult> {
    void outRefundNo;
    void original;
    return unconfigured();
  }

  verifyNotification(raw: PayRawNotification): Promise<PayNotificationResult> {
    void raw;
    return Promise.resolve({ kind: 'rejected', reason: REASON });
  }

  ownerAppOf(identity: PayChannelIdentity): string | null {
    void identity;
    return null;
  }

  downloadBill(date: string, appId: string): Promise<PayBillResult> {
    void date;
    void appId;
    return unconfigured();
  }
}
