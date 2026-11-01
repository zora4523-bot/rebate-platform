// B2-15k: WeChat Pay APP payment, API v3, against a test merchant outside prod (NotImplemented
// skeleton; the rule tests are test/spec/payment/channels/wechat-*.test.ts and bill.test.ts).
// Documents, not yet run against a merchant account (BR-PAY-09): order
// docs-mirror/wechat-pay/pages/4013070347.txt, launch 4013070351.txt and 4012365340.txt, query
// 4013070356.txt, close 4013070360.txt, notifications 4013070368.txt and 4013070388.txt, refund
// 4013070371.txt, refund query 4013070374.txt, bill 4013071227.txt and 4013071238.txt, signatures
// 4012365342.txt and 4013053249.txt, decryption 4012071382.txt.
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
} from '../../../application/pay-channel.ts';
import type { PayChannelCode } from '../../../domain/types.ts';
import type { Clock, RootLogger } from '../../../../platform/index.ts';
import type { PayTransport } from '../transport.ts';

export interface WechatPayChannelConfig {
  /** PAY_APP_ID: our app this merchant identity belongs to (ownerAppOf, downloadBill). */
  readonly payAppId: string;
  /** PAY_WECHAT_APPID. */
  readonly appId: string;
  /** PAY_WECHAT_MCHID. */
  readonly mchId: string;
  /** PAY_WECHAT_MERCHANT_SERIAL: the serial number of the merchant API certificate. */
  readonly merchantSerial: string;
  /** PAY_WECHAT_PUBLIC_KEY_ID: the only key id a response or notification may name. */
  readonly publicKeyId: string;
  /** PAY_NOTIFY_BASE_URL. */
  readonly notifyBaseUrl: string;
}

/** Read into memory once at startup; never logged. */
export interface WechatPayChannelKeys {
  readonly privateKeyPem: string;
  readonly apiV3Key: string;
  readonly publicKeyPem: string;
}

export interface WechatPayChannelOptions {
  readonly config: WechatPayChannelConfig;
  readonly keys: WechatPayChannelKeys;
  readonly transport: PayTransport;
  readonly clock: Clock;
  readonly logger: RootLogger;
}

export class WechatPayChannel implements PayChannel {
  readonly channel: PayChannelCode;

  constructor(options: WechatPayChannelOptions) {
    void options;
    throw new Error('NotImplemented: WechatPayChannel.constructor');
  }

  createOrder(input: PayCreateOrderInput): Promise<PayCreateOrderResult> {
    void input;
    throw new Error('NotImplemented: WechatPayChannel.createOrder');
  }

  query(outTradeNo: string): Promise<PayQueryResult> {
    void outTradeNo;
    throw new Error('NotImplemented: WechatPayChannel.query');
  }

  close(outTradeNo: string): Promise<PayCloseResult> {
    void outTradeNo;
    throw new Error('NotImplemented: WechatPayChannel.close');
  }

  refund(input: PayRefundInput): Promise<PayRefundResult> {
    void input;
    throw new Error('NotImplemented: WechatPayChannel.refund');
  }

  refundQuery(outRefundNo: string, original?: PayRefundOriginal): Promise<PayRefundQueryResult> {
    void outRefundNo;
    void original;
    throw new Error('NotImplemented: WechatPayChannel.refundQuery');
  }

  verifyNotification(raw: PayRawNotification): Promise<PayNotificationResult> {
    void raw;
    throw new Error('NotImplemented: WechatPayChannel.verifyNotification');
  }

  ownerAppOf(identity: PayChannelIdentity): string | null {
    void identity;
    throw new Error('NotImplemented: WechatPayChannel.ownerAppOf');
  }

  downloadBill(date: string, appId: string): Promise<PayBillResult> {
    void date;
    void appId;
    throw new Error('NotImplemented: WechatPayChannel.downloadBill');
  }
}
