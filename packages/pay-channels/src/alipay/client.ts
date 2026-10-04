// Alipay OpenAPI client (certificate mode): APP pay (collect) and transfer to an Alipay account
// (payout). One HTTP attempt per call; no retries here. Amounts are integers of fen.
import { fenToYuan } from '../amount.ts';
import {
  type ChannelResult,
  fetchTransport,
  send,
  type Shape,
  shapeViolation,
  type Transport,
  type UnknownResult,
} from '../transport.ts';
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
  /** From `certSn(alipayCertPublicKey)`: answers signed under any other certificate are not trusted. */
  readonly alipayCertSn: string;
  readonly gateway?: string;
  readonly timeoutMs?: number;
  readonly transport?: Transport;
  /** Epoch milliseconds. */
  readonly now?: () => number;
  /** Overrides `ALIPAY_DEFAULT_REJECT_CODES` (matched against `sub_code`). */
  readonly rejectCodes?: ReadonlySet<string>;
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

/**
 * `sub_code`s the docs describe as "the request was refused". A verified answer with one of these
 * is `rejected`; every other code — still processing, system error, conflicting duplicate, bill
 * not visible, or simply not on this list — is `unknown` with the code kept for the caller.
 */
export const ALIPAY_DEFAULT_REJECT_CODES: ReadonlySet<string> = new Set([
  'INVALID_PARAMETER',
  'PAYEE_NOT_EXIST',
  'BALANCE_IS_NOT_ENOUGH',
]);

/** Largest response accepted; anything bigger is treated as malformed. */
const MAX_RESPONSE_CHARS = 1_000_000;

const TRANSFER_STATUS = ['SUCCESS', 'FAIL', 'DEALING'];
const TRANSFER_QUERY_STATUS = ['SUCCESS', 'WAIT_PAY', 'CLOSED', 'FAIL', 'DEALING', 'REFUND'];
const TRADE_STATUS = ['WAIT_BUYER_PAY', 'TRADE_CLOSED', 'TRADE_SUCCESS', 'TRADE_FINISHED'];

const DEFAULT_PRODUCT_CODE = 'TRANS_ACCOUNT_NO_PWD';
const DEFAULT_BIZ_SCENE = 'DIRECT_TRANSFER';

export class AlipayClient {
  readonly #c: AlipayConfig;
  readonly #gateway: string;
  readonly #transport: Transport;
  readonly #now: () => number;
  readonly #rejectCodes: ReadonlySet<string>;

