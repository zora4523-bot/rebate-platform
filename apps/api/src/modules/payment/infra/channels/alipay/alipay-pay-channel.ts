// B2-15k: Alipay App payment, against a sandbox gateway outside prod (rule tests:
// test/spec/payment/channels/alipay-*.test.ts and bill.test.ts). Ported from task/PAY-01
// packages/pay-channels; transfers not ported. Documents, not yet run against an application
// (BR-PAY-09): orderStr docs-mirror/alipay/app-pay/02e7gq.md, query 02e7gm.md, close 02e7gn.md,
// refund 02e7go.md, refund query 02e7gp.md, bill 02e7gr.md and 00dn7a.md, notification 00dn78.md,
// synchronous answer 00iki4.md, integration 01dcc0.md, error codes
// docs-mirror/alipay/guides/common-02km9f.md, verification browser-02mse7.md.
// Task §13: a notification without seller_id is rejected, never filled from the configuration; a
// refund notification carries the cumulative refund_fee as it is, and the refund result is the
// query's (a notification alone only keeps the text and alerts); a query that meets TRADE_FINISHED
// logs the fixed warn `pay_trade_finished`; close queries again after a verified business error.
// An answer is ok or unknown, never failed (payment/AGENTS.md rule 7; r3 must-fix ①). The one error
// that is a result is the query's 40004 + ACQ.TRADE_NOT_EXIST, matched on interface, HTTP status,
// main code and sub code together.
// Also compiled by the `test` project: erasable syntax only.
import { formatFen, yuanStrToFen } from '@couli/money';
import {
  PAY_REASON_APP_NOT_CONFIGURED,
  PAY_REASON_BILL_FORMAT_UNVERIFIED,
  PAY_REASON_BILL_NOT_AVAILABLE,
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
  type PayTradeState,
} from '../../../application/pay-channel.ts';
import type { PayChannelCode } from '../../../domain/types.ts';
import type { Clock, RootLogger } from '../../../../platform/index.ts';
import {
  API_TIMEOUT_MS,
  BILL_DATE,
  BILL_MAX_BYTES,
  BILL_TIMEOUT_MS,
  alipayDateTime,
  channelErrorReason,
  echoConflicts,
  isNonEmptyString,
  isObject,
  isPrintableCode,
  notifyAddress,
  parseJsonObject,
  transportFailureReason,
  unverifiedErrorReason,
  type Json,
} from '../channel-common.ts';
import type { PayHttpResponse, PayTransport } from '../transport.ts';
import {
  alipayNotificationSignContent,
  alipayRequestSignContent,
  rsa2Sign,
  rsa2Verify,
} from './alipay-crypto.ts';
import { onlyMember, stringMember, topLevelMembers } from './envelope.ts';

/** docs-mirror/alipay/app-pay/02e7gm.md:27: the production gateway, fixed in prod (task §9.8 ③). */
export const ALIPAY_PRODUCTION_GATEWAY = 'https://openapi.alipay.com/gateway.do';

/** Yuan text with at most two places, never signed or in scientific notation. */
const YUAN = /^\d{1,12}(?:\.\d{1,2})?$/;
const BUSINESS_FAILURE_CODE = '40004';
const NOT_EXIST_SUB_CODE = 'ACQ.TRADE_NOT_EXIST';
const SUCCESS_CODE = '10000';

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

/** An answer after the envelope: a fixed reason, a verified success, or a verified error. */
type Answer =
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'success'; readonly node: Json }
  | {
      readonly kind: 'business_error';
      readonly code: string;
      readonly subCode: string | null;
    };

type UnknownResult = { readonly kind: 'unknown'; readonly reason: string };

/** Yuan text as fen, through @couli/money only; null for anything else (r3 must-fix ④). */
function yuanToFen(value: unknown): bigint | null {
  return typeof value === 'string' && YUAN.test(value) ? yuanStrToFen(value) : null;
}

function tradeSummary(status: string): PayTradeState {
  // Only a summary (pay-settlement judges channelState). TRADE_FINISHED is not paid until a test
  // sample says so (BR-PAY-04 细则); unlisted states are neither paid nor closed.
  if (status === 'TRADE_SUCCESS') return 'paid';
  if (status === 'TRADE_CLOSED') return 'closed';
  return 'not_paid';
}

