// Alipay OpenAPI client (certificate mode): APP pay (collect) and transfer to an Alipay account
// (payout). One HTTP attempt per call; no retries here. Amounts are integers of fen.
import { fenToYuan } from '../amount.ts';
import { type ChannelResult, fetchTransport, send, type Transport } from '../transport.ts';
import { alipaySignContent, alipayTimestamp, rsa2Sign, rsa2Verify } from './crypto.ts';

export interface AlipayConfig {
  readonly appId: string;
  readonly privateKeyPem: string;
  /** From `certSn(appCertPublicKey)`. */
  readonly appCertSn: string;
  /** From `rootCertSn(alipayRootCert)`. */
  readonly alipayRootCertSn: string;
  /** From `publicKeyFromCert(alipayCertPublicKey)`. */
  readonly alipayPublicKeyPem: string;
  readonly gateway?: string;
  readonly timeoutMs?: number;
  readonly transport?: Transport;
  /** Epoch milliseconds. */
  readonly now?: () => number;
}

export interface AlipayAppPayInput {
  readonly outTradeNo: string;
  readonly totalFen: number;
  readonly subject: string;
  readonly notifyUrl: string;
  /** Absolute deadline, `yyyy-MM-dd HH:mm:ss` (+08:00). */
  readonly timeExpire?: string;
}

export interface AlipayRefundInput {
  readonly outTradeNo: string;
  /** Idempotency key of this refund on the Alipay side. */
  readonly outRequestNo: string;
  readonly refundFen: number;
  readonly reason?: string;
}

export interface AlipayTransferInput {
  readonly outBizNo: string;
  readonly amountFen: number;
  readonly payeeLogonId: string;
  readonly payeeName: string;
  readonly orderTitle: string;
  readonly remark?: string;
  /** Both scene fields are required for merchants onboarded from 2026 per the API doc. */
  readonly transferSceneName?: string;
  readonly sceneReportInfos?: readonly {
    readonly infoType: string;
    readonly infoContent: string;
  }[];
  readonly productCode?: string;
  readonly bizScene?: string;
}

type Json = Record<string, unknown>;

/** Gateway-level refusals that may arrive unsigned: the request was never accepted. */
const UNSIGNED_REFUSALS = new Set(['40001', '40002', '40003', '40006']);
/** Answers that do not tell whether the operation happened. */
const UNKNOWN_CODES = new Set(['20000']);
const UNKNOWN_SUB_CODES = new Set([
  'SYSTEM_ERROR',
  'ACQ.SYSTEM_ERROR',
  'aop.unknow-error',
  'isp.unknow-error',
]);

const DEFAULT_PRODUCT_CODE = 'TRANS_ACCOUNT_NO_PWD';
const DEFAULT_BIZ_SCENE = 'DIRECT_TRANSFER';

export class AlipayClient {
  readonly #c: AlipayConfig;
  readonly #gateway: string;
  readonly #transport: Transport;
  readonly #now: () => number;

  constructor(config: AlipayConfig) {
    this.#c = config;
    this.#gateway = config.gateway ?? 'https://openapi.alipay.com/gateway.do';
    this.#transport = config.transport ?? fetchTransport;
    this.#now = config.now ?? (() => Date.now());
  }

  // ---- collect: APP pay

  /**
   * The `orderStr` handed to the native SDK. Signed here; nothing is created on the Alipay side
   * until the user submits it, so "trade not found" does not prove the order string is dead.
   */
  buildAppPayOrderString(i: AlipayAppPayInput): string {
    const biz: Json = {
      out_trade_no: i.outTradeNo,
      total_amount: fenToYuan(positiveFen(i.totalFen)),
      subject: i.subject,
      product_code: 'QUICK_MSECURITY_PAY',
    };
    if (i.timeExpire !== undefined) biz['time_expire'] = i.timeExpire;
    const params = this.#signedParams('alipay.trade.app.pay', biz, i.notifyUrl);
    return Object.keys(params)
      .sort()
      .map((k) => `${k}=${encodeURIComponent(params[k] ?? '')}`)
      .join('&');
  }

  tradeQuery(outTradeNo: string): Promise<ChannelResult<Json>> {
    return this.#call('alipay.trade.query', { out_trade_no: outTradeNo });
  }

  tradeClose(outTradeNo: string): Promise<ChannelResult<Json>> {
    return this.#call('alipay.trade.close', { out_trade_no: outTradeNo });
  }

  tradeRefund(i: AlipayRefundInput): Promise<ChannelResult<Json>> {
    const biz: Json = {
      out_trade_no: i.outTradeNo,
      out_request_no: i.outRequestNo,
      refund_amount: fenToYuan(positiveFen(i.refundFen)),
    };
    if (i.reason !== undefined) biz['refund_reason'] = i.reason;
    return this.#call('alipay.trade.refund', biz);
  }