  constructor(config: AlipayConfig) {
    this.#c = config;
    this.#gateway = config.gateway ?? 'https://openapi.alipay.com/gateway.do';
    this.#transport = config.transport ?? fetchTransport;
    this.#now = config.now ?? (() => Date.now());
    this.#rejectCodes = config.rejectCodes ?? ALIPAY_DEFAULT_REJECT_CODES;
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
    return this.#call(
      'alipay.trade.query',
      { out_trade_no: outTradeNo },
      {
        strings: ['out_trade_no', 'trade_no', 'trade_status', 'total_amount'],
        enums: { trade_status: TRADE_STATUS },
        echo: { out_trade_no: outTradeNo },
      },
    );
  }

  tradeClose(outTradeNo: string): Promise<ChannelResult<Json>> {
    return this.#call(
      'alipay.trade.close',
      { out_trade_no: outTradeNo },
      { strings: ['out_trade_no'], echo: { out_trade_no: outTradeNo } },
    );
  }

  tradeRefund(i: AlipayRefundInput): Promise<ChannelResult<Json>> {
    const biz: Json = {
      out_trade_no: i.outTradeNo,
      out_request_no: i.outRequestNo,
      refund_amount: fenToYuan(positiveFen(i.refundFen)),
    };
    if (i.reason !== undefined) biz['refund_reason'] = i.reason;
    return this.#call('alipay.trade.refund', biz, {
      strings: ['out_trade_no', 'refund_fee'],
      echo: { out_trade_no: i.outTradeNo },
    });
  }

  refundQuery(outTradeNo: string, outRequestNo: string): Promise<ChannelResult<Json>> {
    // The doc notes that a refund which does not exist answers 10000 with no refund fields, so
    // nothing is required here: the caller reads `refund_status` / `refund_amount` itself.
    return this.#call(
      'alipay.trade.fastpay.refund.query',
      { out_trade_no: outTradeNo, out_request_no: outRequestNo },
      { echo: { out_trade_no: outTradeNo, out_request_no: outRequestNo } },
    );
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
    return this.#call('alipay.fund.trans.uni.transfer', biz, {
      strings: ['out_biz_no', 'status'],
      enums: { status: TRANSFER_STATUS },
      echo: { out_biz_no: i.outBizNo },
    });
  }

  transferQuery(
    outBizNo: string,
    productCode?: string,
    bizScene?: string,
  ): Promise<ChannelResult<Json>> {
    return this.#call(
      'alipay.fund.trans.common.query',
      {
        out_biz_no: outBizNo,
        product_code: productCode ?? DEFAULT_PRODUCT_CODE,
        biz_scene: bizScene ?? DEFAULT_BIZ_SCENE,
      },
      {
        strings: ['out_biz_no', 'status'],
        enums: { status: TRANSFER_QUERY_STATUS },
        echo: { out_biz_no: outBizNo },
      },
    );
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

  async #call(method: string, biz: Json, shape: Shape): Promise<ChannelResult<Json>> {
    const params = this.#signedParams(method, biz);
    // Public parameters travel in the query string, the business payload in the form body; the
    // signature covers both.
    const { biz_content: bizContent, ...publicParams } = params;
    const res = await send(this.#transport, {
      method: 'POST',
      url: withQuery(this.#gateway, publicParams),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams({ biz_content: bizContent ?? '' }).toString(),
      timeoutMs: this.#c.timeoutMs ?? 10_000,
    });
    if ('kind' in res) return res;
    const status = String(res.status);
    if (res.status >= 500) return unknown('http_5xx', status);
    if (res.status !== 200) return unknown('bad_body', status);

    // The whole answer must be valid JSON before any part of it is looked at; the scanner only
    // keeps the exact text of each member, which is what the signature covers.
    if (res.body.length > MAX_RESPONSE_CHARS || !isJsonObject(res.body)) {
      return unknown('bad_body', 'not a JSON object');
    }
    const members = topLevelMembers(res.body);
    if (members === undefined) return unknown('bad_body', 'not a JSON object');
    const nodeKey = `${method.replaceAll('.', '_')}_response`;
    const one = (key: string): string | undefined => {
      const hits = members.filter((m) => m.key === key);
      return hits.length === 1 ? hits[0]?.raw : undefined;
    };
    const count = (key: string): number => members.filter((m) => m.key === key).length;

    // Readable code for diagnostics only; nothing is trusted before the signature check.
    const nodeRaw = one(nodeKey);
    const hint = diagnosticCode(nodeRaw ?? one('error_response'));

    if (count(nodeKey) !== 1 || count('error_response') !== 0 || count('sign') !== 1) {
      return unknown('bad_signature', 'missing, duplicated or conflicting response members', hint);
    }
    if (nodeRaw === undefined || !nodeRaw.startsWith('{')) {
      return unknown('bad_body', 'response node is not an object', hint);
    }
    const signature = parseString(one('sign'));
    if (signature === undefined || signature === '')
      return unknown('bad_signature', 'no signature', hint);
    if (parseString(one('alipay_cert_sn')) !== this.#c.alipayCertSn) {
      return unknown('bad_signature', 'certificate serial mismatch', hint);
    }
    if (!rsa2Verify(nodeRaw, signature, this.#c.alipayPublicKeyPem)) {
      return unknown('bad_signature', 'signature mismatch', hint);
    }

    const node = JSON.parse(nodeRaw) as Json;
    const code = typeof node['code'] === 'string' ? node['code'] : '';
    if (code === '') return unknown('bad_body', 'no code');
    const rawSub = node['sub_code'];
    if (rawSub !== undefined && typeof rawSub !== 'string') {
      return unknown('bad_body', 'sub_code is not a string', code);
    }
    const subCode = rawSub ?? '';
    const shown = subCode === '' ? code : subCode;

    if (code === '10000') {
      if (subCode !== '') return unknown('bad_body', 'success code with a sub_code', shown);
      const violation = shapeViolation(node, shape);
      if (violation !== undefined) return unknown('bad_body', violation);
      return { kind: 'ok', data: node };
    }
    if (!this.#rejectCodes.has(subCode)) return unknown('indeterminate', code, shown);
    const message = typeof node['sub_msg'] === 'string' ? node['sub_msg'] : '';
    return { kind: 'rejected', code: subCode, message, httpStatus: 200 };
  }
}