/** The code of an answer that verified nothing (a known sub code first), for diagnostics only. */
function diagnosticCode(text: string, nodeKey: string): unknown {
  const answer = parseJsonObject(text);
  const node = answer?.[nodeKey] ?? answer?.['error_response'];
  if (!isObject(node)) return undefined;
  return isPrintableCode(node['sub_code']) ? node['sub_code'] : node['code'];
}

export class AlipayPayChannel implements PayChannel {
  readonly channel: PayChannelCode = 'alipay';
  readonly #config: AlipayPayChannelConfig;
  readonly #keys: AlipayPayChannelKeys;
  readonly #transport: PayTransport;
  readonly #clock: Clock;
  readonly #logger: RootLogger;

  constructor(options: AlipayPayChannelOptions) {
    this.#config = options.config;
    this.#keys = options.keys;
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#logger = options.logger;
  }

  /**
   * Signed here, nothing sent (01dcc0.md:105): the channel knows no such trade until the user
   * submits it, which is why «not exist» does not mean closed (BR-PAY-05 细则).
   */
  createOrder(input: PayCreateOrderInput): Promise<PayCreateOrderResult> {
    return Promise.resolve(this.#createOrder(input));
  }

  #createOrder(input: PayCreateOrderInput): PayCreateOrderResult {
    if (input.appId !== undefined && input.appId !== this.#config.payAppId) {
      return this.#unknown('create_order', PAY_REASON_APP_NOT_CONFIGURED);
    }
    const notifyUrl = notifyAddress(input.notifyUrl, this.#config.notifyBaseUrl);
    if (notifyUrl === null || input.amountFen <= 0n) {
      return this.#unknown('create_order', 'invalid_input');
    }
    let params: Readonly<Record<string, string>>;
    try {
      params = this.#signedParams(
        'alipay.trade.app.pay',
        {
          out_trade_no: input.outTradeNo,
          total_amount: formatFen(input.amountFen),
          subject: input.description,
          product_code: 'QUICK_MSECURITY_PAY',
          // Seconds only, milliseconds dropped: never later than expire_at (BR-PAY-03).
          time_expire: alipayDateTime(input.expireAt),
        },
        notifyUrl,
      );
    } catch {
      return this.#unknown('create_order', 'invalid_input');
    }
    const orderStr = Object.keys(params)
      .sort()
      .map((key) => `${key}=${encodeURIComponent(params[key] ?? '')}`)
      .join('&');
    // The order string creates nothing on the channel, so our own number is the only reference.
    return { kind: 'ok', channelRef: input.outTradeNo, launch: { order_str: orderStr } };
  }

