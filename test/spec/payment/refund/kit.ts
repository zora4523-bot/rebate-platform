// B2-15e rule-test kit (claude-independent, SPEC_REF c4cfc1a2; 08 BR-PAY-06 and 细则, BR-PAY-07 退款
// 凭证; 规划/04 §5「幂等」a:<admin_user_id> (D10-168 ②); 02 §11 pay_refund.succeeded (D10-349);
// specs/ledger-rules.md §10; contracts/openapi.yaml createAdminPayRefund /
// createAdminPayAnomalyRefund; D10-350 pay_refunds.note; D10-351 idempotency unique key
// (app_id, operator, idempotency_key) and refund.query enqueued in the creating transaction).
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission
// checks, contract validation, PostgreSQL idempotency, audit writer, started JOB_QUEUE), the api
// entry's notification route (../result/kit.ts withNotify), the pay queue's handler
// (createPayJobHandler over ../result/kit.ts jobKit), ledger's posting, pgboss and event_log.
// Synthetic: the two channels. RefundSpecChannel extends B2-15c's SpecPayChannel with the refund
// side: it records every submission (and can look at the database while it is called), answers
// refund queries as scripted, and signs its own refund notifications (an HMAC in place of the
// channel signature, AES-256-GCM over the WeChat resource as in APIv3); field names follow the
// official refund notification formats (WeChat 退款结果通知, Alipay 异步通知 out_biz_no /
// refund_fee), not a real merchant. Admin accounts, tokens and sessions are seeded the way
// test/spec/content/dict-admin/kit.ts does.
// Missing pieces fail as assertions (an unregistered admin route answers 404; the pay queue's
// handler refuses an unknown job name) or as NotImplemented. Plain SQL always names the schema.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Insertable, type KyselyPlugin, type Selectable } from 'kysely';
import { expect, vi } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import {
  PayChannelSet,
  type PayChannelIdentity,
  type PayNotificationResult,
  type PayRawNotification,
  type PayRefundInput,
  type PayRefundQueryResult,
  type PayRefundResult,
} from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import {
  anomalyVoucher,
  receiptVoucher,
} from '../../../../apps/api/src/modules/payment/application/pay-settlement.ts';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type FixedClock,
  type JobHandler,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { seedOrder, type Fixture, type OrderRow } from '../orders/kit.ts';
import {
  AMOUNT,
  SpecPayChannel,
  jobKit,
  payJobHandler,
  queued,
  received,
  tradeNo,
  yuanText,
  type Built,
  type JobKit,
  type QueuedJob,
} from '../result/kit.ts';

export const CHANNELS = ['wechat_pay', 'alipay'] as const;
export { AMOUNT };

/**
 * The documented refund success state of each channel (BR-PAY-06 细则 默认值, 待实测): WeChat Pay
 * 退款查询 status / 退款结果通知 refund_status SUCCESS; Alipay alipay.trade.fastpay.refund.query
 * refund_status REFUND_SUCCESS.
 */
export const REFUND_SUCCESS: Record<PayChannelCode, string> = {
  wechat_pay: 'SUCCESS',
  alipay: 'REFUND_SUCCESS',
};
/** A refund state of each channel that is in no default list (WeChat documents ABNORMAL). */
export const NOT_LISTED: Record<PayChannelCode, string> = {
  wechat_pay: 'ABNORMAL',
  alipay: 'REFUND_PROCESSING',
};
/** A failure-looking state of each channel, listed only when refund_fail_states says so. */
export const CLOSED_STATE: Record<PayChannelCode, string> = {
  wechat_pay: 'CLOSED',
  alipay: 'REFUND_CLOSED',
};
/** The event of a SUCCESS refund (02 §11, D10-349). */
export const REFUND_EVENT = 'pay_refund.succeeded';
/** The job of one refund query (apps/api/src/modules/payment/jobs/names.ts RefundQueryPayload). */
export const REFUND_QUERY_JOB = 'refund.query';
/** The audit action of a refund (contracts/openapi.yaml createAdminPayRefund). */
export const AUDIT_ACTION = 'pay_refund_create';
export const REASONS = [
  'USER_REQUEST',
  'DUPLICATE_PAYMENT',
  'ANOMALY_RECEIPT',
  'RECON_DIFF',
  'OTHER',
] as const;
/** pay_refunds_out_refund_no_check. */
export const OUT_REFUND_NO = /^[A-Za-z0-9]{1,32}$/;

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

// ---------------------------------------------------------------------------------------------
// Synthetic channel with the refund side.

