// B2-15k: WeChat Pay APP payment, API v3, against a test merchant outside prod (rule tests:
// test/spec/payment/channels/wechat-*.test.ts and bill.test.ts). Ported from task/PAY-01
// packages/pay-channels; transfers not ported. Documents, not yet run against a merchant account
// (BR-PAY-09): order docs-mirror/wechat-pay/pages/4013070347.txt, launch 4013070351.txt and
// 4012365340.txt, query 4013070356.txt, close 4013070360.txt, notifications 4013070368.txt and
// 4013070388.txt, refund 4013070371.txt, refund query 4013070374.txt, bill 4013071227.txt and
// 4013071238.txt, signatures 4012365342.txt and 4013053249.txt, decryption 4012071382.txt.
// An answer is ok or unknown, never failed (payment/AGENTS.md rule 7; r3 must-fix ①): a signature
// proves who answered, so an answer is believed only when it is also of the expected status, carries
// this request's numbers and has its fields well-formed (r3 must-fix ②④). The one error that is
// a result is the query's 404 + ORDER_NOT_EXIST, matched on interface, status and code together.
// Also compiled by the `test` project: erasable syntax only.
import { createHash, randomBytes } from 'node:crypto';
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
  PayTradeState,
} from '../../../application/pay-channel.ts';
import { NOTIFY_ROUTES } from '../../../application/notify-routes.ts';
import type { PayChannelCode } from '../../../domain/types.ts';
import { fenToJsonNumber } from '@couli/money';
import type { Clock, RootLogger } from '../../../../platform/index.ts';
import {
  API_TIMEOUT_MS,
  BILL_DATE,
  BILL_MAX_BYTES,
  BILL_TIMEOUT_MS,
  channelErrorReason,
  echoConflicts,
  fenFromJson,
  isNonEmptyString,
  isObject,
  notifyAddress,
  parseJsonObject,
  rfc3339China,
  transportFailureReason,
  unverifiedErrorReason,
  type Json,
} from '../channel-common.ts';
import type { PayHttpResponse, PayTransport } from '../transport.ts';
import {
  decryptWechatResource,
  verifyWechatSignature,
  wechatAuthorization,
  wechatLaunchSign,
} from './wechat-crypto.ts';

/** docs-mirror/wechat-pay/pages/4013070347.txt: the merchant API domain; a test merchant uses it too. */
const API_BASE = 'https://api.mch.weixin.qq.com';
/** ±299 seconds pass, ±300 do not (r3: the bound of the official Go SDK; 4013053249.txt: 5 minutes). */
const MAX_CLOCK_SKEW_SECONDS = 300;
/** docs-mirror/wechat-pay/pages/4013070368.txt:23. */
const PAY_EVENT = 'TRANSACTION.SUCCESS';
/** docs-mirror/wechat-pay/pages/4013070388.txt:151-153. */
const REFUND_EVENTS: ReadonlySet<string> = new Set([
  'REFUND.SUCCESS',
  'REFUND.ABNORMAL',
  'REFUND.CLOSED',
]);

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

/** An answer after the envelope: a fixed reason, or one that verified (its JSON, when it is an object). */
type Answer =
  | { readonly kind: 'failed'; readonly reason: string }
  | {
      readonly kind: 'verified';
      readonly status: number;
      readonly text: string;
      readonly json: Json | null;
    };

type Echo = Readonly<Record<string, string | null | undefined>>;

/** amount.total and friends: docs mark currency required on some answers, optional on others. */
function currencyOk(amount: Json, required: boolean): boolean {
  if (!('currency' in amount)) return !required;
  return amount['currency'] === 'CNY';
}

function tradeSummary(state: string): PayTradeState {
  // Only a summary (pay-settlement judges channelState). REFUND, REVOKED, USERPAYING, PAYERROR and
  // states no document lists are not paid and not closed: a close then stays unknown.
  if (state === 'SUCCESS') return 'paid';
  if (state === 'CLOSED') return 'closed';
  return 'not_paid';
}

function refundSummary(status: string): 'success' | 'processing' | 'failed' {
  // Only a summary (the state lists judge channelState, BR-PAY-06 ④; 4013070374.txt:603-607).
  if (status === 'SUCCESS') return 'success';
  if (status === 'CLOSED' || status === 'ABNORMAL') return 'failed';
  return 'processing';
}

