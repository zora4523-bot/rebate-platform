// WeChat Pay API v3 client: APP pay (collect) and merchant transfer (payout to balance).
// One HTTP attempt per call; no retries here. Amounts are integers of fen.
import { randomBytes } from 'node:crypto';

import { type ChannelResult, fetchTransport, send, type Transport } from '../transport.ts';
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
  /** Decrypted `resource`, parsed as JSON. */
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

export class WechatPayClient {
  readonly #c: WechatPayConfig;
  readonly #base: string;
  readonly #transport: Transport;
  readonly #now: () => number;
  readonly #nonce: () => string;

  constructor(config: WechatPayConfig) {
    this.#c = config;
    this.#base = config.baseUrl ?? 'https://api.mch.weixin.qq.com';
    this.#transport = config.transport ?? fetchTransport;
    this.#now = config.now ?? (() => Math.floor(Date.now() / 1000));
    this.#nonce = config.nonce ?? (() => randomBytes(16).toString('hex'));
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
    return this.#call('POST', '/v3/pay/transactions/app', body);
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
    return this.#call('GET', path);
  }

  /** 204 on success. */
  closeOrder(outTradeNo: string): Promise<ChannelResult<Json>> {
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`;
    return this.#call('POST', path, { mchid: this.#c.mchid });
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
    return this.#call('POST', '/v3/refund/domestic/refunds', body);
  }

  queryRefund(outRefundNo: string): Promise<ChannelResult<Json>> {
    return this.#call('GET', `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`);
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
    const extraHeaders: Record<string, string> = {};
    if (i.userName !== undefined) {
      body['user_name'] = encryptSensitive(this.#c.platformPublicKeyPem, i.userName);
      extraHeaders['Wechatpay-Serial'] = this.#c.platformPublicKeyId;
    }
    if (i.notifyUrl !== undefined) body['notify_url'] = i.notifyUrl;
    if (i.userRecvPerception !== undefined) body['user_recv_perception'] = i.userRecvPerception;
    return this.#call('POST', '/v3/fund-app/mch-transfer/transfer-bills', body, extraHeaders);
  }

  queryTransfer(outBillNo: string): Promise<ChannelResult<Json>> {
    return this.#call(
      'GET',
      `/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/${encodeURIComponent(outBillNo)}`,
    );
  }

  cancelTransfer(outBillNo: string): Promise<ChannelResult<Json>> {
    return this.#call(
      'POST',
      `/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/${encodeURIComponent(outBillNo)}/cancel`,
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
    const timestamp = headers['wechatpay-timestamp'] ?? '';
    const nonce = headers['wechatpay-nonce'] ?? '';
    const signature = headers['wechatpay-signature'] ?? '';
    const serial = headers['wechatpay-serial'] ?? '';
    if (
      !/^\d{1,12}$/.test(timestamp) ||
      Math.abs(this.#now() - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS
    ) {
      return { ok: false, reason: 'stale' };
    }
    if (serial !== this.#c.platformPublicKeyId) return { ok: false, reason: 'wrong_key_id' };
    const verified = verifyWechatSignature({
      publicKeyPem: this.#c.platformPublicKeyPem,
      timestamp,
      nonce,
      body: rawBody,
      signature,
    });
    if (!verified) return { ok: false, reason: 'bad_signature' };
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
      const resource = JSON.parse(plain) as Record<string, unknown>;
      return { ok: true, notification: { id: outer.id, eventType: outer.event_type, resource } };
    } catch {
      return { ok: false, reason: 'bad_body' };
    }
  }

  // ---- internals

  async #call<T>(
    method: 'GET' | 'POST',
    pathWithQuery: string,
    body?: Json,
    extraHeaders: Readonly<Record<string, string>> = {},
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
      ...extraHeaders,
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

    if (res.status >= 500)
      return { kind: 'unknown', reason: 'http_5xx', detail: String(res.status) };
    if (res.status === 429) return { kind: 'unknown', reason: 'throttled', detail: '429' };

    if (res.status >= 200 && res.status < 300) {
      const verified = verifyWechatSignature({
        publicKeyPem: this.#c.platformPublicKeyPem,
        timestamp: res.headers['wechatpay-timestamp'] ?? '',
        nonce: res.headers['wechatpay-nonce'] ?? '',
        body: res.body,
        signature: res.headers['wechatpay-signature'] ?? '',
      });
      if (!verified)
        return { kind: 'unknown', reason: 'bad_signature', detail: String(res.status) };
      if (res.body === '') return { kind: 'ok', data: {} as T, raw: '' };
      try {
        return { kind: 'ok', data: JSON.parse(res.body) as T, raw: res.body };
      } catch {
        return { kind: 'unknown', reason: 'bad_body', detail: String(res.status) };
      }
    }

    try {
      const err = JSON.parse(res.body) as { code?: unknown; message?: unknown };
      if (typeof err.code === 'string') {
        return {
          kind: 'rejected',
          code: err.code,
          message: typeof err.message === 'string' ? err.message : '',
          httpStatus: res.status,
          raw: res.body,
        };
      }
    } catch {
      // fall through
    }
    return { kind: 'unknown', reason: 'bad_body', detail: String(res.status) };
  }
}

function assertFen(n: number): void {
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new RangeError('amount must be a positive integer of fen');
}