  refundQuery(outTradeNo: string, outRequestNo: string): Promise<ChannelResult<Json>> {
    return this.#call('alipay.trade.fastpay.refund.query', {
      out_trade_no: outTradeNo,
      out_request_no: outRequestNo,
    });
  }

  // ---- payout: transfer to an Alipay account

  transfer(i: AlipayTransferInput): Promise<ChannelResult<Json>> {
    const biz: Json = {
      out_biz_no: i.outBizNo,
      trans_amount: fenToYuan(positiveFen(i.amountFen)),
      product_code: i.productCode ?? DEFAULT_PRODUCT_CODE,
      biz_scene: i.bizScene ?? DEFAULT_BIZ_SCENE,
      order_title: i.orderTitle,
      payee_info: { identity: i.payeeLogonId, identity_type: 'ALIPAY_LOGON_ID', name: i.payeeName },
    };
    if (i.remark !== undefined) biz['remark'] = i.remark;
    if (i.transferSceneName !== undefined) biz['transfer_scene_name'] = i.transferSceneName;
    if (i.sceneReportInfos !== undefined) {
      biz['transfer_scene_report_infos'] = i.sceneReportInfos.map((r) => ({
        info_type: r.infoType,
        info_content: r.infoContent,
      }));
    }
    return this.#call('alipay.fund.trans.uni.transfer', biz);
  }

  transferQuery(
    outBizNo: string,
    productCode?: string,
    bizScene?: string,
  ): Promise<ChannelResult<Json>> {
    return this.#call('alipay.fund.trans.common.query', {
      out_biz_no: outBizNo,
      product_code: productCode ?? DEFAULT_PRODUCT_CODE,
      biz_scene: bizScene ?? DEFAULT_BIZ_SCENE,
    });
  }

  // ---- notifications

  /**
   * Verifies an asynchronous notification (already form-decoded). The caller still checks
   * `app_id`, `out_trade_no`, `total_amount` and `trade_status` against its own order, and
   * answers the literal text `success` only after its transaction commits.
   */
  verifyNotification(form: Readonly<Record<string, string>>): boolean {
    const signature = form['sign'];
    if (signature === undefined || signature === '') return false;
    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(form)) {
      if (k !== 'sign' && k !== 'sign_type') rest[k] = v;
    }
    return rsa2Verify(alipaySignContent(rest), signature, this.#c.alipayPublicKeyPem);
  }

  // ---- internals

  #signedParams(method: string, biz: Json, notifyUrl?: string): Record<string, string> {
    const params: Record<string, string> = {
      app_id: this.#c.appId,
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: alipayTimestamp(this.#now()),
      version: '1.0',
      app_cert_sn: this.#c.appCertSn,
      alipay_root_cert_sn: this.#c.alipayRootCertSn,
      biz_content: JSON.stringify(biz),
    };
    if (notifyUrl !== undefined) params['notify_url'] = notifyUrl;
    params['sign'] = rsa2Sign(alipaySignContent(params), this.#c.privateKeyPem);
    return params;
  }

  async #call(method: string, biz: Json): Promise<ChannelResult<Json>> {
    const params = this.#signedParams(method, biz);
    const res = await send(this.#transport, {
      method: 'POST',
      url: this.#gateway,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(params).toString(),
      timeoutMs: this.#c.timeoutMs ?? 10_000,
    });
    if ('kind' in res) return res;
    if (res.status >= 500)
      return { kind: 'unknown', reason: 'http_5xx', detail: String(res.status) };
    if (res.status !== 200)
      return { kind: 'unknown', reason: 'bad_body', detail: String(res.status) };

    const nodeKey = `${method.replaceAll('.', '_')}_response`;
    const nodeRaw =
      extractJsonNode(res.body, nodeKey) ?? extractJsonNode(res.body, 'error_response');
    let outer: Json;
    let node: Json;
    try {
      outer = JSON.parse(res.body) as Json;
      if (nodeRaw === undefined) throw new Error('no response node');
      node = JSON.parse(nodeRaw) as Json;
    } catch {
      return { kind: 'unknown', reason: 'bad_body', detail: '200' };
    }
    const code = typeof node['code'] === 'string' ? node['code'] : '';
    const subCode = typeof node['sub_code'] === 'string' ? node['sub_code'] : '';
    const signature = typeof outer['sign'] === 'string' ? outer['sign'] : '';
    const verified = signature !== '' && rsa2Verify(nodeRaw, signature, this.#c.alipayPublicKeyPem);

    if (!verified && !(signature === '' && UNSIGNED_REFUSALS.has(code))) {
      return { kind: 'unknown', reason: 'bad_signature', detail: code };
    }
    if (code === '10000') return { kind: 'ok', data: node, raw: res.body };
    if (UNKNOWN_CODES.has(code) || UNKNOWN_SUB_CODES.has(subCode)) {
      return { kind: 'unknown', reason: 'http_5xx', detail: subCode === '' ? code : subCode };
    }
    const message =
      typeof node['sub_msg'] === 'string' ? node['sub_msg'] : String(node['msg'] ?? '');
    return {
      kind: 'rejected',
      code: subCode === '' ? code : subCode,
      message,
      httpStatus: 200,
      raw: res.body,
    };
  }
}

/**
 * Returns the exact text of the JSON object stored under a top-level key. The response signature
 * covers this text byte for byte, so it must not be re-serialised.
 */
export function extractJsonNode(raw: string, key: string): string | undefined {
  const marker = `"${key}":`;
  const at = raw.indexOf(marker);
  if (at < 0) return undefined;
  const start = raw.indexOf('{', at + marker.length);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return undefined;
}

function positiveFen(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new RangeError('amount must be a positive integer of fen');
  return n;
}