function hmac(key: Buffer, text: string): string {
  return createHmac('sha256', key).update(text, 'utf8').digest('base64');
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

function digits(n: number): string {
  return Array.from(randomBytes(n), (byte) => String(byte % 10)).join('');
}

function headerOf(raw: PayRawNotification, name: string): string | null {
  for (const [key, value] of Object.entries(raw.headers)) {
    if (key.toLowerCase() === name) return String(value);
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`spec refund channel: ${name}`);
  return value;
}

function fenOfYuan(value: string): bigint {
  const match = /^(\d+)\.(\d{2})$/.exec(value);
  if (match === null) throw new Error('spec refund channel: yuan amount');
  return BigInt(match[1]!) * 100n + BigInt(match[2]!);
}

/** Alipay's signing content: every parameter but sign / sign_type, sorted, k=v joined by &. */
function signingText(params: Iterable<[string, string]>): string {
  return [...params]
    .filter(([key]) => key !== 'sign' && key !== 'sign_type')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

/** A fresh channel refund number of the channel's look. */
export function channelRefundNo(channel: PayChannelCode): string {
  return channel === 'wechat_pay' ? `50300${digits(24)}` : `2026102522001${digits(15)}`;
}

/** One refund notification as the channel would send it. */
export interface RefundNotice {
  readonly identity: PayChannelIdentity;
  readonly outRefundNo: string;
  /** The original's merchant number; null leaves it out. */
  readonly outTradeNo: string | null;
  readonly channelTradeNo: string;
  readonly totalFen: bigint;
  readonly refundFen: bigint;
  readonly state: string;
  readonly channelRefundNo?: string;
  readonly notifyId?: string;
}

/** What a refund query sees for an out_refund_no; null fields are left out of the answer. */
export interface SpecRefund {
  readonly channelState: string | null;
  readonly refundFen: bigint | null;
  readonly outTradeNo: string | null;
  readonly channelTradeNo: string | null;
  readonly channelRefundNo: string | null;
  readonly identity: PayChannelIdentity | null;
}

export class RefundSpecChannel extends SpecPayChannel {
  /** Every refund submitted, in call order. */
  readonly submitted: PayRefundInput[] = [];
  /** Every out_refund_no queried, in call order. */
  readonly refundQueried: string[] = [];
  /** Runs inside refund() before it answers: the database as it is while the channel is called. */
  onRefund: ((input: PayRefundInput) => Promise<void>) | null = null;
  readonly #answers: ('ok' | 'unknown')[] = [];
  readonly #refunds = new Map<string, SpecRefund | 'timeout'>();
  readonly #signKey = randomBytes(32);
  readonly #aesKey = randomBytes(32);
  readonly #serial = randomBytes(8).toString('hex').toUpperCase();

  /** Queues the answers of the next refund calls, first in first out; none queued → ok. */
  scriptRefund(answers: readonly ('ok' | 'unknown')[]): void {
    this.#answers.push(...answers);
  }

  /** Sets what refundQuery answers for an out_refund_no ('timeout' → unknown). */
  setRefund(outRefundNo: string, refund: SpecRefund | 'timeout'): void {
    this.#refunds.set(outRefundNo, refund);
  }

  override async refund(input: PayRefundInput): Promise<PayRefundResult> {
    this.submitted.push({ ...input });
    if (this.onRefund !== null) await this.onRefund(input);
    const answer = this.#answers.shift() ?? 'ok';
    return answer === 'ok' ? { kind: 'ok' } : { kind: 'unknown', reason: 'spec_timeout' };
  }

  override refundQuery(outRefundNo: string): Promise<PayRefundQueryResult> {
    this.refundQueried.push(outRefundNo);
    const refund = this.#refunds.get(outRefundNo);
    if (refund === undefined) {
      return Promise.resolve({ kind: 'ok', state: 'not_exist', refundFen: null });
    }
    if (refund === 'timeout') return Promise.resolve({ kind: 'unknown', reason: 'spec_timeout' });
    const summary = refund.channelState === REFUND_SUCCESS[this.channel] ? 'success' : 'processing';
    return Promise.resolve({
      kind: 'ok',
      state: summary,
      refundFen: refund.refundFen,
      outTradeNo: refund.outTradeNo,
      channelTradeNo: refund.channelTradeNo,
      channelRefundNo: refund.channelRefundNo,
      ...(refund.channelState === null ? {} : { channelState: refund.channelState }),
      ...(refund.identity === null
        ? {}
        : { merchantRef: refund.identity.merchantRef, appRef: refund.identity.appRef }),
    });
  }

  /** A signed refund notification of this channel's format. */
  refundNotification(notice: RefundNotice): Built {
    const notifyId = notice.notifyId ?? `RN${randomBytes(12).toString('hex')}`;
    const refundNo = notice.channelRefundNo ?? channelRefundNo(this.channel);
    return this.channel === 'wechat_pay'
      ? this.#wechat(notice, notifyId, refundNo)
      : this.#alipay(notice, notifyId, refundNo);
  }

  /** The same refund notification signed by someone else's key. */
  forgeRefund(built: Built): PayRawNotification {
    const other = randomBytes(32);
    if (this.channel === 'wechat_pay') {
      const timestamp = headerOf(built.raw, 'wechatpay-timestamp') ?? '';
      const nonce = headerOf(built.raw, 'wechatpay-nonce') ?? '';
      return {
        headers: {
          ...built.raw.headers,
          'wechatpay-signature': hmac(other, `${timestamp}\n${nonce}\n${built.raw.body}\n`),
        },
        body: built.raw.body,
      };
    }
    const params = new URLSearchParams(built.raw.body);
    params.set('sign', hmac(other, signingText(params.entries())));
    return { headers: built.raw.headers, body: params.toString() };
  }

  override verifyNotification(raw: PayRawNotification): Promise<PayNotificationResult> {
    let mine: PayNotificationResult | null;
    try {
      mine = this.channel === 'wechat_pay' ? this.#readWechat(raw) : this.#readAlipay(raw);
    } catch {
      mine = { kind: 'rejected', reason: 'spec_unreadable' };
    }
    return mine === null ? super.verifyNotification(raw) : Promise.resolve(mine);
  }

  #wechat(notice: RefundNotice, notifyId: string, refundNo: string): Built {
    const resource = {
      mchid: notice.identity.merchantRef,
      // Not part of WeChat's refund resource: a real adapter takes its appid from its own
      // configuration (B2-15k); the synthetic resource carries it so the identity can be checked.
      appid: notice.identity.appRef,
      ...(notice.outTradeNo === null ? {} : { out_trade_no: notice.outTradeNo }),
      transaction_id: notice.channelTradeNo,
      out_refund_no: notice.outRefundNo,
      refund_id: refundNo,
      refund_status: notice.state,
      success_time: '2026-10-25T09:00:00+08:00',
      user_received_account: 'synthetic',
      amount: {
        total: Number(notice.totalFen),
        refund: Number(notice.refundFen),
        payer_total: Number(notice.totalFen),
        payer_refund: Number(notice.refundFen),
      },
    };
    const nonce = randomBytes(6).toString('hex');
    const aad = 'refund';
    const cipher = createCipheriv('aes-256-gcm', this.#aesKey, Buffer.from(nonce, 'utf8'));
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(resource), 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64');
    const body = JSON.stringify({
      id: notifyId,
      create_time: '2026-10-25T09:00:01+08:00',
      resource_type: 'encrypt-resource',
      event_type: notice.state === 'SUCCESS' ? 'REFUND.SUCCESS' : 'REFUND.ABNORMAL',
      summary: 'synthetic',
      resource: {
        original_type: 'refund',
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext,
        associated_data: aad,
        nonce,
      },
    });
    const timestamp = '1792890001';
    const headerNonce = randomBytes(16).toString('hex');
    const signature = hmac(this.#signKey, `${timestamp}\n${headerNonce}\n${body}\n`);
    return {
      notifyId,
      raw: {
        headers: {
          'content-type': 'application/json',
          'wechatpay-timestamp': timestamp,
          'wechatpay-nonce': headerNonce,
          'wechatpay-serial': this.#serial,
          'wechatpay-signature': signature,
          'wechatpay-signature-type': 'WECHATPAY2-SHA256-RSA2048',
        },
        body,
      },
      secrets: [ciphertext, signature, headerNonce],
    };
  }

  /** null when the body is not a refund notification of this channel (B2-15c's own then). */
  #readWechat(raw: PayRawNotification): PayNotificationResult | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.body) as unknown;
    } catch {
      return null;
    }
    const body = record(parsed);
    const resource = record(body?.['resource']);
    if (body === null || resource === null || resource['original_type'] !== 'refund') return null;
    const timestamp = headerOf(raw, 'wechatpay-timestamp') ?? '';
    const nonce = headerOf(raw, 'wechatpay-nonce') ?? '';
    const signature = headerOf(raw, 'wechatpay-signature') ?? '';
    if (!same(signature, hmac(this.#signKey, `${timestamp}\n${nonce}\n${raw.body}\n`))) {
      return { kind: 'rejected', reason: 'spec_signature' };
    }
    const data = Buffer.from(text(resource['ciphertext'], 'ciphertext'), 'base64');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#aesKey,
      Buffer.from(text(resource['nonce'], 'nonce'), 'utf8'),
    );
    decipher.setAAD(Buffer.from(text(resource['associated_data'], 'associated_data'), 'utf8'));
    decipher.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([
      decipher.update(data.subarray(0, data.length - 16)),
      decipher.final(),
    ]).toString('utf8');
    const refund = record(JSON.parse(plain) as unknown);
    const amount = record(refund?.['amount']);
    if (refund === null || amount === null) throw new Error('spec refund channel: resource');
    const total = amount['total'];
    const refunded = amount['refund'];
    if (typeof total !== 'number' || typeof refunded !== 'number') throw new Error('amount');
    const outTradeNo = refund['out_trade_no'];
    return {
      kind: 'ok',
      notifyId: text(body['id'], 'id'),
      outTradeNo: typeof outTradeNo === 'string' ? outTradeNo : null,
      outRefundNo: text(refund['out_refund_no'], 'out_refund_no'),
      channelTradeNo: text(refund['transaction_id'], 'transaction_id'),
      amountFen: BigInt(total),
      state: text(refund['refund_status'], 'refund_status'),
      merchantRef: text(refund['mchid'], 'mchid'),
      appRef: text(refund['appid'], 'appid'),
      refundFen: BigInt(refunded),
      channelRefundNo: text(refund['refund_id'], 'refund_id'),
    };
  }

  #alipay(notice: RefundNotice, notifyId: string, refundNo: string): Built {
    const params: [string, string][] = [
      ['notify_id', notifyId],
      ['notify_type', 'trade_status_sync'],
      ['notify_time', '2026-10-25 09:00:02'],
      ['charset', 'utf-8'],
      ['version', '1.0'],
      ['app_id', notice.identity.appRef],
      ['auth_app_id', notice.identity.appRef],
      ['seller_id', notice.identity.merchantRef],
      ...(notice.outTradeNo === null
        ? []
        : [['out_trade_no', notice.outTradeNo] as [string, string]]),
      ['trade_no', notice.channelTradeNo],
      ['out_biz_no', notice.outRefundNo],
      ['refund_fee', yuanText(notice.refundFen)],
      ['total_amount', yuanText(notice.totalFen)],
      ['gmt_refund', '2026-10-25 09:00:01.000'],
      ['trade_status', 'TRADE_SUCCESS'],
      // Synthetic: the refund's own state and number as the adapter reads them (B2-15k maps the
      // documented fields; 待实测).
      ['refund_status', notice.state],
      ['refund_no', refundNo],
    ];
    const sign = hmac(this.#signKey, signingText(params));
    const form = new URLSearchParams([...params, ['sign', sign], ['sign_type', 'RSA2']]);
    return {
      notifyId,
      raw: {
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: form.toString(),
      },
      secrets: [sign, encodeURIComponent(sign)],
    };
  }

  /** null when the form is not a refund notification (no out_biz_no): B2-15c's own then. */
  #readAlipay(raw: PayRawNotification): PayNotificationResult | null {
    const params = new URLSearchParams(raw.body);
    if (params.get('out_biz_no') === null) return null;
    const sign = params.get('sign') ?? '';
    if (!same(sign, hmac(this.#signKey, signingText(params.entries())))) {
      return { kind: 'rejected', reason: 'spec_signature' };
    }
    const need = (name: string): string => text(params.get(name), name);
    return {
      kind: 'ok',
      notifyId: need('notify_id'),
      outTradeNo: params.get('out_trade_no'),
      outRefundNo: need('out_biz_no'),
      channelTradeNo: need('trade_no'),
      amountFen: fenOfYuan(need('total_amount')),
      state: need('refund_status'),
      merchantRef: need('seller_id'),
      appRef: need('app_id'),
      refundFen: fenOfYuan(need('refund_fee')),
      channelRefundNo: need('refund_no'),
    };
  }
}

export type RefundChannels = Record<PayChannelCode, RefundSpecChannel>;

/** Both channels, each with an identity registered as the fixture app's. */
export function refundChannels(f: Fixture): {
  channels: RefundChannels;
  identity: Record<PayChannelCode, PayChannelIdentity>;
} {
  const channels: RefundChannels = {
    wechat_pay: new RefundSpecChannel('wechat_pay'),
    alipay: new RefundSpecChannel('alipay'),
  };
  return {
    channels,
    identity: {
      wechat_pay: channels.wechat_pay.own(f.subject.app_id),
      alipay: channels.alipay.own(f.subject.app_id),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Seeds: the state the earlier flows (B2-15c settlement, anomaly registration) would have left.

export type RefundRow = Selectable<DB['pay_refunds']>;
export type AnomalyRow = Selectable<DB['pay_anomalies']>;

/** A PAID order of the test type on the channel with its PAY_RECEIPT voucher (BR-PAY-07). */
export async function seedPaid(
  f: Fixture,
  kit: JobKit,
  channel: PayChannelCode,
  patch: Partial<Insertable<DB['pay_orders']>> = {},
): Promise<OrderRow> {
  const order = await seedOrder(f, {
    pay_channel: channel,
    amount_fen: AMOUNT,
    status: 'PAID',
    channel_trade_no: tradeNo(channel),
    launch_issued_at: f.clock.now(),
    paid_at: f.clock.now(),
    ...patch,
  });
  await f.db.transaction().execute((trx) => kit.deps.ledger.post(trx, receiptVoucher(order)));
  return order;
}

/**
 * An open anomaly receipt with its PAY_ANOMALY voucher (BR-PAY-05 ④): money the channel received
 * for a CLOSED order of ours (withOrder) or for no order of ours (out_trade_no null).
 */
export async function seedAnomaly(
  f: Fixture,
  kit: JobKit,
  channel: PayChannelCode,
  options: { readonly withOrder: boolean; readonly amountFen?: bigint },
): Promise<{ anomaly: AnomalyRow; order: OrderRow | null }> {
  const order = options.withOrder
    ? await seedOrder(f, {
        pay_channel: channel,
        amount_fen: options.amountFen ?? AMOUNT,
        status: 'CLOSED',
        closed_at: f.clock.now(),
      })
    : null;
  const id = randomUUID();
  const amountFen = options.amountFen ?? AMOUNT;
  await f.db
    .insertInto('pay_anomalies')
    .values({
      id,
      app_id: f.subject.app_id,
      pay_channel: channel,
      channel_trade_no: tradeNo(channel),
      out_trade_no: order?.out_trade_no ?? null,
      pay_order_id: order?.id ?? null,
      amount_fen: amountFen,
      refunded_fen: 0n,
      evidence: sql`${JSON.stringify({ source: 'notify', seeded_by: 'b2-15e-spec' })}::jsonb`,
      status: 'open',
      created_at: f.clock.now(),
    })
    .execute();
  const anomaly = await anomalyRow(f, id);
  await f.db.transaction().execute((trx) => kit.deps.ledger.post(trx, anomalyVoucher(anomaly)));
  return { anomaly, order };
}

export interface RefundTargetRef {
  readonly type: 'pay_order' | 'pay_anomaly';
  readonly id: string;
}

/** A fresh out_refund_no of our look for seeded refunds (R + 20 upper-case hex). */
export function seededRefundNo(): string {
  return `R${randomBytes(10).toString('hex').toUpperCase()}`;
}

/**
 * A refund row written directly (what B2-15e's own creation would have left). A SUCCESS one also
 * moves the target's refunded_fen, as the success handling does.
 */
export async function seedRefund(
  f: Fixture,
  target: RefundTargetRef,
  patch: Partial<Insertable<DB['pay_refunds']>> = {},
): Promise<RefundRow> {
  const id = patch.id ?? randomUUID();
  await f.db
    .insertInto('pay_refunds')
    .values({
      app_id: f.subject.app_id,
      target_type: target.type,
      target_id: target.id,
      idempotency_key: `seed_${randomBytes(12).toString('hex')}`,
      out_refund_no: seededRefundNo(),
      amount_fen: 1_000n,
      reason_code: 'USER_REQUEST',
      status: 'PROCESSING',
      channel_refund_no: null,
      operator: randomUUID(),
      created_at: f.clock.now(),
      succeeded_at: null,
      failed_at: null,
      ...patch,
      id,
    })
    .execute();
  const row = await refundRow(f, id);
  if (row.status === 'SUCCESS') {
    const amount = row.amount_fen.toString();
    if (target.type === 'pay_order') {
      await sql`UPDATE app.pay_orders SET refunded_fen = refunded_fen + ${amount}::bigint
        WHERE app_id = ${f.subject.app_id} AND id = ${target.id}`.execute(f.db);
    } else {
      await sql`UPDATE app.pay_anomalies SET refunded_fen = refunded_fen + ${amount}::bigint
        WHERE app_id = ${f.subject.app_id} AND id = ${target.id}`.execute(f.db);
    }
  }
  return row;
}

/** The query answer of a refund that went through, as the channel reports it. */
export function refundedAnswer(
  identity: PayChannelIdentity,
  refund: RefundRow,
  original: { readonly outTradeNo: string | null; readonly channelTradeNo: string },
  channel: PayChannelCode,
  patch: Partial<SpecRefund> = {},
): SpecRefund {
  return {
    channelState: REFUND_SUCCESS[channel],
    refundFen: refund.amount_fen,
    outTradeNo: original.outTradeNo,
    channelTradeNo: original.channelTradeNo,
    channelRefundNo: channelRefundNo(channel),
    identity,
    ...patch,
  };
}

/** The refund notification of a refund of a pay order, success state unless patched. */
export function orderRefundNotice(
  identity: PayChannelIdentity,
  order: OrderRow,
  refund: RefundRow,
  patch: Partial<RefundNotice> = {},
): RefundNotice {
  return {
    identity,
    outRefundNo: refund.out_refund_no,
    outTradeNo: order.out_trade_no,
    channelTradeNo: order.channel_trade_no ?? '',
    totalFen: order.amount_fen,
    refundFen: refund.amount_fen,
    state: REFUND_SUCCESS[order.pay_channel as PayChannelCode],
    ...patch,
  };
}

// ---------------------------------------------------------------------------------------------
// The pay queue's handler and the refund query job.

/** The pay queue's handler over a recording job kit (passing on to pgboss when queue is given). */
export async function refundJobs(
  f: Fixture,
  channels: RefundChannels,
  options: Parameters<typeof jobKit>[2] = {},
): Promise<{ kit: JobKit; handle: JobHandler }> {
  const kit = await jobKit(f, channels, options);
  return { kit, handle: await payJobHandler(kit) };
}

/** One refund.query job of a refund (payload RefundQueryPayload). */
export function refundQueryJob(f: Fixture, refund: RefundRow) {
  return received(REFUND_QUERY_JOB, { app_id: f.subject.app_id, pay_refund_id: refund.id });
}

/**
 * refund.query jobs of queue `pay` whose data mentions `mention` (a refund id, or the app id for
 * every refund of the app).
 */
export async function refundQueryJobs(f: Fixture, mention: string): Promise<QueuedJob[]> {
  return (await queued(f, mention)).filter((job) => job.job === REFUND_QUERY_JOB);
}

/** True once `check` holds; false when a pending request ended first or on timeout. */
export async function until(
  check: () => boolean,
  pending: { readonly settled: boolean },
  timeoutMs = 15_000,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return true;
    if (pending.settled) return check();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** How a promise ended: 'resolved' or the error's name and message (asserted by the caller). */
export async function settled(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : `thrown ${String(error)}`;
  }
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}

export interface AdminSent {
  readonly statusCode: number;
  readonly body: string;
  /** The contract path template of the operation called. */
  readonly template: string;
  json(): Envelope;
}

export interface AdminCaller {
  readonly id: string;
  readonly token: string;
}

export interface RefundRequestOptions {
  /** Idempotency-Key: a fresh one by default; null sends none. */
  readonly key?: string | null;
  /** The caller; null sends no token. */
  readonly caller?: AdminCaller | null;
}

export interface Fault {
  /** One-shot: the next idempotency_keys write after a pay_refunds insert fails. */
  idempotencyAfterRefund: boolean;
  tripped: number;
}

export interface AdminHarness {
  /** Every pino line of the entry. */
  readonly logs: string[];
  readonly fault: Fault;
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** POST of an original-route refund of a pay order or a pay anomaly. */
  refund(
    target: RefundTargetRef,
    body: unknown,
    options?: RefundRequestOptions,
  ): Promise<AdminSent>;
  /** The default caller: an account with pay.refund. */
  readonly operator: AdminCaller;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload: string;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}
interface Builder {
  overrideProvider(token: unknown): { useValue(value: unknown): Builder };
  compile(): Promise<{ createNestApplication(adapter: unknown, options: unknown): HttpApp }>;
}

/** A fresh Idempotency-Key of the contract format (8–64 of [A-Za-z0-9_-]). */
export function newKey(): string {
  return `rk_${randomBytes(12).toString('hex')}`;
}

/** The concrete path of the refund operation of a target. */
export function refundPath(target: RefundTargetRef): string {
  return target.type === 'pay_order'
    ? `/admin/v1/pay-orders/${target.id}/refunds`
    : `/admin/v1/pay-anomalies/${target.id}/refunds`;
}

function refundTemplate(target: RefundTargetRef): string {
  return target.type === 'pay_order'
    ? '/admin/v1/pay-orders/{pay_order_id}/refunds'
    : '/admin/v1/pay-anomalies/{pay_anomaly_id}/refunds';
}

function faultPlugin(fault: Fault): KyselyPlugin {
  let afterRefund = false;
  return {
    transformQuery({ node }) {
      if (!fault.idempotencyAfterRefund) return node;
      const written =
        node.kind === 'InsertQueryNode'
          ? JSON.stringify(node.into ?? null)
          : node.kind === 'UpdateQueryNode'
            ? JSON.stringify(node.table ?? null)
            : '';
      if (node.kind === 'InsertQueryNode' && written.includes('"name":"pay_refunds"')) {
        afterRefund = true;
      }
      if (afterRefund && written.includes('"name":"idempotency_keys"')) {
        afterRefund = false;
        fault.idempotencyAfterRefund = false;
        fault.tripped += 1;
        throw new Error('synthetic failure of the idempotency record write');
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
}

/**
 * Runs `run` against a started admin entry on the fixture's database (through the fault plugin),
 * clock and Redis, with the refund channels in place of the process's channel set.
 */
export async function withAdmin(
  f: Fixture,
  channels: RefundChannels,
  run: (h: AdminHarness) => Promise<void>,
): Promise<void> {
  const { NestFactory } = (await import(
    pathToFileURL(requireApi.resolve('@nestjs/core')).href
  )) as {
    NestFactory: { create(module: unknown, adapter: unknown, options: unknown): Promise<HttpApp> };
  };
  const { Test } = (await import(pathToFileURL(requireApi.resolve('@nestjs/testing')).href)) as {
    Test: { createTestingModule(meta: { imports: unknown[] }): Builder };
  };
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'admin',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: RootLogger;
        dbHandles: DbHandles;
        redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b2-15e-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  const set = { of: (channel: PayChannelCode) => channels[channel] };
  const spy = vi.spyOn(NestFactory, 'create').mockImplementation(async (module, adapter, opts) => {
    const builder = Test.createTestingModule({ imports: [module] });
    builder.overrideProvider(PayChannelSet).useValue(set);
    return (await builder.compile()).createNestApplication(adapter, opts);
  });
  const fault: Fault = { idempotencyAfterRefund: false, tripped: 0 };
  const store = f.db.withPlugin(faultPlugin(fault));
  const logs: string[] = [];
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('admin', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
        ADMIN_TOKEN_SIGNING_KEY: tokenKey.toString('base64url'),
        ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
        ADMIN_CORS_ORIGIN: 'https://admin.example.invalid',
        JWT_KEY_ID: 'b2_15e_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'trace' },
        {
          write: (line) => {
            logs.push(line);
          },
        },
      ),
      dbHandles: { db: store, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        DATABASE_READ_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: f.s.redisUrl(),
      }).redisUrl,
    });
    await app.init();
    const server = app;
    const caller: AdminHarness['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.subject.app_id,
          login_name: `refund_${id}`,
          password_hash: 'unused-test-login',
          is_super: options.superAdmin === true,
          status: 'active',
          password_must_change: false,
          totp_bound_at: f.clock.now(),
          created_at: f.clock.now(),
          updated_at: f.clock.now(),
        })
        .execute();
      if (permissions.length > 0) {
        await f.db
          .insertInto('admin_permissions')
          .values(
            permissions.map((permission_key) => ({
              app_id: f.subject.app_id,
              admin_id: id,
              permission_key,
              granted_by: id,
              granted_at: f.clock.now(),
            })),
          )
          .execute();
      }
      const { token, claims } = await createAdminTokens({ key: tokenKey, clock: f.clock }).issue({
        adminId: id,
        appId: f.subject.app_id,
      });
      await createAdminSessions({
        redis: server.get<RedisHandle>(REDIS).namespace('admin-auth'),
        clock: f.clock,
      }).create(claims.sessionId, {
        adminId: id,
        appId: f.subject.app_id,
        expiresAtMs: claims.expiresAt * 1000,
        lastSeenMs: f.clock.now().getTime(),
      });
      return { id, token };
    };
    const operator = await caller(['pay.refund']);
    await run({
      logs,
      fault,
      caller,
      operator,
      async refund(target, body, options = {}) {
        const who = options.caller === undefined ? operator : options.caller;
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-trace-id': randomUUID(),
        };
        if (who !== null) headers['authorization'] = `Bearer ${who.token}`;
        if (options.key !== null) headers['idempotency-key'] = options.key ?? newKey();
        const response = await server.inject({
          method: 'POST',
          url: refundPath(target),
          headers,
          payload: JSON.stringify(body),
          remoteAddress: '127.0.0.1',
        });
        return {
          statusCode: response.statusCode,
          body: response.body,
          template: refundTemplate(target),
          json: () => JSON.parse(response.body) as Envelope,
        };
      },
    });
  } finally {
    spy.mockRestore();
    try {
      await app?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

interface ContractResponse {
  readonly content?: Record<string, { readonly schema: JsonSchema }>;
}
type ContractPaths = Record<
  string,
  Record<string, { readonly responses: Record<string, ContractResponse> }>
>;
let contractPromise: Promise<ContractPaths> | undefined;

/** The dereferenced paths of contracts/openapi.yaml. */
function contractPaths(): Promise<ContractPaths> {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<{ paths: ContractPaths }>;
  };
  contractPromise ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    })
    .then((document) => document.paths);
  return contractPromise;
}

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10403: 403,
  20001: 400,
  20901: 409,
  20902: 409,
  40901: 409,
};

/** The response body conforms to the contract's schema of its operation and status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[sent.template]?.['post']?.responses[status]?.content?.[
    'application/json'
  ]?.schema;
  expect(schema, `${sent.template} ${status}`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(sent.body) as unknown;
  } catch {
    parsed = sent.body;
  }
  expect(check(parsed), `${sent.body} ${JSON.stringify(check.errors)}`).toBe(true);
}

/** Status, code and (when given) exact data, then the contract schema. */
export async function answer(sent: AdminSent, code: number, data?: unknown): Promise<Envelope> {
  expect(sent.statusCode, sent.body).toBe(HTTP_STATUS[code]);
  const body = sent.json();
  expect(body.code, sent.body).toBe(code);
  if (data !== undefined) expect(body.data, sent.body).toEqual(data);
  await conforms(sent);
  return body;
}

/** The data of a successful refund response. */
export async function created(sent: AdminSent): Promise<Record<string, unknown>> {
  const body = await answer(sent, 0);
  const data = body.data;
  expect(typeof data === 'object' && data !== null, sent.body).toBe(true);
  return data as Record<string, unknown>;
}

/** The request body of a refund. */
export function refundBody(
  amountFen: bigint | number,
  reason: (typeof REASONS)[number] = 'USER_REQUEST',
  note?: string,
): Record<string, unknown> {
  return {
    amount_fen: Number(amountFen),
    reason_code: reason,
    ...(note === undefined ? {} : { note }),
  };
}

// ---------------------------------------------------------------------------------------------
// Readers (plain SQL always names the schema).

export function refunds(f: Fixture): Promise<RefundRow[]> {
  return f.db
    .selectFrom('pay_refunds')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .orderBy('created_at')
    .orderBy('out_refund_no')
    .execute();
}

export async function refundRow(f: Fixture, id: string): Promise<RefundRow> {
  const row = await f.db
    .selectFrom('pay_refunds')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .where('id', '=', id)
    .executeTakeFirst();
  expect(row, `pay_refunds ${id}`).toBeDefined();
  return row!;
}

/**
 * pay_refunds.note of a refund (D10-350: written by the creating INSERT only; null without a note).
 * Plain SQL: the column comes with B2-15e's migration.
 */
export async function refundNote(f: Fixture, id: string): Promise<string | null> {
  const result = await sql<{ note: string | null }>`
    SELECT note FROM app.pay_refunds WHERE app_id = ${f.subject.app_id} AND id = ${id}`.execute(
    f.db,
  );
  expect(result.rows, `pay_refunds ${id}`).toHaveLength(1);
  return result.rows[0]!.note;
}

export async function anomalyRow(f: Fixture, id: string): Promise<AnomalyRow> {
  const row = await f.db
    .selectFrom('pay_anomalies')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .where('id', '=', id)
    .executeTakeFirst();
  expect(row, `pay_anomalies ${id}`).toBeDefined();
  return row!;
}

/** The channel requests kept for a refund (pay_query_attempts with its pay_refund_id). */
export function refundAttempts(f: Fixture, payRefundId: string) {
  return f.db
    .selectFrom('pay_query_attempts')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .where('pay_refund_id', '=', payRefundId)
    .orderBy('at')
    .orderBy('created_at')
    .execute();
}

/** The refund audit records of the app. */
export function refundAudits(f: Fixture) {
  return f.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .where('action', '=', AUDIT_ACTION)
    .orderBy('id')
    .execute();
}

/** The idempotency records of the app. */
export function idempotencyRows(f: Fixture) {
  return f.db
    .selectFrom('idempotency_keys')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .orderBy('id')
    .execute();
}

/** The pay_refund.succeeded events of the app (event_log payload {v, data}). */
export async function refundEvents(f: Fixture): Promise<Record<string, unknown>[]> {
  const result = await sql<{ data: Record<string, unknown> }>`
    SELECT payload->'data' AS data FROM app.event_log
    WHERE app_id = ${f.subject.app_id} AND name = ${REFUND_EVENT}
    ORDER BY occurred_at, id`.execute(f.db);
  return result.rows.map((row) => row.data);
}

/** The balance of a platform subject of the app: Σ of its signed entries. */
export async function subjectBalance(f: Fixture, subject: string): Promise<bigint> {
  const result = await sql<{ total: string | null }>`
    SELECT sum(e.amount_fen)::text AS total
    FROM app.ledger_entries e JOIN app.ledger_accounts a ON a.id = e.account_id
    WHERE e.app_id = ${f.subject.app_id} AND a.owner_type = 'platform'
      AND a.subject = ${subject}`.execute(f.db);
  return BigInt(result.rows[0]?.total ?? '0');
}

/** pay_notifications rows of the app that name an out_refund_no. */
export function refundNotifications(f: Fixture, outRefundNo: string) {
  return f.db
    .selectFrom('pay_notifications')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .where('out_refund_no', '=', outRefundNo)
    .orderBy('received_at')
    .orderBy('created_at')
    .execute();
}

/** The entries of a voucher view without its biz reference (left to the implementation). */
export function voucherShape(voucher: {
  readonly uniq_key: string;
  readonly voucher_kind: string | null;
  readonly entries: readonly unknown[];
}) {
  return {
    uniq_key: voucher.uniq_key,
    voucher_kind: voucher.voucher_kind,
    entries: voucher.entries,
  };
}

/** The PAY_REFUND voucher of a refund of a pay order (specs/ledger-rules.md §10). */
export function refundVoucherOf(order: OrderRow, refund: RefundRow) {
  return {
    uniq_key: `PAY_REFUND:${refund.id}`,
    voucher_kind: 'PAY_REFUND',
    entries: [
      {
        owner_type: 'platform',
        subject: `PAY_RECEIPTS:${order.biz_type}`,
        amount: String(refund.amount_fen),
        ledger_type: 'PAY_REFUND',
      },
      {
        owner_type: 'platform',
        subject: `CASH_PAY:${order.pay_channel}`,
        amount: String(-refund.amount_fen),
        ledger_type: 'PAY_REFUND',
      },
    ],
  };
}

/** The entries of the reverse PAY_ANOMALY voucher of a refund of an anomaly receipt. */
export function reverseAnomalyEntries(anomaly: AnomalyRow, refund: RefundRow) {
  return [
    {
      owner_type: 'platform',
      subject: 'PAY_SUSPENSE',
      amount: String(refund.amount_fen),
      ledger_type: 'PAY_ANOMALY',
    },
    {
      owner_type: 'platform',
      subject: `CASH_PAY:${anomaly.pay_channel}`,
      amount: String(-refund.amount_fen),
      ledger_type: 'PAY_ANOMALY',
    },
  ];
}
