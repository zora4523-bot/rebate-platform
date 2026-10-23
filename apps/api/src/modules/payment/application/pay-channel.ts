// B2-15b: the collection channel port (08 BR-PAY-03 / 04 / 05; task §9.6). Unrelated to payout's
// PayoutChannel. Every channel answer is ok or unknown, never «failed»: an unknown result is only
// queried, never resubmitted under another number (payment/AGENTS.md rule 7). Only createOrder,
// query and close are used by this task; the rest is typed here for B2-15c / B2-15f / B2-15k.
// Field names of the launch parameters follow the official SDK documentation and are 待实测
// (WeChat Pay CAP-X-16, Alipay CAP-X-17; contracts/openapi.yaml PayLaunch).
// NotImplemented skeleton (rule-test phase).
import type { PayChannelCode } from '../domain/types.ts';

/** WeChat Pay APP payment: the SDK's PayReq fields, signed by the server (contract PayLaunchWechatPay). */
export interface WechatLaunch {
  readonly appid: string;
  readonly partnerid: string;
  readonly prepayid: string;
  readonly package: string;
  readonly noncestr: string;
  readonly timestamp: string;
  readonly sign: string;
}

/** Alipay App payment: the complete signed order string (contract PayLaunchAlipay). */
export interface AlipayLaunch {
  readonly order_str: string;
}

export type PayLaunch = WechatLaunch | AlipayLaunch;

/** What is sent to the channel when an order is placed (外部写先落单: the row exists first). */
export interface PayCreateOrderInput {
  readonly outTradeNo: string;
  /** Integer fen; the adapter converts to yuan through @couli/money only. */
  readonly amountFen: bigint;
  /** The business type's title. */
  readonly description: string;
  /** The pay deadline given to the channel: never later than the order's expire_at. */
  readonly expireAt: Date;
  readonly notifyUrl: string;
}

export type PayCreateOrderResult =
  | { readonly kind: 'ok'; readonly launch: PayLaunch; readonly channelRef: string }
  | { readonly kind: 'unknown'; readonly reason: string };

/** Trade state as the channel reports it (orchestrator ruling D10-236 ③ adds unknown as a kind). */
export type PayTradeState = 'paid' | 'not_paid' | 'closed' | 'not_exist';

export type PayQueryResult =
  | {
      readonly kind: 'ok';
      readonly state: PayTradeState;
      readonly channelTradeNo: string | null;
      readonly amountFen: bigint | null;
    }
  | { readonly kind: 'unknown'; readonly reason: string };

export type PayCloseResult =
  | { readonly kind: 'ok'; readonly state: 'closed' | 'paid' | 'not_exist' }
  | { readonly kind: 'unknown'; readonly reason: string };

export interface PayRefundInput {
  readonly outTradeNo: string;
  readonly outRefundNo: string;
  readonly refundFen: bigint;
  readonly totalFen: bigint;
  readonly reason: string;
}

export type PayRefundResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'unknown'; readonly reason: string };

export type PayRefundQueryResult =
  | {
      readonly kind: 'ok';
      readonly state: 'success' | 'processing' | 'failed' | 'not_exist';
      readonly refundFen: bigint | null;
    }
  | { readonly kind: 'unknown'; readonly reason: string };

/** A notification as received on /notify/pay/<pay_channel> (B2-15c). */
export interface PayRawNotification {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type PayNotificationResult =
  | {
      readonly kind: 'verified';
      readonly notifyId: string;
      readonly payload: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'rejected'; readonly reason: string };

export type PayBillResult =
  | { readonly kind: 'ok'; readonly rows: readonly Readonly<Record<string, string>>[] }
  | { readonly kind: 'unknown'; readonly reason: string };

/** One collection channel (BR-PAY-03 PayChannel 接口; real adapters B2-15k, fake for tests). */
export interface PayChannel {
  readonly channel: PayChannelCode;
  createOrder(input: PayCreateOrderInput): Promise<PayCreateOrderResult>;
  query(outTradeNo: string): Promise<PayQueryResult>;
  close(outTradeNo: string): Promise<PayCloseResult>;
  refund(input: PayRefundInput): Promise<PayRefundResult>;
  refundQuery(outRefundNo: string): Promise<PayRefundQueryResult>;
  verifyNotification(raw: PayRawNotification): Promise<PayNotificationResult>;
  /** The channel's bill of one accounting day (YYYY-MM-DD, +08:00). */
  downloadBill(date: string): Promise<PayBillResult>;
}

/**
 * The channels of the process, and the Nest injection token of them (a class token, so that the
 * rule tests can override it: `overrideProvider(PayChannelSet).useValue({ of })`). The payment
 * module provides it (`provide: PayChannelSet`); prod without channel keys fails closed (B2-15k).
 */
export class PayChannelSet {
  of(channel: PayChannelCode): PayChannel {
    void channel;
    throw new Error('NotImplemented: PayChannelSet.of');
  }
}