export class WechatPayChannel implements PayChannel {
  readonly channel: PayChannelCode = 'wechat_pay';
  readonly #config: WechatPayChannelConfig;
  readonly #keys: WechatPayChannelKeys;
  readonly #transport: PayTransport;
  readonly #clock: Clock;
  readonly #logger: RootLogger;

  constructor(options: WechatPayChannelOptions) {
    this.#config = options.config;
    this.#keys = options.keys;
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#logger = options.logger;
  }

  async createOrder(input: PayCreateOrderInput): Promise<PayCreateOrderResult> {
    const notifyUrl = notifyAddress(input.notifyUrl, this.#config.notifyBaseUrl);
    const built = this.#orderFields(input);
    if (notifyUrl === null || built === null) return this.#unknown('create_order', 'invalid_input');
    const answer = await this.#exchange(
      'POST',
      '/v3/pay/transactions/app',
      {
        appid: this.#config.appId,
        mchid: this.#config.mchId,
        description: input.description,
        out_trade_no: input.outTradeNo,
        time_expire: built.timeExpire,
        notify_url: notifyUrl,
        amount: { total: built.total, currency: 'CNY' },
      },
      { out_trade_no: input.outTradeNo },
    );
    const json = this.#successJson('create_order', answer);
    if ('kind' in json) return json;
    const prepayId = json.body['prepay_id'];
    if (!isNonEmptyString(prepayId)) return this.#unknown('create_order', 'bad_body');
    const timestamp = String(this.#nowSeconds());
    const nonce = randomBytes(16).toString('hex');
    let sign: string;
    try {
      sign = wechatLaunchSign(
        this.#config.appId,
        timestamp,
        nonce,
        prepayId,
        this.#keys.privateKeyPem,
      );
    } catch {
      return this.#unknown('create_order', 'sign_failed');
    }
    return {
      kind: 'ok',
      channelRef: prepayId,
      launch: {
        appid: this.#config.appId,
        partnerid: this.#config.mchId,
        prepayid: prepayId,
        package: 'Sign=WXPay',
        noncestr: nonce,
        timestamp,
        sign,
      },
    };
  }

  #orderFields(
    input: PayCreateOrderInput,
  ): { readonly total: number; readonly timeExpire: string } | null {
    if (input.amountFen <= 0n) return null;
    try {
      // RFC 3339 drops the milliseconds: never later than expire_at (BR-PAY-03).
      return { total: fenToJsonNumber(input.amountFen), timeExpire: rfc3339China(input.expireAt) };
    } catch {
      return null;
    }
  }

