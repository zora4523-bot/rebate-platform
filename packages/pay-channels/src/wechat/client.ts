// WeChat Pay API v3 client: APP pay (collect) and merchant transfer (payout to balance).
// One HTTP attempt per call; no retries here. Amounts are integers of fen.
import { randomBytes } from 'node:crypto';

import {
  type ChannelResult,
  fetchTransport,
  send,
  type Shape,
  shapeViolation,
  type Transport,
  type UnknownResult,
} from '../transport.ts';
import {
  decryptWechatResource,
  type EncryptedResource,
  encryptSensitive,
  signAppPay,
  verifyWechatSignature,
  wechatAuthorization,
} from './crypto.ts';

export interface WechatPayConfig {
  readonly mchid: string;
  readonly appid: string;
  /** Merchant API certificate serial number. */
  readonly serialNo: string;
  readonly privateKeyPem: string;
  /** WeChat Pay public key and its id (`PUB_KEY_ID_…`). */
  readonly platformPublicKeyPem: string;
  readonly platformPublicKeyId: string;
  readonly apiV3Key: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly transport?: Transport;
  /** Unix seconds. */
  readonly now?: () => number;
  readonly nonce?: () => string;
  /** Overrides `WECHAT_DEFAULT_REJECT_CODES`. */
  readonly rejectCodes?: ReadonlySet<string>;
}

export interface AppOrderInput {
  readonly outTradeNo: string;
  readonly description: string;
  readonly totalFen: number;
  readonly notifyUrl: string;
  /** RFC 3339, e.g. `2026-10-04T18:00:00+08:00`. */
  readonly timeExpire?: string;
}

export interface RefundInput {
  readonly outTradeNo: string;
  readonly outRefundNo: string;
  readonly refundFen: number;
  readonly totalFen: number;
  readonly reason?: string;
  readonly notifyUrl?: string;
}

export interface TransferInput {
  readonly outBillNo: string;
  readonly transferSceneId: string;
  readonly openid: string;
  readonly amountFen: number;
  readonly remark: string;
  readonly sceneReportInfos: readonly { readonly infoType: string; readonly infoContent: string }[];
  /** Real name; encrypted before sending. */
  readonly userName?: string;
  readonly notifyUrl?: string;
  readonly userRecvPerception?: string;
}

export interface AppPayParams {
  readonly appId: string;
  readonly partnerId: string;
  readonly prepayId: string;
  readonly packageValue: 'Sign=WXPay';
  readonly nonceStr: string;
  readonly timeStamp: string;
  readonly sign: string;
}

export interface WechatNotification {
  readonly id: string;
  readonly eventType: string;
  /** Decrypted `resource`: always a JSON object. */
  readonly resource: Record<string, unknown>;
}

export type NotificationResult =
  | { readonly ok: true; readonly notification: WechatNotification }
  | {
      readonly ok: false;
      readonly reason: 'stale' | 'wrong_key_id' | 'bad_signature' | 'bad_body';
    };

type Json = Record<string, unknown>;

const MAX_CLOCK_SKEW_SECONDS = 300;

/**
 * Error codes the docs describe as "the request was refused before anything happened". A verified
 * answer with one of these is `rejected`; every other code — documented as indeterminate, or
 * simply not on this list — is `unknown` with the code kept for the caller. The transfer doc is
 * explicit: on a new error code, query the bill instead of assuming failure.
 */
export const WECHAT_DEFAULT_REJECT_CODES: ReadonlySet<string> = new Set([
  'PARAM_ERROR',
  'INVALID_REQUEST',
  'NO_AUTH',
  'SIGN_ERROR',
  'NOT_ENOUGH',
  'APPID_MCHID_NOT_MATCH',
  'MCH_NOT_EXISTS',
]);

const TRANSFER_STATES = [
  'ACCEPTED',
  'PROCESSING',
  'WAIT_USER_CONFIRM',
  'TRANSFERING',
  'SUCCESS',
  'FAIL',
  'CANCELING',
  'CANCELLED',
];
const TRADE_STATES = ['SUCCESS', 'REFUND', 'NOTPAY', 'CLOSED', 'REVOKED', 'USERPAYING', 'PAYERROR'];
const REFUND_STATES = ['SUCCESS', 'CLOSED', 'PROCESSING', 'ABNORMAL'];