  async query(outTradeNo: string): Promise<PayQueryResult> {
    const answer = await this.#call(
      'alipay.trade.query',
      { out_trade_no: outTradeNo },
      { out_trade_no: outTradeNo },
    );
    if (answer.kind === 'failed') return this.#unknown('query', answer.reason);
    if (answer.kind === 'business_error') {
      if (answer.code === BUSINESS_FAILURE_CODE && answer.subCode === NOT_EXIST_SUB_CODE) {
        return { kind: 'ok', state: 'not_exist', channelTradeNo: null, amountFen: null };
      }
      return this.#unknown('query', channelErrorReason(answer.subCode, answer.code));
    }
    return this.#tradeResult(answer.node);
  }

  #tradeResult(trade: Json): PayQueryResult {
    const { out_trade_no: outTradeNo, trade_status: status } = trade;
    const tradeNo = trade['trade_no'];
    if (
      !isNonEmptyString(outTradeNo) ||
      !isNonEmptyString(status) ||
      (tradeNo !== undefined && !isNonEmptyString(tradeNo))
    ) {
      return this.#unknown('query', 'bad_body');
    }
    // 02e7gm.md: trade_no is absent before a real trade exists.
    let amountFen: bigint | null = null;
    if ('total_amount' in trade) {
      amountFen = yuanToFen(trade['total_amount']);
      if (amountFen === null) return this.#unknown('query', 'bad_body');
    }
    if (
      status === 'TRADE_SUCCESS' &&
      (tradeNo === undefined || amountFen === null || amountFen <= 0n)
    ) {
      return this.#unknown('query', 'bad_body');
    }
    if (status === 'TRADE_FINISHED') {
      this.#logger.warn({ channel: this.channel, op: 'query' }, 'pay_trade_finished');
    }
    return {
      kind: 'ok',
      state: tradeSummary(status),
      channelState: status,
      channelTradeNo: tradeNo ?? null,
      amountFen,
      // 02e7gm.md:261-297 has neither seller_id nor app_id on this answer: both come from this
      // channel's configuration; a field the answer does carry was compared in #call.
      merchantRef: this.#config.sellerId,
      appRef: this.#config.appId,
    };
  }

  /**
   * BR-PAY-05 ②, task §13: neither 10000 nor a verified business error says the order is closed;
   * one more query decides. An answer that did not verify, has no code or names another order is
   * no answer to this close: unknown, whatever a query would say. No list of codes here.
   */
  async close(outTradeNo: string): Promise<PayCloseResult> {
    const answer = await this.#call(
      'alipay.trade.close',
      { out_trade_no: outTradeNo },
      { out_trade_no: outTradeNo },
    );
    if (answer.kind === 'failed') return this.#unknown('close', answer.reason);
    const queried = await this.query(outTradeNo);
    if (queried.kind === 'unknown') return this.#unknown('close', queried.reason);
    if (queried.state === 'not_paid') return this.#unknown('close', 'close_not_confirmed');
    return { kind: 'ok', state: queried.state };
  }

  /**
   * ok only says the refund was accepted; fund_change and refund_fee decide nothing (01dcc0.md:113,
   * r3 must-fix ③): this answer does not echo out_request_no, so a replayed answer of another
   * partial refund would pass. The result is the query's, by this refund's own out_request_no.
   */
  async refund(input: PayRefundInput): Promise<PayRefundResult> {
    const original = this.#originalNumber(input);
    if (original === null || input.refundFen <= 0n || input.refundFen > input.totalFen) {
      return this.#unknown('refund', 'invalid_input');
    }
    const answer = await this.#call(
      'alipay.trade.refund',
      {
        ...original,
        out_request_no: input.outRefundNo,
        refund_amount: formatFen(input.refundFen),
      },
      {
        out_trade_no: input.outTradeNo,
        trade_no: input.channelTradeNo,
        out_request_no: input.outRefundNo,
      },
    );
    if (answer.kind === 'failed') return this.#unknown('refund', answer.reason);
    if (answer.kind === 'business_error') {
      return this.#unknown('refund', channelErrorReason(answer.subCode, answer.code));
    }
    const { node } = answer;
    const fundChange = node['fund_change'];
    const refundFee = yuanToFen(node['refund_fee']);
    if (
      !isNonEmptyString(node['out_trade_no']) ||
      !isNonEmptyString(node['trade_no']) ||
      (fundChange !== undefined && typeof fundChange !== 'string') ||
      refundFee === null ||
      refundFee > input.totalFen
    ) {
      return this.#unknown('refund', 'bad_body');
    }
    return { kind: 'ok' };
  }

  /** One number names the original (02e7go.md:21): refund and refund query send the same one. */
  #originalNumber(original: {
    readonly outTradeNo: string | null;
    readonly channelTradeNo: string | null;
  }): Readonly<Record<string, string>> | null {
    if (original.outTradeNo !== null) return { out_trade_no: original.outTradeNo };
    if (original.channelTradeNo !== null) return { trade_no: original.channelTradeNo };
    return null;
  }

  /**
   * 01dcc0.md: trade_no, out_trade_no and out_request_no must agree with the refund, so without the
   * original this is unknown. 02e7gp.md: 10000 only says the query ran; with no refund information
   * the refund does not exist. r3 must-fix ③: any refund information must come with every identity
   * field, all of them this refund's.
   */
  async refundQuery(
    outRefundNo: string,
    original?: PayRefundOriginal,
  ): Promise<PayRefundQueryResult> {
    const number = original === undefined ? null : this.#originalNumber(original);
    if (number === null) return this.#unknown('refund_query', 'invalid_input');
    const answer = await this.#call(
      'alipay.trade.fastpay.refund.query',
      { ...number, out_request_no: outRefundNo },
      {
        out_trade_no: original?.outTradeNo,
        trade_no: original?.channelTradeNo,
        out_request_no: outRefundNo,
      },
    );
    if (answer.kind === 'failed') return this.#unknown('refund_query', answer.reason);
    if (answer.kind === 'business_error') {
      return this.#unknown('refund_query', channelErrorReason(answer.subCode, answer.code));
    }
    return this.#refundResult(answer.node);
  }

  #refundResult(node: Json): PayRefundQueryResult {
    const identity = {
      // 02e7gp.md:250 has neither seller_id nor app_id: both come from this channel's configuration;
      // a field the answer does carry was compared in #call.
      merchantRef: this.#config.sellerId,
      appRef: this.#config.appId,
    };
    const hasRefund = ['out_request_no', 'refund_status', 'refund_amount', 'total_amount'].some(
      (field) => field in node,
    );
    if (!hasRefund) return { kind: 'ok', state: 'not_exist', refundFen: null, ...identity };
    const { out_request_no: outRequestNo, out_trade_no: outTradeNo, trade_no: tradeNo } = node;
    const status = node['refund_status'];
    let refundFen: bigint | null = null;
    if ('refund_amount' in node) {
      refundFen = yuanToFen(node['refund_amount']);
      if (refundFen === null) return this.#unknown('refund_query', 'bad_body');
    }
    if (
      !isNonEmptyString(outRequestNo) ||
      !isNonEmptyString(outTradeNo) ||
      !isNonEmptyString(tradeNo) ||
      (status !== undefined && !isNonEmptyString(status)) ||
      (status === 'REFUND_SUCCESS' && (refundFen === null || refundFen <= 0n))
    ) {
      return this.#unknown('refund_query', 'bad_body');
    }
    return {
      kind: 'ok',
      // Only a summary. 02e7gp.md:250: no refund_status means not received or failed, not a result.
      state: status === 'REFUND_SUCCESS' ? 'success' : 'processing',
      ...(status === undefined ? {} : { channelState: status }),
      refundFen,
      outTradeNo,
      channelTradeNo: tradeNo,
      channelRefundNo: null,
      ...identity,
    };
  }

  /** BR-PAY-04, BR-PAY-08 ③: anything that does not pass is rejected with a fixed reason. */
  verifyNotification(raw: PayRawNotification): Promise<PayNotificationResult> {
    return Promise.resolve(this.#notification(raw));
  }

  /** 00dn78.md:110-114: every decoded parameter but sign and sign_type, sorted, RSA2 only. */
  #notification(raw: PayRawNotification): PayNotificationResult {
    const fields: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(raw.body)) {
      if (Object.hasOwn(fields, key)) return { kind: 'rejected', reason: 'bad_body' };
      fields[key] = value;
    }
    const signature = fields['sign'];
    if (!isNonEmptyString(signature)) return { kind: 'rejected', reason: 'bad_signature' };
    if (fields['sign_type'] !== 'RSA2') return { kind: 'rejected', reason: 'bad_signature' };
    if (
      !rsa2Verify(alipayNotificationSignContent(fields), signature, this.#keys.alipayPublicKeyPem)
    ) {
      return { kind: 'rejected', reason: 'bad_signature' };
    }
    return this.#notificationFields(fields) ?? { kind: 'rejected', reason: 'bad_body' };
  }

  #notificationFields(fields: Readonly<Record<string, string>>): PayNotificationResult | null {
    const { notify_id: notifyId, trade_no: tradeNo, app_id: appId } = fields;
    const { seller_id: sellerId, out_trade_no: outTradeNo, trade_status: state } = fields;
    const amountFen = yuanToFen(fields['total_amount']);
    if (
      fields['notify_type'] !== 'trade_status_sync' ||
      !isNonEmptyString(notifyId) ||
      !isNonEmptyString(tradeNo) ||
      !isNonEmptyString(appId) ||
      // Optional in 00dn78.md:35 but to be checked (00dn78.md:118): never filled from the
      // configuration, or the merchant would pass without being compared (task §13).
      !isNonEmptyString(sellerId) ||
      !isNonEmptyString(outTradeNo) ||
      !isNonEmptyString(state) ||
      amountFen === null ||
      amountFen <= 0n
    ) {
      return null;
    }
    const base = {
      kind: 'ok',
      notifyId,
      outTradeNo,
      channelTradeNo: tradeNo,
      amountFen,
      state,
      merchantRef: sellerId,
      appRef: appId,
    } as const;
    const outRefundNo = fields['out_biz_no'];
    if (outRefundNo === undefined) return { ...base, outRefundNo: null };
    // A refund notification, carried as it is: refund_fee is the trade's total refunded so far
    // (00dn78.md:43), no difference worked out, and state is the trade_status (00dn78.md has no refund
    // state), which is not in refund_success_states. So the handler answers every Alipay refund's
    // notification with a mismatch: the text kept, an alert, nothing moved. The result is the query's
    // (task §13). That alert is expected on each refund; launch checklist §3.
    const refundFen = yuanToFen(fields['refund_fee']);
    if (!isNonEmptyString(outRefundNo) || refundFen === null || refundFen <= 0n) return null;
    return { ...base, outRefundNo, refundFen };
  }

  ownerAppOf(identity: PayChannelIdentity): string | null {
    return identity.merchantRef === this.#config.sellerId && identity.appRef === this.#config.appId
      ? this.#config.payAppId
      : null;
  }

  /**
   * Task §9.7: asks for the address and downloads the file, and stops there: no document gives
   * the encoding or compression, so a good file still answers unknown with bill_format_unverified
   * until a real sample arrives. 02e7gr.md's example address is http, so no scheme rule beyond http(s).
   */
  async downloadBill(date: string, appId: string): Promise<PayBillResult> {
    if (appId !== this.#config.payAppId) return this.#unknown('bill', 'bill_app_mismatch');
    if (!BILL_DATE.test(date)) return this.#unknown('bill', 'invalid_input');
    const answer = await this.#call(
      'alipay.data.dataservice.bill.downloadurl.query',
      { bill_type: 'trade', bill_date: date },
      {},
    );
    if (answer.kind === 'failed') return this.#unknown('bill', answer.reason);
    if (answer.kind === 'business_error') {
      // 02e7gr.md:271: NO_BILL_DATA, no business of this bill type in the period, under the business
      // failure code (common-02km9f.md:60). BILL_NOT_EXIST says less, so it stays a bill not
      // available yet. No warn: an ordinary day.
      if (answer.code === BUSINESS_FAILURE_CODE && answer.subCode === 'NO_BILL_DATA') {
        return { kind: 'unknown', reason: PAY_REASON_BILL_NOT_AVAILABLE };
      }
      return this.#unknown('bill', channelErrorReason(answer.subCode, answer.code));
    }
    const address = answer.node['bill_download_url'];
    if (!isNonEmptyString(address) || !URL.canParse(address)) {
      return this.#unknown('bill', 'bad_body');
    }
    if (!['http:', 'https:'].includes(new URL(address).protocol)) {
      return this.#unknown('bill', 'bad_body');
    }
    let file: PayHttpResponse;
    try {
      file = await this.#transport({
        method: 'GET',
        url: address,
        headers: {},
        timeoutMs: BILL_TIMEOUT_MS,
        maxResponseBytes: BILL_MAX_BYTES,
      });
    } catch {
      return this.#unknown('bill', 'bill_download_failed');
    }
    return this.#unknown(
      'bill',
      file.status === 200 ? PAY_REASON_BILL_FORMAT_UNVERIFIED : 'bill_download_failed',
    );
  }

  /** The public parameters and biz_content, signed (02e7gq.md:6-18); the mode's serials included. */
  #signedParams(method: string, biz: Json, notifyUrl?: string): Readonly<Record<string, string>> {
    const serials = this.#config.certSerials;
    const params: Record<string, string> = {
      app_id: this.#config.appId,
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: alipayDateTime(this.#clock.now()),
      version: '1.0',
      biz_content: JSON.stringify(biz),
      ...(notifyUrl === undefined ? {} : { notify_url: notifyUrl }),
      ...(serials === null
        ? {}
        : { app_cert_sn: serials.appCertSn, alipay_root_cert_sn: serials.alipayRootCertSn }),
    };
    return {
      ...params,
      sign: rsa2Sign(alipayRequestSignContent(params), this.#keys.privateKeyPem),
    };
  }

  /** Public parameters in the query string, the payload in the form body (02e7gm.md:27). */
  #requestUrl(params: Readonly<Record<string, string>>): string {
    const url = new URL(this.#config.gateway);
    const added = Object.entries(params).filter(([key]) => key !== 'biz_content');
    for (const [key] of added) url.searchParams.delete(key);
    const pairs = added.map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
    const kept = url.search.slice(1);
    url.search = (kept === '' ? pairs : [kept, ...pairs]).join('&');
    return url.toString();
  }

  /**
   * One attempt (never resent: rule 7). Thrown errors become fixed categories; nothing is believed
   * unless the whole answer is valid JSON and the signature of its one `xxx_response` node verifies.
   * The outer interface key is not covered by the signature (r3 must-fix ③), so an answer's interface
   * is not proven: a signed «not exist» error that carries no order number could be reused for
   * another order or interface. A known residue, in specs/pay-channels-launch-checklist.md.
   */
  async #call(
    method: string,
    biz: Json,
    echo: Readonly<Record<string, string | null | undefined>>,
  ): Promise<Answer> {
    let response: PayHttpResponse;
    try {
      const params = this.#signedParams(method, biz);
      response = await this.#transport({
        method: 'POST',
        url: this.#requestUrl(params),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: new URLSearchParams({ biz_content: params['biz_content'] ?? '' }).toString(),
        timeoutMs: API_TIMEOUT_MS,
      });
    } catch (error) {
      return { kind: 'failed', reason: transportFailureReason(error) };
    }
    const nodeKey = `${method.replaceAll('.', '_')}_response`;
    if (response.status !== 200) {
      // r3 建议改 ③: a readable code as a diagnostic hint, nothing about this answer is trusted.
      const code = diagnosticCode(response.body, nodeKey);
      return { kind: 'failed', reason: unverifiedErrorReason(code, 'bad_status') };
    }
    const nodeRaw = this.#verifiedNode(response.body, nodeKey);
    if (nodeRaw === null) return { kind: 'failed', reason: 'bad_signature' };
    const node = parseJsonObject(nodeRaw);
    if (node === null) return { kind: 'failed', reason: 'bad_body' };
    if (
      echoConflicts(node, {
        app_id: this.#config.appId,
        seller_id: this.#config.sellerId,
        ...echo,
      })
    ) {
      return { kind: 'failed', reason: 'echo_mismatch' };
    }
    const { code, sub_code: subCode } = node;
    if (!isNonEmptyString(code)) return { kind: 'failed', reason: 'bad_body' };
    if (subCode !== undefined && typeof subCode !== 'string') {
      return { kind: 'failed', reason: 'bad_body' };
    }
    if (code === SUCCESS_CODE) {
      return subCode === undefined
        ? { kind: 'success', node }
        : { kind: 'failed', reason: 'bad_body' };
    }
    return { kind: 'business_error', code, subCode: subCode ?? null };
  }

  /** The exact text of the one signed node, or null (browser-02mse7.md:23-31, :54-57). */
  #verifiedNode(text: string, nodeKey: string): string | null {
    const members = topLevelMembers(text);
    if (members === undefined) return null;
    if (members.some((member) => member.key === 'error_response')) return null;
    const nodeRaw = onlyMember(members, nodeKey);
    const signature = stringMember(onlyMember(members, 'sign'));
    if (nodeRaw === undefined || !nodeRaw.startsWith('{') || !isNonEmptyString(signature)) {
      return null;
    }
    const serials = this.#config.certSerials;
    if (
      serials !== null &&
      stringMember(onlyMember(members, 'alipay_cert_sn')) !== serials.alipayCertSn
    ) {
      return null;
    }
    return rsa2Verify(nodeRaw, signature, this.#keys.alipayPublicKeyPem) ? nodeRaw : null;
  }

  /** Every unknown result: logged with fixed fields only (r3 must-fix ⑤), bill_format_unverified too. */
  #unknown(op: string, reason: string): UnknownResult {
    this.#logger.warn({ channel: this.channel, op, reason }, 'pay_channel_unknown');
    return { kind: 'unknown', reason };
  }
}
