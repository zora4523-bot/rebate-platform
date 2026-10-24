// B2-15b: the collection channel port (08 BR-PAY-03 / 04 / 05; task §9.6). Unrelated to payout's
// PayoutChannel. Every channel answer is ok or unknown, never «failed»: an unknown result is only
// queried, never resubmitted under another number (payment/AGENTS.md rule 7). Only createOrder,
// query and close are used by this task; the rest is typed here for B2-15c / B2-15f / B2-15k.
// Field names of the launch parameters follow the official SDK documentation and are 待实测
// (WeChat Pay CAP-X-16, Alipay CAP-X-17; contracts/openapi.yaml PayLaunch).
// Also compiled by the `test` project: erasable syntax only (no parameter properties).
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
      /**
       * B2-15c: the channel's own trade state as reported (WeChat trade_state, Alipay
       * trade_status), judged against `pay.<pay_channel>.success_states` (BR-PAY-04). A result
       * without it, or without merchantRef / appRef, never counts as paid (fail closed).
       */
      readonly channelState?: string;
      /** B2-15c: the merchant identity the channel reports (WeChat mchid, Alipay seller_id). */
      readonly merchantRef?: string;
      /** B2-15c: the application identity the channel reports (WeChat appid, Alipay app_id). */
      readonly appRef?: string;
    }
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * B2-15c: the merchant and application identity a notification or query carries (BR-PAY-04 核对
 * ①). Which app of ours it belongs to comes from the channel configuration only
 * (PayChannel.ownerAppOf); a notification never names our app_id itself.
 */
export interface PayChannelIdentity {
  readonly merchantRef: string;
  readonly appRef: string;
}

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
  { readonly kind: 'ok' } | { readonly kind: 'unknown'; readonly reason: string };

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

/**
 * B2-15c (task §9.1): a notification after the adapter verified it (WeChat: APIv3 signature, then
 * AES-256-GCM decryption of resource; Alipay: the form signature) and read its fields. Nothing of
 * a rejected notification is trusted or kept. amountFen is the channel's order total, converted
 * without floating point (Alipay total_amount is yuan text). state is the channel's own value.
 */
export type PayNotificationResult =
  | {
      readonly kind: 'ok';
      /** The channel's notification id (WeChat id, Alipay notify_id): the dedupe key. */
      readonly notifyId: string;
      readonly outTradeNo: string | null;
      readonly outRefundNo: string | null;
      readonly channelTradeNo: string;
      readonly amountFen: bigint;
      readonly state: string;
      readonly merchantRef: string;
      readonly appRef: string;
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
  /**
   * B2-15c: our app_id of a merchant / application identity, from this channel's configuration;
   * null when the identity is not ours (BR-PAY-04 核对 ①: reject, count, alert, no trace).
   */
  ownerAppOf(identity: PayChannelIdentity): string | null;
  /** The channel's bill of one accounting day (YYYY-MM-DD, +08:00). */
  downloadBill(date: string): Promise<PayBillResult>;
}

/** Thrown by PayChannelSet.of for a channel the process has no adapter for (fail closed). */
export class PayChannelUnavailable extends Error {
  readonly channel: PayChannelCode;

  constructor(channel: PayChannelCode) {
    super(`payment: no ${channel} channel adapter in this process`);
    this.name = 'PayChannelUnavailable';
    this.channel = channel;
  }
}

/**
 * The channels of the process, and the Nest injection token of them (a class token, so that the
 * rule tests can override it: `overrideProvider(PayChannelSet).useValue({ of })`). The payment
 * module provides it (`provide: PayChannelSet`): FakePayChannel instances outside prod; in prod an
 * empty set until the real adapters land (B2-15k), so every channel call fails closed
 * (payment/AGENTS.md rule 6) — unreachable anyway while prod registers no business type.
 */
export class PayChannelSet {
  readonly #channels: ReadonlyMap<PayChannelCode, PayChannel>;

  constructor(channels: readonly PayChannel[] = []) {
    this.#channels = new Map(channels.map((channel) => [channel.channel, channel]));
  }

  of(channel: PayChannelCode): PayChannel {
    const found = this.#channels.get(channel);
    if (found === undefined) throw new PayChannelUnavailable(channel);
    return found;
  }
}
