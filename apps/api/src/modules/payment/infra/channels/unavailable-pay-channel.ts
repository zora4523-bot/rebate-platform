// B2-15k: the channel of a process without usable credentials (BR-PAY-08 ②, task §9.9). Every call
// answers unknown with its reason (channel_unconfigured; in prod kms_unavailable, ruling D10-554), a
// notification is rejected, ownerAppOf is null; it throws nothing and falls back to nothing. Creating
// an order therefore answers 50306.
// Also compiled by the `test` project: erasable syntax only.
import {
  PAY_REASON_CHANNEL_UNCONFIGURED,
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

export class UnavailablePayChannel implements PayChannel {
  readonly channel: PayChannelCode;
  readonly #reason: string;

  constructor(channel: PayChannelCode, reason: string = PAY_REASON_CHANNEL_UNCONFIGURED) {
    this.channel = channel;
    this.#reason = reason;
  }

  #unknown(): Promise<{ readonly kind: 'unknown'; readonly reason: string }> {
    return Promise.resolve({ kind: 'unknown', reason: this.#reason });
  }

  createOrder(input: PayCreateOrderInput): Promise<PayCreateOrderResult> {
    void input;
    return this.#unknown();
  }

  query(outTradeNo: string): Promise<PayQueryResult> {
    void outTradeNo;
    return this.#unknown();
  }

  close(outTradeNo: string): Promise<PayCloseResult> {
    void outTradeNo;
    return this.#unknown();
  }

  refund(input: PayRefundInput): Promise<PayRefundResult> {
    void input;
    return this.#unknown();
  }

  refundQuery(outRefundNo: string, original?: PayRefundOriginal): Promise<PayRefundQueryResult> {
    void outRefundNo;
    void original;
    return this.#unknown();
  }

  verifyNotification(raw: PayRawNotification): Promise<PayNotificationResult> {
    void raw;
    return Promise.resolve({ kind: 'rejected', reason: this.#reason });
  }

  ownerAppOf(identity: PayChannelIdentity): string | null {
    void identity;
    return null;
  }

  downloadBill(date: string, appId: string): Promise<PayBillResult> {
    void date;
    void appId;
    return this.#unknown();
  }
}
