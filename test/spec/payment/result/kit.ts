// B2-15c rule-test kit (claude-independent, SPEC_REF ec81e625; 08 BR-PAY-04 and 细则「通知应答」,
// BR-PAY-05 ④, BR-PAY-07; task §9 / §10).
// Real pieces: the api entry (createHttpApp with its real request checks, Redis, PostgreSQL
// through @couli/db/testing as couli_app, a local field keyring), ledger's posting and recon diff
// registration, pgboss and event_log. Synthetic: the two channels. SpecPayChannel signs its own
// notifications with keys of its own (an HMAC in place of the channel signature, AES-256-GCM over
// the WeChat resource as in APIv3) and verifies them; the field names follow the official
// notification formats (WeChat APIv3 支付通知, Alipay 异步通知), not a real merchant or payer.
// Missing pieces fail as assertions (the notification route answers 404) or as NotImplemented.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import {
  createBizRegistry,
  type BizTypeRegistry,
} from '../../../../apps/api/src/modules/payment/application/biz-registry.ts';
import {
  PayChannelSet,
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
  type PayRefundQueryResult,
  type PayRefundResult,
  type PayTradeState,
} from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import { FakePayChannel } from '../../../../apps/api/src/modules/payment/infra/channels/fake-pay-channel.ts';
import {
  EVENT_BUS,
  JOB_QUEUE,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type DomainEvent,
  type EventBus,
  type FixedClock,
  type JobHandler,
  type JobPayload,
  type JobQueue,
  type ReceivedJob,
  type RootLogger,
  type SendOptions,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type * as Crypto from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { BIZ, seedOrder, type Fixture, type OrderRow } from '../orders/kit.ts';

export const CHANNELS = ['wechat_pay', 'alipay'] as const;
/** The notification entries (08 BR-PAY-04; specs/pay-notify.md §1). */
export const ROUTE: Record<PayChannelCode, string> = {
  wechat_pay: '/notify/pay/wechat',
  alipay: '/notify/pay/alipay',
};
/** The default success state of each channel (BR-PAY-04 细则: documented, 待实测). */
export const SUCCESS: Record<PayChannelCode, string> = {
  wechat_pay: 'SUCCESS',
  alipay: 'TRADE_SUCCESS',
};
/** A documented «not paid yet» state of each channel. */
export const NOT_PAID: Record<PayChannelCode, string> = {
  wechat_pay: 'NOTPAY',
  alipay: 'WAIT_BUYER_PAY',
};
/** The amount of the seeded orders: not the test type's 1 fen, so the stored amount is compared. */
export const AMOUNT = 12_345n;

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

// ---------------------------------------------------------------------------------------------
// Synthetic channel.

function digits(n: number): string {
  return Array.from(randomBytes(n), (byte) => String(byte % 10)).join('');
}

/** A fresh merchant / application identity of the channel's shape (never a real one). */
export function newIdentity(channel: PayChannelCode): PayChannelIdentity {
  return channel === 'wechat_pay'
    ? { merchantRef: `16${digits(8)}`, appRef: `wx${randomBytes(8).toString('hex')}` }
    : { merchantRef: `2088${digits(12)}`, appRef: `2021${digits(12)}` };
}

function identityKey(identity: PayChannelIdentity): string {
  return JSON.stringify([identity.merchantRef, identity.appRef]);
}

function hmac(key: Buffer, text: string): string {
  return createHmac('sha256', key).update(text, 'utf8').digest('base64');
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

function header(raw: PayRawNotification, name: string): string {
  for (const [key, value] of Object.entries(raw.headers)) {
    if (key.toLowerCase() === name) return String(value);
  }
  throw new Error(`spec channel: header ${name} missing`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`spec channel: ${name}`);
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`spec channel: ${name}`);
  }
  return value as Record<string, unknown>;
}

/** Fen as yuan text with two decimals (Alipay total_amount), integer arithmetic only. */
export function yuanText(fen: bigint): string {
  return `${fen / 100n}.${String(fen % 100n).padStart(2, '0')}`;
}