  async query(outTradeNo: string): Promise<PayQueryResult> {
    const answer = await this.#exchange(
      'GET',
      `${this.#tradePath(outTradeNo)}?mchid=${encodeURIComponent(this.#config.mchId)}`,
      undefined,
      { out_trade_no: outTradeNo },
    );
    if (
      answer.kind === 'verified' &&
      answer.status === 404 &&
      answer.json?.['code'] === 'ORDER_NOT_EXIST'
    ) {
      return { kind: 'ok', state: 'not_exist', channelTradeNo: null, amountFen: null };
    }
    const json = this.#successJson('query', answer);
    if ('kind' in json) return json;
    return this.#tradeResult(json.body);
  }

  #tradeResult(trade: Json): PayQueryResult {
    const { appid, mchid, out_trade_no: outTradeNo, trade_state: state } = trade;
    const tradeNo = trade['transaction_id'];
    if (
      !isNonEmptyString(appid) ||
      !isNonEmptyString(mchid) ||
      !isNonEmptyString(outTradeNo) ||
      !isNonEmptyString(state) ||
      (tradeNo !== undefined && !isNonEmptyString(tradeNo))
    ) {
      return this.#unknown('query', 'bad_body');
    }
    // 4013070356.txt:461,497,500: transaction_id and amount are optional; a paid trade has them.
    let amountFen: bigint | null = null;
    if ('amount' in trade) {
      const amount = trade['amount'];
      if (!isObject(amount) || !currencyOk(amount, false)) {
        return this.#unknown('query', 'bad_body');
      }
      amountFen = fenFromJson(amount['total']);
      if (amountFen === null) return this.#unknown('query', 'bad_body');
    }
    if (state === 'SUCCESS' && (tradeNo === undefined || amountFen === null)) {
      return this.#unknown('query', 'bad_body');
    }
    return {
      kind: 'ok',
      state: tradeSummary(state),
      channelState: state,
      channelTradeNo: tradeNo ?? null,
      amountFen,
      merchantRef: mchid,
      appRef: appid,
    };
  }

  /**
   * BR-PAY-05 ②, task §13: neither 204 nor a verified business error says the order is closed; one
   * more query decides. An answer that did not verify, has no code or names another order is no
   * answer to this close: unknown, whatever a query would say. No list of codes here (a verified
   * error of any code is queried), so a code the documents do not list cannot leave an order open.
   */
  async close(outTradeNo: string): Promise<PayCloseResult> {
    const answer = await this.#exchange(
      'POST',
      `${this.#tradePath(outTradeNo)}/close`,
      { mchid: this.#config.mchId },
      { out_trade_no: outTradeNo },
    );
    if (answer.kind === 'failed') return this.#unknown('close', answer.reason);
    const accepted = answer.status === 204 && answer.text === '';
    const businessError =
      answer.status >= 400 && answer.status < 600 && isNonEmptyString(answer.json?.['code']);
    if (!accepted && !businessError) return this.#unknown('close', 'bad_status');
    const queried = await this.query(outTradeNo);
    if (queried.kind === 'unknown') return this.#unknown('close', queried.reason);
    if (queried.state === 'not_paid') return this.#unknown('close', 'close_not_confirmed');
    return { kind: 'ok', state: queried.state };
  }

  /** ok only says the refund was accepted: the result comes from refundQuery or the notification. */
  async refund(input: PayRefundInput): Promise<PayRefundResult> {
    const notifyUrl = notifyAddress(NOTIFY_ROUTES.wechat_pay, this.#config.notifyBaseUrl);
    const amount = this.#refundAmount(input);
    if (
      notifyUrl === null ||
      amount === null ||
      (input.outTradeNo === null && input.channelTradeNo === null)
    ) {
      return this.#unknown('refund', 'invalid_input');
    }
    const answer = await this.#exchange(
      'POST',
      '/v3/refund/domestic/refunds',
      {
        // 4013070371.txt: one of the two names the original. `reason` (optional, line 39) is shown
        // to the user; input.reason is our internal code, so it stays home.
        ...(input.outTradeNo === null
          ? { transaction_id: input.channelTradeNo }
          : { out_trade_no: input.outTradeNo }),
        out_refund_no: input.outRefundNo,
        notify_url: notifyUrl,
        amount: { refund: amount.refund, total: amount.total, currency: 'CNY' },
      },
      {
        out_refund_no: input.outRefundNo,
        out_trade_no: input.outTradeNo,
        transaction_id: input.channelTradeNo,
      },
    );
    const json = this.#successJson('refund', answer);
    if ('kind' in json) return json;
    const fields = this.#refundFields(json.body);
    if (
      fields === null ||
      fields.refundFen !== input.refundFen ||
      fields.totalFen !== input.totalFen
    ) {
      return this.#unknown('refund', 'bad_body');
    }
    return { kind: 'ok' };
  }

  #refundAmount(input: PayRefundInput): { readonly refund: number; readonly total: number } | null {
    if (input.refundFen <= 0n || input.refundFen > input.totalFen) return null;
    try {
      return { refund: fenToJsonNumber(input.refundFen), total: fenToJsonNumber(input.totalFen) };
    } catch {
      return null;
    }
  }

  /** The identity, state and amount fields of a refund answer (4013070371.txt, 4013070374.txt). */
  #refundFields(refund: Json): {
    readonly status: string;
    readonly refundId: string;
    readonly outTradeNo: string;
    readonly tradeNo: string;
    readonly refundFen: bigint;
    readonly totalFen: bigint;
  } | null {
    const { refund_id: refundId, out_refund_no: outRefundNo, status } = refund;
    const { out_trade_no: outTradeNo, transaction_id: tradeNo, amount } = refund;
    if (
      !isNonEmptyString(refundId) ||
      !isNonEmptyString(outRefundNo) ||
      !isNonEmptyString(outTradeNo) ||
      !isNonEmptyString(tradeNo) ||
      !isNonEmptyString(status) ||
      !isObject(amount) ||
      !currencyOk(amount, true)
    ) {
      return null;
    }
    const refundFen = fenFromJson(amount['refund']);
    const totalFen = fenFromJson(amount['total']);
    if (refundFen === null || totalFen === null || refundFen > totalFen) return null;
    return { status, refundId, outTradeNo, tradeNo, refundFen, totalFen };
  }

  async refundQuery(
    outRefundNo: string,
    original?: PayRefundOriginal,
  ): Promise<PayRefundQueryResult> {
    const answer = await this.#exchange(
      'GET',
      `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`,
      undefined,
      {
        out_refund_no: outRefundNo,
        out_trade_no: original?.outTradeNo,
        transaction_id: original?.channelTradeNo,
      },
    );
    const json = this.#successJson('refund_query', answer);
    if ('kind' in json) return json;
    const fields = this.#refundFields(json.body);
    if (fields === null) return this.#unknown('refund_query', 'bad_body');
    return {
      kind: 'ok',
      state: refundSummary(fields.status),
      channelState: fields.status,
      refundFen: fields.refundFen,
      outTradeNo: fields.outTradeNo,
      channelTradeNo: fields.tradeNo,
      channelRefundNo: fields.refundId,
      // 4013070374.txt has neither appid nor mchid on this answer: both come from this channel's
      // configuration, the request having been signed and answered under that merchant. A field the
      // answer does carry was compared in #exchange.
      merchantRef: this.#config.mchId,
      appRef: this.#config.appId,
    };
  }

  /** BR-PAY-04, BR-PAY-08 ③: anything that does not pass is rejected with a fixed reason. */
  verifyNotification(raw: PayRawNotification): Promise<PayNotificationResult> {
    return Promise.resolve(this.#notification(raw));
  }

  #notification(raw: PayRawNotification): PayNotificationResult {
    const failure = this.#envelopeFailure(raw.headers, raw.body);
    if (failure !== null) return { kind: 'rejected', reason: failure };
    const outer = parseJsonObject(raw.body);
    if (outer === null) return { kind: 'rejected', reason: 'bad_body' };
    const { id, event_type: eventType, resource } = outer;
    if (!isNonEmptyString(id) || !isObject(resource)) {
      return { kind: 'rejected', reason: 'bad_body' };
    }
    const isPay = eventType === PAY_EVENT;
    if (!isPay && !(typeof eventType === 'string' && REFUND_EVENTS.has(eventType))) {
      return { kind: 'rejected', reason: 'unsupported_event' };
    }
    const plain = this.#decrypted(resource);
    if (plain === null) return { kind: 'rejected', reason: 'bad_resource' };
    const result = isPay ? this.#payNotification(id, plain) : this.#refundNotification(id, plain);
    return result ?? { kind: 'rejected', reason: 'bad_body' };
  }

  #decrypted(resource: Json): Json | null {
    const { algorithm, ciphertext, nonce } = resource;
    const associatedData = resource['associated_data'] ?? '';
    if (
      algorithm !== 'AEAD_AES_256_GCM' ||
      typeof ciphertext !== 'string' ||
      typeof nonce !== 'string' ||
      typeof associatedData !== 'string'
    ) {
      return null;
    }
    try {
      return parseJsonObject(
        decryptWechatResource(this.#keys.apiV3Key, ciphertext, nonce, associatedData),
      );
    } catch {
      return null;
    }
  }

  /** 4013070368.txt: amountFen is the order total, not what the payer paid (BR-PAY-04 细则). */
  #payNotification(notifyId: string, trade: Json): PayNotificationResult | null {
    const { appid, mchid, out_trade_no: outTradeNo, trade_state: state } = trade;
    const { transaction_id: tradeNo, amount } = trade;
    if (
      !isNonEmptyString(appid) ||
      !isNonEmptyString(mchid) ||
      !isNonEmptyString(outTradeNo) ||
      !isNonEmptyString(tradeNo) ||
      !isNonEmptyString(state) ||
      !isObject(amount) ||
      !currencyOk(amount, true)
    ) {
      return null;
    }
    const amountFen = fenFromJson(amount['total']);
    if (amountFen === null) return null;
    return {
      kind: 'ok',
      notifyId,
      outTradeNo,
      outRefundNo: null,
      channelTradeNo: tradeNo,
      amountFen,
      state,
      merchantRef: mchid,
      appRef: appid,
    };
  }

  /**
   * 4013070388.txt:246-310: mchid but no appid, which then comes from this channel's configuration
   * (the merchant is still compared by ownerAppOf). amount.refund, not payer_refund.
   */
  #refundNotification(notifyId: string, refund: Json): PayNotificationResult | null {
    const { mchid, out_trade_no: outTradeNo, out_refund_no: outRefundNo } = refund;
    const { transaction_id: tradeNo, refund_id: refundId, refund_status: state, amount } = refund;
    const appId = refund['appid'] ?? this.#config.appId;
    if (
      !isNonEmptyString(mchid) ||
      !isNonEmptyString(appId) ||
      !isNonEmptyString(outTradeNo) ||
      !isNonEmptyString(outRefundNo) ||
      !isNonEmptyString(tradeNo) ||
      !isNonEmptyString(refundId) ||
      !isNonEmptyString(state) ||
      !isObject(amount) ||
      !currencyOk(amount, false)
    ) {
      return null;
    }
    const refundFen = fenFromJson(amount['refund']);
    const amountFen = fenFromJson(amount['total']);
    if (refundFen === null || amountFen === null) return null;
    return {
      kind: 'ok',
      notifyId,
      outTradeNo,
      outRefundNo,
      channelTradeNo: tradeNo,
      amountFen,
      refundFen,
      channelRefundNo: refundId,
      state,
      merchantRef: mchid,
      appRef: appId,
    };
  }

  ownerAppOf(identity: PayChannelIdentity): string | null {
    return identity.merchantRef === this.#config.mchId && identity.appRef === this.#config.appId
      ? this.#config.payAppId
      : null;
  }

  /**
   * Task §9.7: applies, downloads and checks the SHA1, and stops there: no document gives a reliable
   * file format (4013071238.txt has no column definitions), so a good file still answers unknown
   * with bill_format_unverified until a real sample arrives. The file's response carries no
   * signature (4013071238.txt:133).
   */
  async downloadBill(date: string, appId: string): Promise<PayBillResult> {
    if (appId !== this.#config.payAppId) return this.#unknown('bill', 'bill_app_mismatch');
    if (!BILL_DATE.test(date)) return this.#unknown('bill', 'invalid_input');
    const answer = await this.#exchange(
      'GET',
      `/v3/bill/tradebill?bill_date=${encodeURIComponent(date)}`,
      undefined,
      {},
    );
    const json = this.#successJson('bill', answer);
    if ('kind' in json) return json;
    const { hash_type: hashType, hash_value: hashValue, download_url: downloadUrl } = json.body;
    if (hashType !== 'SHA1' || !isNonEmptyString(hashValue) || !isNonEmptyString(downloadUrl)) {
      return this.#unknown('bill', 'bad_body');
    }
    const target = this.#billUrl(downloadUrl);
    if (target === null) return this.#unknown('bill', 'bad_body');
    let file: PayHttpResponse;
    try {
      file = await this.#transport({
        method: 'GET',
        url: downloadUrl,
        headers: this.#headers('GET', `${target.pathname}${target.search}`, ''),
        timeoutMs: BILL_TIMEOUT_MS,
        maxResponseBytes: BILL_MAX_BYTES,
      });
    } catch {
      return this.#unknown('bill', 'bill_download_failed');
    }
    if (file.status !== 200) return this.#unknown('bill', 'bill_download_failed');
    const digest = createHash('sha1')
      .update(file.bytes ?? Buffer.from(file.body, 'utf8'))
      .digest('hex');
    if (digest !== hashValue.toLowerCase()) return this.#unknown('bill', 'bill_hash_mismatch');
    return this.#unknown('bill', 'bill_format_unverified');
  }

  /**
   * The download request carries our Authorization header, so it goes to https on the merchant API
   * domain only (4013071227.txt:492 shows that domain); anything else is not downloaded.
   */
  #billUrl(downloadUrl: string): URL | null {
    try {
      const url = new URL(downloadUrl);
      return url.origin === API_BASE ? url : null;
    } catch {
      return null;
    }
  }

  #tradePath(outTradeNo: string): string {
    return `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}`;
  }

  #nowSeconds(): number {
    return Math.floor(this.#clock.now().getTime() / 1000);
  }

  #headers(method: 'GET' | 'POST', pathWithQuery: string, body: string): Record<string, string> {
    return {
      Authorization: wechatAuthorization({
        mchId: this.#config.mchId,
        merchantSerial: this.#config.merchantSerial,
        privateKeyPem: this.#keys.privateKeyPem,
        method,
        pathWithQuery,
        body,
        timestamp: String(this.#nowSeconds()),
        nonce: randomBytes(16).toString('hex'),
      }),
      Accept: 'application/json',
      'User-Agent': 'couli-pay-channels',
      // Names the public key the answer is to be signed with: on every request, as the documents'
      // examples do (4013053249.txt).
      'Wechatpay-Serial': this.#config.publicKeyId,
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  /**
   * One attempt (never resent: rule 7). Thrown errors become fixed categories; nothing is believed
   * unless the envelope verifies; a field that names another order or merchant, on an error answer
   * as well, makes it no answer to this request (r3 must-fix ②).
   */
  async #exchange(
    method: 'GET' | 'POST',
    pathWithQuery: string,
    body: Json | undefined,
    echo: Echo,
  ): Promise<Answer> {
    const text = body === undefined ? '' : JSON.stringify(body);
    let response: PayHttpResponse;
    try {
      response = await this.#transport({
        method,
        url: `${API_BASE}${pathWithQuery}`,
        headers: this.#headers(method, pathWithQuery, text),
        timeoutMs: API_TIMEOUT_MS,
        ...(method === 'POST' ? { body: text } : {}),
      });
    } catch (error) {
      return { kind: 'failed', reason: transportFailureReason(error) };
    }
    const json = parseJsonObject(response.body);
    const failure = this.#envelopeFailure(response.headers, response.body);
    if (failure !== null) {
      return {
        kind: 'failed',
        reason: response.status >= 400 ? unverifiedErrorReason(json?.['code'], failure) : failure,
      };
    }
    if (
      json !== null &&
      echoConflicts(json, { mchid: this.#config.mchId, appid: this.#config.appId, ...echo })
    ) {
      return { kind: 'failed', reason: 'echo_mismatch' };
    }
    return { kind: 'verified', status: response.status, text: response.body, json };
  }

  /** The body of a verified 200 without an error code; otherwise the logged unknown result. */
  #successJson(
    op: string,
    answer: Answer,
  ): { readonly body: Json } | { readonly kind: 'unknown'; readonly reason: string } {
    if (answer.kind === 'failed') return this.#unknown(op, answer.reason);
    const code = answer.json?.['code'];
    if (answer.status !== 200) {
      if (answer.status < 400) return this.#unknown(op, 'bad_status');
      return this.#unknown(op, isNonEmptyString(code) ? channelErrorReason(code) : 'bad_body');
    }
    if (answer.json === null || code !== undefined) return this.#unknown(op, 'bad_body');
    return { body: answer.json };
  }

  /** Signature, key id and freshness of a response or notification; the fixed failure, or null. */
  #envelopeFailure(headers: Readonly<Record<string, string>>, body: string): string | null {
    const timestamp = headers['wechatpay-timestamp'] ?? '';
    const nonce = headers['wechatpay-nonce'] ?? '';
    const signature = headers['wechatpay-signature'] ?? '';
    const serial = headers['wechatpay-serial'] ?? '';
    if (nonce === '' || signature === '') return 'bad_signature';
    if (
      !/^\d{1,12}$/.test(timestamp) ||
      Math.abs(this.#nowSeconds() - Number(timestamp)) >= MAX_CLOCK_SKEW_SECONDS
    ) {
      return 'stale_answer';
    }
    if (serial !== this.#config.publicKeyId) return 'wrong_key_id';
    return verifyWechatSignature(this.#keys.publicKeyPem, timestamp, nonce, body, signature)
      ? null
      : 'bad_signature';
  }

  /** Every unknown result: logged with fixed fields only (r3 must-fix ⑤), bill_format_unverified too. */
  #unknown(op: string, reason: string): { readonly kind: 'unknown'; readonly reason: string } {
    this.#logger.warn({ channel: this.channel, op, reason }, 'pay_channel_unknown');
    return { kind: 'unknown', reason };
  }
}
