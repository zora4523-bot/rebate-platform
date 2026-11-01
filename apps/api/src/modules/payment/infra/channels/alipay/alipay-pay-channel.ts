// B2-15k: Alipay App payment, against a sandbox gateway outside prod (NotImplemented skeleton; the
// rule tests are test/spec/payment/channels/alipay-*.test.ts and bill.test.ts). Documents, not yet
// run against an application (BR-PAY-09): orderStr docs-mirror/alipay/app-pay/02e7gq.md, query
// 02e7gm.md, close 02e7gn.md, refund 02e7go.md, refund query 02e7gp.md, bill 02e7gr.md and
// 00dn7a.md, notification 00dn78.md, synchronous answer 00iki4.md, integration 01dcc0.md, error
// codes docs-mirror/alipay/guides/common-02km9f.md, verification browser-02mse7.md.
// Task §13: a notification without seller_id is rejected, never filled from the configuration; a
// refund notification carries the cumulative refund_fee as it is, and the refund result is the
// query's (a notification alone only keeps the text and alerts); a query that meets TRADE_FINISHED
// logs the fixed warn `pay_trade_finished`; close queries again after a verified business error.
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

/** The serial numbers of certificate mode (docs-mirror/alipay/guides/browser-02mse7.md). */
export interface AlipayCertSerials {
  readonly appCertSn: string;
  readonly alipayRootCertSn: string;
  /** The only alipay_cert_sn an answer may carry. */
  readonly alipayCertSn: string;
}

export interface AlipayPayChannelConfig {
  /** PAY_APP_ID: our app this application identity belongs to (ownerAppOf, downloadBill). */
  readonly payAppId: string;
  /** PAY_ALIPAY_APPID. */
  readonly appId: string;
  /** PAY_ALIPAY_SELLER_ID. */
  readonly sellerId: string;
  /** The official gateway in prod; PAY_ALIPAY_GATEWAY elsewhere. */
  readonly gateway: string;
  /** PAY_NOTIFY_BASE_URL. */
  readonly notifyBaseUrl: string;
  /** Certificate mode; null in public key mode. */
  readonly certSerials: AlipayCertSerials | null;
}

/** Read into memory once at startup; never logged. */
export interface AlipayPayChannelKeys {
  readonly privateKeyPem: string;
  readonly alipayPublicKeyPem: string;
}

export interface AlipayPayChannelOptions {
  readonly config: AlipayPayChannelConfig;
  readonly keys: AlipayPayChannelKeys;
  readonly transport: PayTransport;
  readonly clock: Clock;
  readonly logger: RootLogger;
}

export class AlipayPayChannel implements PayChannel {
  readonly channel: PayChannelCode;

  constructor(options: AlipayPayChannelOptions) {
    void options;
    throw new Error('NotImplemented: AlipayPayChannel.constructor');
  }

  createOrder(input: PayCreateOrderInput): Promise<PayCreateOrderResult> {
    void input;
    throw new Error('NotImplemented: AlipayPayChannel.createOrder');
  }

  query(outTradeNo: string): Promise<PayQueryResult> {
    void outTradeNo;
    throw new Error('NotImplemented: AlipayPayChannel.query');
  }

  close(outTradeNo: string): Promise<PayCloseResult> {
    void outTradeNo;
    throw new Error('NotImplemented: AlipayPayChannel.close');
  }

  refund(input: PayRefundInput): Promise<PayRefundResult> {
    void input;
    throw new Error('NotImplemented: AlipayPayChannel.refund');
  }

  refundQuery(outRefundNo: string, original?: PayRefundOriginal): Promise<PayRefundQueryResult> {
    void outRefundNo;
    void original;
    throw new Error('NotImplemented: AlipayPayChannel.refundQuery');
  }

  verifyNotification(raw: PayRawNotification): Promise<PayNotificationResult> {
    void raw;
    throw new Error('NotImplemented: AlipayPayChannel.verifyNotification');
  }

  ownerAppOf(identity: PayChannelIdentity): string | null {
    void identity;
    throw new Error('NotImplemented: AlipayPayChannel.ownerAppOf');
  }

  downloadBill(date: string, appId: string): Promise<PayBillResult> {
    void date;
    void appId;
    throw new Error('NotImplemented: AlipayPayChannel.downloadBill');
  }
}
