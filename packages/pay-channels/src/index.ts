// Channel clients for WeChat Pay and Alipay: signing, calls, notification verification.
// No business rules live here: order states, code lists, retries and ledgers belong to the
// payment and payout modules (规划/08 BR-PAY, BR-WDR).
export { fenToYuan, yuanToFen } from './amount.ts';
export {
  type ChannelResult,
  describeResult,
  fetchTransport,
  type HttpRequest,
  type HttpResponse,
  type Shape,
  shapeViolation,
  type Transport,
  type UnknownReason,
  type UnknownResult,
} from './transport.ts';
export {
  type AppOrderInput,
  type AppPayParams,
  type NotificationResult,
  type RefundInput,
  type TransferInput,
  WECHAT_DEFAULT_REJECT_CODES,
  type WechatNotification,
  WechatPayClient,
  type WechatPayConfig,
} from './wechat/client.ts';
export {
  decryptWechatResource,
  encryptSensitive,
  signAppPay,
  verifyWechatSignature,
  wechatAuthorization,
} from './wechat/crypto.ts';
export {
  ALIPAY_DEFAULT_REJECT_CODES,
  AlipayClient,
  type AlipayAppPayInput,
  type AlipayConfig,
  type AlipayRefundInput,
  type AlipayTransferInput,
  topLevelMembers,
} from './alipay/client.ts';
export {
  alipaySignContent,
  alipayTimestamp,
  certSn,
  decodeDerString,
  publicKeyFromCert,
  rootCertSn,
  rsa2Sign,
  rsa2Verify,
} from './alipay/crypto.ts';
