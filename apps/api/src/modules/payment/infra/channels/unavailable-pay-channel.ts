// B2-15k: the channel of a process without complete credentials (BR-PAY-08 ②, task §9.9;
// NotImplemented skeleton). Every call answers unknown with reason channel_unconfigured, a
// notification is rejected, ownerAppOf is null; it throws nothing and falls back to nothing.
// Also compiled by the `test` project: erasable syntax only.
import type {
  PayBillResult,
  PayChannel,
  PayChannelIdentity,
  PayCloseResult,
  PayCreateOrderInput,
  PayCreateOrderResult,
  PayNotificationResult,
  PayQueryResult,
  PayRawNotification,
  PayRefundInput,
  PayRefundOriginal,
  PayRefundQueryResult,
  PayRefundResult,
} from '../../application/pay-channel.ts';
import type { PayChannelCode } from '../../domain/types.ts';

export class UnavailablePayChannel implements PayChannel {
  readonly channel: PayChannelCode;

  constructor(channel: PayChannelCode) {
    void channel;
    throw new Error('NotImplemented: UnavailablePayChannel.constructor');
  }

  createOrder(input: PayCreateOrderInput): Promise<PayCreateOrderResult> {
    void input;
    throw new Error('NotImplemented: UnavailablePayChannel.createOrder');
  }

  query(outTradeNo: string): Promise<PayQueryResult> {
    void outTradeNo;
    throw new Error('NotImplemented: UnavailablePayChannel.query');
  }

  close(outTradeNo: string): Promise<PayCloseResult> {
    void outTradeNo;
    throw new Error('NotImplemented: UnavailablePayChannel.close');
  }

  refund(input: PayRefundInput): Promise<PayRefundResult> {
    void input;
    throw new Error('NotImplemented: UnavailablePayChannel.refund');
  }

  refundQuery(outRefundNo: string, original?: PayRefundOriginal): Promise<PayRefundQueryResult> {
    void outRefundNo;
    void original;
    throw new Error('NotImplemented: UnavailablePayChannel.refundQuery');
  }

  verifyNotification(raw: PayRawNotification): Promise<PayNotificationResult> {
    void raw;
    throw new Error('NotImplemented: UnavailablePayChannel.verifyNotification');
  }

  ownerAppOf(identity: PayChannelIdentity): string | null {
    void identity;
    throw new Error('NotImplemented: UnavailablePayChannel.ownerAppOf');
  }

  downloadBill(date: string, appId: string): Promise<PayBillResult> {
    void date;
    void appId;
    throw new Error('NotImplemented: UnavailablePayChannel.downloadBill');
  }
}