function fenOfYuan(value: string): bigint {
  const match = /^(\d+)\.(\d{2})$/.exec(value);
  if (match === null) throw new Error('spec channel: total_amount');
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

export interface NotificationInput {
  readonly identity: PayChannelIdentity;
  readonly outTradeNo: string;
  readonly amountFen: bigint;
  readonly state: string;
  readonly channelTradeNo: string;
  /** A fresh one by default. */
  readonly notifyId?: string;
}

export interface Built {
  readonly raw: PayRawNotification;
  readonly notifyId: string;
  /** Pieces of the original that must never reach a log line, a response or a plain column. */
  readonly secrets: readonly string[];
}

/** What query sees for an out_trade_no; identity null leaves merchantRef / appRef out. */
export interface SpecTrade {
  readonly state: PayTradeState;
  readonly channelState: string;
  readonly amountFen: bigint | null;
  readonly channelTradeNo: string | null;
  readonly identity: PayChannelIdentity | null;
}

export class SpecPayChannel implements PayChannel {
  readonly channel: PayChannelCode;
  /** Every notification handed to verifyNotification, in order. */
  readonly verified: PayRawNotification[] = [];
  /** Every out_trade_no handed to query, in order. */
  readonly queried: string[] = [];
  readonly #fake: FakePayChannel;
  readonly #signKey = randomBytes(32);
  readonly #aesKey = randomBytes(32);
  readonly #serial = randomBytes(8).toString('hex').toUpperCase();
  readonly #owners = new Map<string, string>();
  readonly #trades = new Map<string, SpecTrade | 'timeout'>();

  constructor(channel: PayChannelCode) {
    this.channel = channel;
    this.#fake = new FakePayChannel(channel);
  }

  /** Registers a fresh identity as the given app's (the channel configuration of that app). */
  own(appId: string): PayChannelIdentity {
    const identity = newIdentity(this.channel);
    this.#owners.set(identityKey(identity), appId);
    return identity;
  }

  ownerAppOf(identity: PayChannelIdentity): string | null {
    return this.#owners.get(identityKey(identity)) ?? null;
  }

  setTrade(outTradeNo: string, trade: SpecTrade | 'timeout'): void {
    this.#trades.set(outTradeNo, trade);
  }

  /** A paid trade of the channel's success state, unless another state is given. */
  paid(
    identity: PayChannelIdentity,
    amountFen: bigint,
    channelTradeNo: string,
    channelState = SUCCESS[this.channel],
  ): SpecTrade {
    return { state: 'paid', channelState, amountFen, channelTradeNo, identity };
  }

  createOrder(input: PayCreateOrderInput): Promise<PayCreateOrderResult> {
    return this.#fake.createOrder(input);
  }

  query(outTradeNo: string): Promise<PayQueryResult> {
    this.queried.push(outTradeNo);
    const trade = this.#trades.get(outTradeNo);
    if (trade === undefined) {
      return Promise.resolve({
        kind: 'ok',
        state: 'not_exist',
        channelTradeNo: null,
        amountFen: null,
      });
    }
    if (trade === 'timeout') return Promise.resolve({ kind: 'unknown', reason: 'spec_timeout' });
    return Promise.resolve({
      kind: 'ok',
      state: trade.state,
      channelTradeNo: trade.channelTradeNo,
      amountFen: trade.amountFen,
      channelState: trade.channelState,
      ...(trade.identity === null
        ? {}
        : { merchantRef: trade.identity.merchantRef, appRef: trade.identity.appRef }),
    });
  }

  close(outTradeNo: string): Promise<PayCloseResult> {
    return this.#fake.close(outTradeNo);
  }

  refund(input: PayRefundInput): Promise<PayRefundResult> {
    return this.#fake.refund(input);
  }

  refundQuery(outRefundNo: string): Promise<PayRefundQueryResult> {
    return this.#fake.refundQuery(outRefundNo);
  }

  downloadBill(date: string): Promise<PayBillResult> {
    return this.#fake.downloadBill(date);
  }

  /** A signed notification of this channel's format. */
  notification(input: NotificationInput): Built {
    const notifyId = input.notifyId ?? `N${randomBytes(12).toString('hex')}`;
    return this.channel === 'wechat_pay'
      ? this.#wechat(input, notifyId)
      : this.#alipay(input, notifyId);
  }

  /** The same notification with its body changed after signing (the signature no longer holds). */
  alterBody(built: Built): PayRawNotification {
    if (this.channel === 'wechat_pay') {
      const body = record(JSON.parse(built.raw.body), 'body');
      body['create_time'] = '2026-10-22T09:30:00+08:00';
      return { headers: built.raw.headers, body: JSON.stringify(body) };
    }
    const params = new URLSearchParams(built.raw.body);
    params.set('total_amount', '0.01');
    return { headers: built.raw.headers, body: params.toString() };
  }

  /** The same notification signed by someone else's key. */
  forgeSignature(built: Built): PayRawNotification {
    const other = randomBytes(32);
    if (this.channel === 'wechat_pay') {
      const timestamp = header(built.raw, 'wechatpay-timestamp');
      const nonce = header(built.raw, 'wechatpay-nonce');
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

  verifyNotification(raw: PayRawNotification): Promise<PayNotificationResult> {
    this.verified.push(raw);
    try {
      return Promise.resolve(
        this.channel === 'wechat_pay' ? this.#verifyWechat(raw) : this.#verifyAlipay(raw),
      );
    } catch {
      return Promise.resolve({ kind: 'rejected', reason: 'spec_unreadable' });
    }
  }

  #wechat(input: NotificationInput, notifyId: string): Built {
    const openid = `o${randomBytes(14).toString('base64url')}`;
    const resource = {
      mchid: input.identity.merchantRef,
      appid: input.identity.appRef,
      out_trade_no: input.outTradeNo,
      transaction_id: input.channelTradeNo,
      trade_type: 'APP',
      trade_state: input.state,
      trade_state_desc: 'synthetic',
      bank_type: 'OTHERS',
      attach: '',
      success_time: '2026-10-22T09:00:00+08:00',
      payer: { openid },
      amount: {
        total: Number(input.amountFen),
        payer_total: Number(input.amountFen),
        currency: 'CNY',
        payer_currency: 'CNY',
      },
    };
    const nonce = randomBytes(6).toString('hex');
    const aad = 'transaction';
    const cipher = createCipheriv('aes-256-gcm', this.#aesKey, Buffer.from(nonce, 'utf8'));
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(resource), 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64');
    const body = JSON.stringify({
      id: notifyId,
      create_time: '2026-10-22T09:00:01+08:00',
      resource_type: 'encrypt-resource',
      event_type: 'TRANSACTION.SUCCESS',
      summary: 'synthetic',
      resource: {
        original_type: 'transaction',
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext,
        associated_data: aad,
        nonce,
      },
    });
    const timestamp = '1792630801';
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
      secrets: [openid, ciphertext, signature, headerNonce],
    };
  }

  #verifyWechat(raw: PayRawNotification): PayNotificationResult {
    const timestamp = header(raw, 'wechatpay-timestamp');
    const nonce = header(raw, 'wechatpay-nonce');
    const signature = header(raw, 'wechatpay-signature');
    if (!same(signature, hmac(this.#signKey, `${timestamp}\n${nonce}\n${raw.body}\n`))) {
      return { kind: 'rejected', reason: 'spec_signature' };
    }
    const body = record(JSON.parse(raw.body), 'body');
    const resource = record(body['resource'], 'resource');
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
    const transaction = record(JSON.parse(plain), 'transaction');
    const amount = record(transaction['amount'], 'amount');
    const total = amount['total'];
    if (typeof total !== 'number' || !Number.isSafeInteger(total)) throw new Error('total');
    return {
      kind: 'ok',
      notifyId: text(body['id'], 'id'),
      outTradeNo: text(transaction['out_trade_no'], 'out_trade_no'),
      outRefundNo: null,
      channelTradeNo: text(transaction['transaction_id'], 'transaction_id'),
      amountFen: BigInt(total),
      state: text(transaction['trade_state'], 'trade_state'),
      merchantRef: text(transaction['mchid'], 'mchid'),
      appRef: text(transaction['appid'], 'appid'),
    };
  }

  #alipay(input: NotificationInput, notifyId: string): Built {
    const yuan = yuanText(input.amountFen);
    const buyerId = `2088${digits(12)}`;
    const buyerLogon = `payer${digits(6)}@example.invalid`;
    const params: [string, string][] = [
      ['gmt_create', '2026-10-22 09:00:00'],
      ['charset', 'utf-8'],
      ['seller_email', 'merchant@example.invalid'],
      ['subject', 'synthetic'],
      ['buyer_id', buyerId],
      ['invoice_amount', yuan],
      ['notify_id', notifyId],
      ['notify_type', 'trade_status_sync'],
      ['trade_status', input.state],
      ['receipt_amount', yuan],
      ['app_id', input.identity.appRef],
      ['buyer_pay_amount', yuan],
      ['gmt_payment', '2026-10-22 09:00:01'],
      ['notify_time', '2026-10-22 09:00:02'],
      ['version', '1.0'],
      ['out_trade_no', input.outTradeNo],
      ['total_amount', yuan],
      ['trade_no', input.channelTradeNo],
      ['auth_app_id', input.identity.appRef],
      ['buyer_logon_id', buyerLogon],
      ['point_amount', '0.00'],
      ['seller_id', input.identity.merchantRef],
    ];
    const sign = hmac(this.#signKey, signingText(params));
    const form = new URLSearchParams([...params, ['sign', sign], ['sign_type', 'RSA2']]);
    return {
      notifyId,
      raw: {
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: form.toString(),
      },
      secrets: [
        buyerId,
        buyerLogon,
        encodeURIComponent(buyerLogon),
        sign,
        encodeURIComponent(sign),
      ],
    };
  }

  #verifyAlipay(raw: PayRawNotification): PayNotificationResult {
    const params = new URLSearchParams(raw.body);
    const sign = params.get('sign') ?? '';
    if (!same(sign, hmac(this.#signKey, signingText(params.entries())))) {
      return { kind: 'rejected', reason: 'spec_signature' };
    }
    const need = (name: string): string => text(params.get(name), name);
    return {
      kind: 'ok',
      notifyId: need('notify_id'),
      outTradeNo: need('out_trade_no'),
      outRefundNo: null,
      channelTradeNo: need('trade_no'),
      amountFen: fenOfYuan(need('total_amount')),
      state: need('trade_status'),
      merchantRef: need('seller_id'),
      appRef: need('app_id'),
    };
  }
}

export type SpecChannels = Record<PayChannelCode, SpecPayChannel>;

/** Both channels, each with an identity registered as the fixture app's. */
export function specChannels(f: Fixture): {
  channels: SpecChannels;
  identity: Record<PayChannelCode, PayChannelIdentity>;
} {
  const channels: SpecChannels = {
    wechat_pay: new SpecPayChannel('wechat_pay'),
    alipay: new SpecPayChannel('alipay'),
  };
  return {
    channels,
    identity: {
      wechat_pay: channels.wechat_pay.own(f.subject.app_id),
      alipay: channels.alipay.own(f.subject.app_id),
    },
  };
}

/** A fresh channel trade number of the channel's look. */
export function tradeNo(channel: PayChannelCode): string {
  return channel === 'wechat_pay' ? `4200${digits(24)}` : `2026102222001${digits(15)}`;
}

/** A PENDING order of the test type on the channel, launch issued, amount AMOUNT unless given. */
export function seedPending(
  f: Fixture,
  channel: PayChannelCode,
  patch: Parameters<typeof seedOrder>[1] = {},
): Promise<OrderRow> {
  return seedOrder(f, {
    pay_channel: channel,
    amount_fen: AMOUNT,
    launch_issued_at: f.clock.now(),
    ...patch,
  });
}

/** The success notification of an order as the channel would send it. */
export function paidNotification(
  channels: SpecChannels,
  identity: PayChannelIdentity,
  order: OrderRow,
  patch: Partial<NotificationInput> = {},
): Built {
  const channel = order.pay_channel as PayChannelCode;
  return channels[channel].notification({
    identity,
    outTradeNo: order.out_trade_no,
    amountFen: order.amount_fen,
    state: SUCCESS[channel],
    channelTradeNo: tradeNo(channel),
    ...patch,
  });
}

// ---------------------------------------------------------------------------------------------
// The api entry with the notification routes.

export interface Delivery {
  readonly statusCode: number;
  readonly body: string;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'POST';
    url: string;
    payload: string;
    headers: Record<string, string>;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}
interface Builder {
  overrideProvider(token: unknown): { useValue(value: unknown): Builder };
  compile(): Promise<{ createNestApplication(adapter: unknown, options: unknown): HttpApp }>;
}

export interface NotifyHarness {
  /** POST of the raw notification to the channel's route, from a fresh client address. */
  deliver(channel: PayChannelCode, raw: PayRawNotification): Promise<Delivery>;
  /** Every pino line of the entry. */
  readonly logs: string[];
  /** The entry's started job queue and event bus (for jobs run next to it). */
  readonly queue: JobQueue;
  readonly events: EventBus;
}

function clientAddress(): string {
  const [a, b] = randomBytes(2);
  return `198.18.${a ?? 0}.${b ?? 1}`;
}

/**
 * Runs `run` against a started api entry on the fixture's database and clock, with the spec
 * channels in place of the process's channel set. The request checks are the entry's own: the
 * notification routes carry no token, no signature headers and no X-App-Id.
 */
export async function withNotify(
  f: Fixture,
  channels: SpecChannels,
  run: (h: NotifyHarness) => Promise<void>,
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
      entry: 'api',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: RootLogger;
        dbHandles: DbHandles;
        redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const cryptoModule = (await import(
    new URL('apps/api/src/modules/platform/crypto/index.ts', ROOT).href
  )) as typeof Crypto;
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b2-15c-'));
  const master = randomBytes(32);
  const keyring = await cryptoModule.createWrappedKeyring(
    new cryptoModule.LocalKeyProvider(master),
  );
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const set = { of: (channel: PayChannelCode) => channels[channel] };
  const spy = vi.spyOn(NestFactory, 'create').mockImplementation(async (module, adapter, opts) => {
    const builder = Test.createTestingModule({ imports: [module] });
    builder.overrideProvider(PayChannelSet).useValue(set);
    return (await builder.compile()).createNestApplication(adapter, opts);
  });
  const logs: string[] = [];
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('api', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'api', appEnv: 'test', level: 'trace' },
        {
          write: (line) => {
            logs.push(line);
          },
        },
      ),
      dbHandles: { db: f.db, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('api', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: f.s.redisUrl(),
      }).redisUrl,
    });
    await app.init();
    const server = app;
    await run({
      async deliver(channel, raw) {
        const response = await server.inject({
          method: 'POST',
          url: ROUTE[channel],
          headers: { ...raw.headers },
          payload: raw.body,
          remoteAddress: clientAddress(),
        });
        return { statusCode: response.statusCode, body: response.body };
      },
      logs,
      queue: server.get<JobQueue>(JOB_QUEUE),
      events: server.get<EventBus>(EVENT_BUS),
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

function json(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** «应答成功» in the channel's format (WeChat: 200 / 204; Alipay: the text success). */
export function acked(channel: PayChannelCode, sent: Delivery): void {
  if (channel === 'wechat_pay') {
    expect([200, 204], `${sent.statusCode} ${sent.body}`).toContain(sent.statusCode);
    if (sent.body !== '') expect(json(sent.body), sent.body).toMatchObject({ code: 'SUCCESS' });
    return;
  }
  expect(sent.statusCode, sent.body).toBe(200);
  expect(sent.body).toBe('success');
}

/** «不应答成功» in the channel's format, with nothing of the business in it. */
export function nacked(channel: PayChannelCode, sent: Delivery): void {
  if (channel === 'wechat_pay') {
    expect(sent.statusCode, sent.body).toBeGreaterThanOrEqual(400);
    const body = json(sent.body);
    expect(typeof body === 'object' && body !== null ? Object.keys(body).sort() : body).toEqual([
      'code',
      'message',
    ]);
    const { code, message } = body as { code: unknown; message: unknown };
    expect(typeof code).toBe('string');
    expect(code).not.toBe('SUCCESS');
    expect(typeof message).toBe('string');
    return;
  }
  expect(sent.body).toBe('failure');
}

// ---------------------------------------------------------------------------------------------
// The pay queue's handler, built in the test over the fixture's database (worker side).

export interface SentJob {
  readonly queue: string;
  readonly name: string;
  readonly payload: JobPayload;
  readonly options: SendOptions;
  /** The send ran on a business transaction (same-transaction enqueue). */
  readonly inTransaction: boolean;
}

export interface Published {
  readonly event: DomainEvent;
  readonly inTransaction: boolean;
}

/** The deps shape of createPayJobHandler (apps/api/src/modules/payment/jobs/pay-jobs.ts). */
export interface JobDeps {
  readonly db: Fixture['db'];
  readonly clock: FixedClock;
  readonly config: {
    configValue(
      appId: string,
      key: string,
    ): Promise<{ readonly value: unknown; readonly version: number } | null>;
  };
  readonly queue: JobQueue;
  readonly events: EventBus;
  readonly channels: { of(channel: PayChannelCode): PayChannel };
  readonly registry: BizTypeRegistry;
  readonly ledger: {
    post(trx: Transaction<DB>, voucher: unknown): Promise<unknown>;
    registerReconDiff(trx: Transaction<DB>, input: unknown): Promise<{ readonly id: string }>;
  };
  readonly logger: RootLogger;
}

export interface JobKit {
  readonly deps: JobDeps;
  readonly sent: SentJob[];
  readonly published: Published[];
  readonly logs: string[];
}

interface LedgerRuntime {
  createLedger(input: { readonly clock: FixedClock }): {
    post(trx: Transaction<DB>, voucher: unknown): Promise<unknown>;
  };
  registerReconDiff(
    trx: Transaction<DB>,
    input: unknown,
    deps: { readonly clock: FixedClock },
  ): Promise<{ readonly id: string }>;
}

/**
 * The handler's dependencies: a recording queue and event bus (passing on to `queue` / `events`
 * when given, else answering synthetic ids), ledger's real posting, config_items read fresh.
 */
export async function jobKit(
  f: Fixture,
  channels: SpecChannels,
  options: { queue?: JobQueue; events?: EventBus; registry?: BizTypeRegistry } = {},
): Promise<JobKit> {
  const ledger = (await import(
    new URL('apps/api/src/modules/ledger/index.ts', ROOT).href
  )) as LedgerRuntime;
  const posting = ledger.createLedger({ clock: f.clock });
  const sent: SentJob[] = [];
  const published: Published[] = [];
  const logs: string[] = [];
  const inner = options.queue;
  const bus = options.events;
  const deps: JobDeps = {
    db: f.db,
    clock: f.clock,
    config: {
      async configValue(appId, key) {
        const result = await sql<{ value: unknown; version: number }>`
          SELECT value, version FROM app.config_items WHERE app_id = ${appId} AND key = ${key}`.execute(
          f.db,
        );
        const row = result.rows[0];
        return row === undefined ? null : { value: row.value, version: row.version };
      },
    },
    queue: {
      async send(queue: string, name: string, payload: JobPayload, sendOptions: SendOptions) {
        sent.push({
          queue,
          name,
          payload,
          options: sendOptions,
          inTransaction: sendOptions.trx !== null && sendOptions.trx.isTransaction,
        });
        return inner === undefined ? randomUUID() : inner.send(queue, name, payload, sendOptions);
      },
    },
    events: {
      async publish(trx, event) {
        published.push({ event, inTransaction: trx.isTransaction });
        return bus === undefined
          ? { eventId: randomUUID(), duplicate: false }
          : bus.publish(trx, event);
      },
    },
    channels: { of: (channel) => channels[channel] },
    registry: options.registry ?? createBizRegistry('test'),
    ledger: {
      post: (trx, voucher) => posting.post(trx, voucher),
      registerReconDiff: (trx, input) => ledger.registerReconDiff(trx, input, { clock: f.clock }),
    },
    logger: createRootLogger(
      { entry: 'worker', appEnv: 'test', level: 'trace' },
      {
        write: (line) => {
          logs.push(line);
        },
      },
    ),
  };
  return { deps, sent, published, logs };
}

/** createPayJobHandler over the kit (built inside the test: the skeleton throws NotImplemented). */
export async function payJobHandler(kit: JobKit): Promise<JobHandler> {
  const module = (await import(
    new URL('apps/api/src/modules/payment/jobs/pay-jobs.ts', ROOT).href
  )) as { createPayJobHandler(deps: JobDeps): JobHandler };
  return module.createPayJobHandler(kit.deps);
}

/** The client-return query job of B2-15b (payload as payOrderReturned enqueues it). */
export function returnedQuery(order: OrderRow): ReceivedJob {
  return received('order.query', {
    app_id: order.app_id,
    pay_order_id: order.id,
    trigger: 'returned',
  });
}

export function received(name: string, payload: JobPayload): ReceivedJob {
  return { id: randomUUID(), queue: 'pay', name, payload, attempt: 1 };
}

/** The recorded sends of one job name. */
export function sends(kit: JobKit, name: string): SentJob[] {
  return kit.sent.filter((job) => job.name === name);
}

// ---------------------------------------------------------------------------------------------
// Readers (plain SQL always names the schema).

export interface EntryView {
  readonly owner_type: string;
  readonly subject: string;
  readonly amount: string;
  readonly ledger_type: string;
}
export interface VoucherView {
  readonly uniq_key: string;
  readonly voucher_kind: string | null;
  readonly biz_id: string;
  readonly entries: EntryView[];
}

/** Every voucher of the app with its entries (debit first), in booking order. */
export async function vouchers(f: Fixture): Promise<VoucherView[]> {
  const result = await sql<{
    voucher_id: string;
    uniq_key: string;
    voucher_kind: string | null;
    biz_id: string;
    owner_type: string;
    subject: string;
    amount: string;
    ledger_type: string;
  }>`
    SELECT v.id::text AS voucher_id, v.uniq_key, v.voucher_kind, v.biz_id, a.owner_type, a.subject,
      e.amount_fen::text AS amount, e.ledger_type
    FROM app.ledger_vouchers v
    JOIN app.ledger_entries e ON e.app_id = v.app_id AND e.voucher_id = v.id
    JOIN app.ledger_accounts a ON a.id = e.account_id
    WHERE v.app_id = ${f.subject.app_id}
    ORDER BY v.created_at, v.id, e.amount_fen DESC`.execute(f.db);
  const byId = new Map<string, VoucherView>();
  for (const row of result.rows) {
    let voucher = byId.get(row.voucher_id);
    if (voucher === undefined) {
      voucher = {
        uniq_key: row.uniq_key,
        voucher_kind: row.voucher_kind,
        biz_id: row.biz_id,
        entries: [],
      };
      byId.set(row.voucher_id, voucher);
    }
    voucher.entries.push({
      owner_type: row.owner_type,
      subject: row.subject,
      amount: row.amount,
      ledger_type: row.ledger_type,
    });
  }
  return [...byId.values()];
}

/** The PAY_RECEIPT voucher of an order (BR-PAY-07: 借 CASH_PAY:{pay_channel} / 贷 PAY_RECEIPTS:{biz_type}). */
export function receiptOf(order: OrderRow): VoucherView {
  return {
    uniq_key: `PAY_RECEIPT:${order.id}`,
    voucher_kind: 'PAY_RECEIPT',
    biz_id: order.id,
    entries: [
      {
        owner_type: 'platform',
        subject: `CASH_PAY:${order.pay_channel}`,
        amount: String(order.amount_fen),
        ledger_type: 'PAY_RECEIPT',
      },
      {
        owner_type: 'platform',
        subject: `PAY_RECEIPTS:${order.biz_type}`,
        amount: String(-order.amount_fen),
        ledger_type: 'PAY_RECEIPT',
      },
    ],
  };
}

/** The PAY_ANOMALY voucher of an anomaly receipt (借 CASH_PAY:{pay_channel} / 贷 PAY_SUSPENSE). */
export function anomalyVoucherOf(anomaly: {
  readonly id: string;
  readonly pay_channel: string;
  readonly amount_fen: bigint;
}): VoucherView {
  return {
    uniq_key: `PAY_ANOMALY:${anomaly.id}`,
    voucher_kind: 'PAY_ANOMALY',
    biz_id: anomaly.id,
    entries: [
      {
        owner_type: 'platform',
        subject: `CASH_PAY:${anomaly.pay_channel}`,
        amount: String(anomaly.amount_fen),
        ledger_type: 'PAY_ANOMALY',
      },
      {
        owner_type: 'platform',
        subject: 'PAY_SUSPENSE',
        amount: String(-anomaly.amount_fen),
        ledger_type: 'PAY_ANOMALY',
      },
    ],
  };
}

/** User-side ledger traces of the app: accounts, balances and entries off the platform side. */
export async function userTraces(f: Fixture) {
  const result = await sql<{ user_accounts: number; balances: number; user_entries: number }>`
    SELECT
      (SELECT count(*)::int FROM app.ledger_accounts
        WHERE app_id = ${f.subject.app_id} AND owner_type <> 'platform') AS user_accounts,
      (SELECT count(*)::int FROM app.account_balances WHERE app_id = ${f.subject.app_id}) AS balances,
      (SELECT count(*)::int FROM app.ledger_entries e JOIN app.ledger_accounts a ON a.id = e.account_id
        WHERE e.app_id = ${f.subject.app_id}
          AND (a.owner_type <> 'platform' OR a.subject = 'USER_BALANCE')) AS user_entries`.execute(
    f.db,
  );
  return result.rows[0];
}

export function notifications(f: Fixture) {
  return f.db
    .selectFrom('pay_notifications')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .orderBy('received_at')
    .orderBy('created_at')
    .execute();
}

/** pay_notifications rows of a notification id in any app. */
export async function notificationsAnywhere(notifyId: string, f: Fixture): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM app.pay_notifications WHERE notify_id = ${notifyId}`.execute(
    f.db,
  );
  return result.rows[0]?.n ?? -1;
}

/** pay_anomalies rows of a channel trade number in any app. */
export async function anomaliesAnywhere(channelTradeNo: string, f: Fixture): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM app.pay_anomalies WHERE channel_trade_no = ${channelTradeNo}`.execute(
    f.db,
  );
  return result.rows[0]?.n ?? -1;
}

export function anomalies(f: Fixture) {
  return f.db
    .selectFrom('pay_anomalies')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .orderBy('created_at')
    .execute();
}

export function reconDiffs(f: Fixture) {
  return f.db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .orderBy('created_at')
    .execute();
}

export function fulfillments(f: Fixture) {
  return f.db
    .selectFrom('pay_fulfillments')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .orderBy('created_at')
    .execute();
}

export function attemptsOf(f: Fixture, payOrderId: string) {
  return f.db
    .selectFrom('pay_query_attempts')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .where('pay_order_id', '=', payOrderId)
    .orderBy('at')
    .orderBy('created_at')
    .execute();
}

export interface QueuedJob {
  readonly job: string | null;
  readonly singleton_key: string | null;
  readonly delay: number;
  readonly payload: JobPayload | null;
}

/** Jobs of queue `pay` whose data mentions `text` (pgboss.job). */
export async function queued(f: Fixture, mention: string): Promise<QueuedJob[]> {
  const result = await sql<QueuedJob>`
    SELECT data->>'name' AS job, singleton_key, data->'payload' AS payload,
      extract(epoch FROM (start_after - created_on))::float8 AS delay
    FROM pgboss.job WHERE name = 'pay' AND data::text LIKE ${`%${mention}%`}
    ORDER BY created_on, id`.execute(f.db);
  return result.rows;
}

/** Jobs of queue `pay` by singleton key prefix (pgboss.job). */
export async function queuedByKey(f: Fixture, prefix: string): Promise<QueuedJob[]> {
  const result = await sql<QueuedJob>`
    SELECT data->>'name' AS job, singleton_key, data->'payload' AS payload,
      extract(epoch FROM (start_after - created_on))::float8 AS delay
    FROM pgboss.job WHERE name = 'pay' AND starts_with(singleton_key, ${prefix})
    ORDER BY created_on, id`.execute(f.db);
  return result.rows;
}

/** The pay_order.paid events of the app (event_log payload {v, data}). */
export async function paidEvents(f: Fixture): Promise<Record<string, unknown>[]> {
  const result = await sql<{ data: Record<string, unknown> }>`
    SELECT payload->'data' AS data FROM app.event_log
    WHERE app_id = ${f.subject.app_id} AND name = 'pay_order.paid'
    ORDER BY occurred_at, id`.execute(f.db);
  return result.rows.map((row) => row.data);
}

/** Parsed pino lines at warn level or above whose msg is `msg`. */
export function warnings(logs: readonly string[], msg: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of logs) {
    const parsed = json(line);
    if (typeof parsed !== 'object' || parsed === null) continue;
    const entry = parsed as Record<string, unknown>;
    const level = entry['level'];
    if (typeof level === 'number' && level >= 40 && entry['msg'] === msg) out.push(entry);
  }
  return out;
}

/** Raw pino lines at warn level or above that mention any of the values. */
export function alertsMentioning(logs: readonly string[], values: readonly string[]): string[] {
  return logs.filter((line) => {
    const parsed = json(line);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const level = (parsed as Record<string, unknown>)['level'];
    return typeof level === 'number' && level >= 40 && values.some((v) => line.includes(v));
  });
}

/** The fields of an order a notification or query must not touch when nothing moves. */
export function untouched(order: OrderRow) {
  return {
    id: order.id,
    status: order.status,
    paid_at: order.paid_at,
    closed_at: order.closed_at,
    channel_trade_no: order.channel_trade_no,
    amount_fen: order.amount_fen,
    refunded_fen: order.refunded_fen,
    closing: order.closing,
  };
}

export { BIZ };