function withQuery(gateway: string, params: Readonly<Record<string, string>>): string {
  const url = new URL(gateway);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function isJsonObject(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

function unknown(reason: UnknownResult['reason'], detail: string, code?: string): UnknownResult {
  return code === undefined
    ? { kind: 'unknown', reason, detail }
    : { kind: 'unknown', reason, detail, code };
}

function parseString(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

function diagnosticCode(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const v = JSON.parse(raw) as { code?: unknown; sub_code?: unknown } | null;
    if (v === null || typeof v !== 'object') return undefined;
    if (typeof v.sub_code === 'string' && v.sub_code !== '') return v.sub_code;
    return typeof v.code === 'string' && v.code !== '' ? v.code : undefined;
  } catch {
    return undefined;
  }
}

export interface TopLevelMember {
  readonly key: string;
  /** Exact text of the value. The response signature covers this text byte for byte. */
  readonly raw: string;
}

/**
 * Splits a JSON object into its top-level members without re-serialising anything. Nested keys
 * are never returned, duplicate keys are all returned (the caller rejects them), and whitespace
 * around tokens is tolerated. Returns `undefined` when the text is not a single JSON object.
 */
export function topLevelMembers(text: string): TopLevelMember[] | undefined {
  const ws = (i: number): number => {
    let j = i;
    while (j < text.length && ' \t\r\n'.includes(text[j] ?? '')) j += 1;
    return j;
  };
  const stringEnd = (i: number): number => {
    // text[i] is the opening quote; returns the index just past the closing quote, or -1.
    for (let j = i + 1; j < text.length; j += 1) {
      const ch = text[j];
      if (ch === '\\') j += 1;
      else if (ch === '"') return j + 1;
    }
    return -1;
  };
  const valueEnd = (i: number): number => {
    const ch = text[i];
    if (ch === '"') return stringEnd(i);
    if (ch === '{' || ch === '[') {
      let depth = 0;
      for (let j = i; j < text.length; j += 1) {
        const c = text[j];
        if (c === '"') {
          const end = stringEnd(j);
          if (end < 0) return -1;
          j = end - 1;
        } else if (c === '{' || c === '[') depth += 1;
        else if (c === '}' || c === ']') {
          depth -= 1;
          if (depth === 0) return j + 1;
        }
      }
      return -1;
    }
    let j = i;
    while (j < text.length && !',} \t\r\n'.includes(text[j] ?? '')) j += 1;
    return j > i ? j : -1;
  };

  let i = ws(0);
  if (text[i] !== '{') return undefined;
  i = ws(i + 1);
  const out: TopLevelMember[] = [];
  if (text[i] === '}') return ws(i + 1) === text.length ? out : undefined;
  for (;;) {
    if (text[i] !== '"') return undefined;
    const keyEnd = stringEnd(i);
    if (keyEnd < 0) return undefined;
    const key = parseString(text.slice(i, keyEnd));
    if (key === undefined) return undefined;
    i = ws(keyEnd);
    if (text[i] !== ':') return undefined;
    i = ws(i + 1);
    const end = valueEnd(i);
    if (end < 0) return undefined;
    out.push({ key, raw: text.slice(i, end) });
    i = ws(end);
    if (text[i] === ',') {
      i = ws(i + 1);
      continue;
    }
    if (text[i] === '}') return ws(i + 1) === text.length ? out : undefined;
    return undefined;
  }
}

function positiveFen(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new RangeError('amount must be a positive integer of fen');
  return n;
}