/** `status` 204 means: verified, empty body, nothing else. */
interface Expect extends Shape {
  readonly status: 200 | 204;
}

export class WechatPayClient {
  readonly #c: WechatPayConfig;
  readonly #base: string;
  readonly #transport: Transport;
  readonly #now: () => number;
  readonly #nonce: () => string;
  readonly #rejectCodes: ReadonlySet<string>;

  constructor(config: WechatPayConfig) {
    this.#c = config;
    this.#base = config.baseUrl ?? 'https://api.mch.weixin.qq.com';
    this.#transport = config.transport ?? fetchTransport;
    this.#now = config.now ?? (() => Math.floor(Date.now() / 1000));
    this.#nonce = config.nonce ?? (() => randomBytes(16).toString('hex'));
    this.#rejectCodes = config.rejectCodes ?? WECHAT_DEFAULT_REJECT_CODES;
  }

  // ---- collect: APP pay

  createAppOrder(i: AppOrderInput): Promise<ChannelResult<{ prepay_id: string }>> {
    assertFen(i.totalFen);
    const body: Json = {
      appid: this.#c.appid,
      mchid: this.#c.mchid,
      description: i.description,
      out_trade_no: i.outTradeNo,
      notify_url: i.notifyUrl,
      amount: { total: i.totalFen, currency: 'CNY' },
    };
    if (i.timeExpire !== undefined) body['time_expire'] = i.timeExpire;
    // The answer only carries prepay_id, so it cannot be tied to the order number.
    return this.#call(
      'POST',
      '/v3/pay/transactions/app',
      { status: 200, strings: ['prepay_id'] },
      body,
    );
  }

  /** Launch parameters for the native SDK. Signed here; the private key never leaves the server. */
  buildAppPayParams(prepayId: string): AppPayParams {
    const timestamp = this.#now();
    const nonce = this.#nonce();
    return {
      appId: this.#c.appid,
      partnerId: this.#c.mchid,
      prepayId,
      packageValue: 'Sign=WXPay',
      nonceStr: nonce,
      timeStamp: String(timestamp),
      sign: signAppPay({
        appId: this.#c.appid,
        timestamp,
        nonce,
        prepayId,
        privateKeyPem: this.#c.privateKeyPem,
      }),
    };
  }

  queryOrder(outTradeNo: string): Promise<ChannelResult<Json>> {
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(this.#c.mchid)}`;
    return this.#call('GET', path, {
      status: 200,
      strings: ['appid', 'mchid', 'out_trade_no', 'trade_state'],
      enums: { trade_state: TRADE_STATES },
      echo: { out_trade_no: outTradeNo, mchid: this.#c.mchid, appid: this.#c.appid },
    });
  }

  /**
   * 204 with an empty body on success. An empty answer cannot be tied to the order number; it is
   * only fresh (five minutes) and signed, so confirm with `queryOrder` before acting on it.
   */
  closeOrder(outTradeNo: string): Promise<ChannelResult<Json>> {
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`;
    return this.#call('POST', path, { status: 204 }, { mchid: this.#c.mchid });
  }

  refund(i: RefundInput): Promise<ChannelResult<Json>> {
    assertFen(i.refundFen);
    assertFen(i.totalFen);
    const body: Json = {
      out_trade_no: i.outTradeNo,
      out_refund_no: i.outRefundNo,
      amount: { refund: i.refundFen, total: i.totalFen, currency: 'CNY' },
    };
    if (i.reason !== undefined) body['reason'] = i.reason;
    if (i.notifyUrl !== undefined) body['notify_url'] = i.notifyUrl;
    return this.#call(
      'POST',
      '/v3/refund/domestic/refunds',
      refundShape(i.outRefundNo, i.outTradeNo),
      body,
    );
  }

  queryRefund(outRefundNo: string): Promise<ChannelResult<Json>> {
    return this.#call(
      'GET',
      `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`,
      refundShape(outRefundNo),
    );
  }

  // ---- payout: merchant transfer to balance

  createTransfer(i: TransferInput): Promise<ChannelResult<Json>> {
    assertFen(i.amountFen);
    const body: Json = {
      appid: this.#c.appid,
      out_bill_no: i.outBillNo,
      transfer_scene_id: i.transferSceneId,
      openid: i.openid,
      transfer_amount: i.amountFen,
      transfer_remark: i.remark,
      transfer_scene_report_infos: i.sceneReportInfos.map((r) => ({
        info_type: r.infoType,
        info_content: r.infoContent,
      })),
    };
    if (i.userName !== undefined) {
      body['user_name'] = encryptSensitive(this.#c.platformPublicKeyPem, i.userName);
    }
    if (i.notifyUrl !== undefined) body['notify_url'] = i.notifyUrl;
    if (i.userRecvPerception !== undefined) body['user_recv_perception'] = i.userRecvPerception;
    return this.#call(
      'POST',
      '/v3/fund-app/mch-transfer/transfer-bills',
      this.#billShape(i.outBillNo),
      body,
    );
  }

  queryTransfer(outBillNo: string): Promise<ChannelResult<Json>> {
    return this.#call(
      'GET',
      `/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/${encodeURIComponent(outBillNo)}`,
      { ...this.#billShape(outBillNo), integers: ['transfer_amount'] },
    );
  }

  cancelTransfer(outBillNo: string): Promise<ChannelResult<Json>> {
    return this.#call(
      'POST',
      `/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/${encodeURIComponent(outBillNo)}/cancel`,
      this.#billShape(outBillNo),
    );
  }

  /** `query` of the native `requestMerchantTransfer` call; values are URL-encoded. */
  buildTransferConfirmQuery(packageInfo: string): string {
    return (
      `mchId=${encodeURIComponent(this.#c.mchid)}&appId=${encodeURIComponent(this.#c.appid)}` +
      `&package=${encodeURIComponent(packageInfo)}`
    );
  }

  // ---- notifications (pay, refund, transfer)

  /**
   * Verifies and decrypts a notification. `headers` keys must be lower-cased; `rawBody` must be
   * the bytes as received. The caller still checks ids, amounts and states against its own order.
   */
  parseNotification(
    headers: Readonly<Record<string, string>>,
    rawBody: string,
  ): NotificationResult {
    const failure = this.#verifyEnvelope(headers, rawBody);
    if (failure !== undefined) return { ok: false, reason: failure };
    try {
      const outer = JSON.parse(rawBody) as {
        id?: unknown;
        event_type?: unknown;
        resource?: unknown;
      };
      if (typeof outer.id !== 'string' || typeof outer.event_type !== 'string') {
        return { ok: false, reason: 'bad_body' };
      }
      const plain = decryptWechatResource(this.#c.apiV3Key, outer.resource as EncryptedResource);
      const resource = parseObject(plain);
      if (resource === undefined) return { ok: false, reason: 'bad_body' };
      return { ok: true, notification: { id: outer.id, eventType: outer.event_type, resource } };
    } catch {
      return { ok: false, reason: 'bad_body' };
    }
  }

  // ---- internals

  #billShape(outBillNo: string): Expect {
    return {
      status: 200,
      strings: ['out_bill_no', 'transfer_bill_no', 'state'],
      enums: { state: TRANSFER_STATES },
      echo: { out_bill_no: outBillNo, mch_id: this.#c.mchid, appid: this.#c.appid },
    };
  }

  /**
   * Signature, key identity and freshness of a response or notification. Every header must be
   * present. Returns the failure, or `undefined` when the envelope is trustworthy.
   */
  #verifyEnvelope(
    headers: Readonly<Record<string, string>>,
    body: string,
  ): 'stale' | 'wrong_key_id' | 'bad_signature' | undefined {
    const timestamp = headers['wechatpay-timestamp'] ?? '';
    const nonce = headers['wechatpay-nonce'] ?? '';
    const signature = headers['wechatpay-signature'] ?? '';
    const serial = headers['wechatpay-serial'] ?? '';
    if (nonce === '' || signature === '') return 'bad_signature';
    if (
      !/^\d{1,12}$/.test(timestamp) ||
      Math.abs(this.#now() - Number(timestamp)) >= MAX_CLOCK_SKEW_SECONDS
    ) {
      return 'stale';
    }
    if (serial !== this.#c.platformPublicKeyId) return 'wrong_key_id';
    const verified = verifyWechatSignature({
      publicKeyPem: this.#c.platformPublicKeyPem,
      timestamp,
      nonce,
      body,
      signature,
    });
    return verified ? undefined : 'bad_signature';
  }

  async #call<T>(
    method: 'GET' | 'POST',
    pathWithQuery: string,
    expect: Expect,
    body?: Json,
  ): Promise<ChannelResult<T>> {
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const authorization = wechatAuthorization({
      mchid: this.#c.mchid,
      serialNo: this.#c.serialNo,
      privateKeyPem: this.#c.privateKeyPem,
      method,
      pathWithQuery,
      body: bodyText,
      timestamp: this.#now(),
      nonce: this.#nonce(),
    });
    const headers: Record<string, string> = {
      Authorization: authorization,
      Accept: 'application/json',
      'User-Agent': 'couli-pay-channels',
      // Tells WeChat Pay to sign the answer with this public key (and names the key used to
      // encrypt sensitive fields). Sent on every request, not only on those with encrypted fields.
      'Wechatpay-Serial': this.#c.platformPublicKeyId,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const req = {
      method,
      url: this.#base + pathWithQuery,
      headers,
      timeoutMs: this.#c.timeoutMs ?? 10_000,
      ...(method === 'POST' ? { body: bodyText } : {}),
    };
    const res = await send(this.#transport, req);
    if ('kind' in res) return res;

    const status = String(res.status);
    const parsed = parseObject(res.body);
    const code = typeof parsed?.['code'] === 'string' ? parsed['code'] : undefined;
    if (res.status >= 500) return unknown('http_5xx', status, code);
    if (res.status === 429) return unknown('throttled', status, code);

    // Nothing below is trusted unless the envelope verifies: an error code alone proves neither
    // who sent the answer nor that the request was not executed.
    const failure = this.#verifyEnvelope(res.headers, res.body);
    if (failure !== undefined) return unknown('bad_signature', `${status} ${failure}`, code);

    if (res.status >= 200 && res.status < 300) {
      if (res.status !== expect.status) return unknown('bad_body', `${status} unexpected status`);
      if (expect.status === 204) {
        return res.body === ''
          ? { kind: 'ok', data: {} as T }
          : unknown('bad_body', `${status} body not empty`);
      }
      if (parsed === undefined) return unknown('bad_body', `${status} not an object`);
      // A success body never carries an error code.
      if (parsed['code'] !== undefined)
        return unknown('bad_body', `${status} success with a code`, code);
      const violation = shapeViolation(parsed, expect);
      if (violation !== undefined) return unknown('bad_body', `${status} ${violation}`);
      return { kind: 'ok', data: parsed as T };
    }

    if (code === undefined || code === '') return unknown('bad_body', `${status} no code`);
    if (!this.#rejectCodes.has(code)) return unknown('indeterminate', status, code);
    return {
      kind: 'rejected',
      code,
      message: typeof parsed?.['message'] === 'string' ? parsed['message'] : '',
      httpStatus: res.status,
    };
  }
}

function refundShape(outRefundNo: string, outTradeNo?: string): Expect {
  return {
    status: 200,
    strings: ['refund_id', 'out_refund_no', 'out_trade_no', 'status'],
    objects: ['amount'],
    enums: { status: REFUND_STATES },
    echo: {
      out_refund_no: outRefundNo,
      ...(outTradeNo === undefined ? {} : { out_trade_no: outTradeNo }),
    },
  };
}

function unknown(reason: UnknownResult['reason'], detail: string, code?: string): UnknownResult {
  return code === undefined
    ? { kind: 'unknown', reason, detail }
    : { kind: 'unknown', reason, detail, code };
}

/** Parses a JSON object; anything else (null, array, primitive, invalid JSON) is `undefined`. */
function parseObject(text: string): Json | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
  } catch {
    return undefined;
  }
}

function assertFen(n: number): void {
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new RangeError('amount must be a positive integer of fen');
}
