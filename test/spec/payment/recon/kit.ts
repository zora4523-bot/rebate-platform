// B2-15j rule-test kit (claude-independent, SPEC_REF 736d24c5; 08 BR-PAY-07 账务隔离与对账 and 细则,
// BR-PAY-05 ④ 异常收款; specs/ledger-rules.md 第 10 节 (PAY_ANOMALY, PAY_FEE:{pay_channel}:{bill_date});
// contracts/openapi.yaml listAdminPayReconDiffs (pay.view, source R4, type pay_mismatch /
// pay_anomaly, filters type / status, created_at descending, page_size ≤ 200)).
// Real pieces: the reconciliation use case (apps/api/src/modules/payment/application/pay-recon.ts)
// over the deps the pay queue's handler gets (../result/kit.ts jobKit: ledger's real posting and
// recon diff registration, config_items read fresh), PostgreSQL through @couli/db/testing as
// couli_app, the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// contract validation). Synthetic: the channel bill. BillChannel extends B2-15c's SpecPayChannel
// with downloadBill answering a scripted bill per date, in the normalised line shape of
// pay-recon.ts PayBillRow (the adapters map the channels' own bill columns; WeChat 交易账单 /
// Alipay 账务明细 are documented, not tested against the channels, 规划/09 §5.7); a date without a
// bill answers unknown. No real merchant or payer data.
// Missing pieces fail as NotImplemented (the skeleton) or as assertions (an unregistered admin
// route answers 404). Plain SQL always names the schema.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Insertable, type Selectable } from 'kysely';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import type { PayBillResult } from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import {
  runPayBillRecon,
  type PayBillRow,
} from '../../../../apps/api/src/modules/payment/application/pay-recon.ts';
import {
  anomalyRefundVoucher,
  refundVoucher,
} from '../../../../apps/api/src/modules/payment/application/pay-refund-result.ts';
import {
  anomalyVoucher,
  receiptVoucher,
} from '../../../../apps/api/src/modules/payment/application/pay-settlement.ts';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import type { PayJobDeps } from '../../../../apps/api/src/modules/payment/jobs/pay-jobs.ts';
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
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  TTL_MS,
  fixture,
  payOrder,
  payOrders,
  seedOrder,
  type Fixture,
  type OrderRow,
  type Suite,
} from '../orders/kit.ts';
import {
  REFUND_SUCCESS,
  channelRefundNo,
  refunds,
  seedRefund,
  type AnomalyRow,
  type RefundRow,
} from '../refund/kit.ts';
import {
  AMOUNT,
  SUCCESS,
  SpecPayChannel,
  alertsMentioning,
  anomalies,
  jobKit,
  reconDiffs,
  tradeNo,
  userTraces,
  vouchers,
  type JobKit,
  type VoucherView,
} from '../result/kit.ts';

export const CHANNELS = ['wechat_pay', 'alipay'] as const;
export { AMOUNT, REFUND_SUCCESS, SUCCESS };

/** The bill reconciled by default: day D, run on D+1 (T+1) at 10:00 +08:00. */
export const BILL_DATE = '2026-10-21';
export const NOW = '2026-10-22T02:00:00.000Z';
/** 2026-10-21 10:00 +08:00: inside the bill day. */
export const IN_DAY = '2026-10-21T02:00:00.000Z';
/** 2026-10-21 01:00 +08:00 (UTC date 10-20): inside the bill day at +08:00. */
export const IN_DAY_EARLY = '2026-10-20T17:00:00.000Z';
/** 2026-10-22 01:00 +08:00 (UTC date 10-21): the day after the bill day at +08:00. */
export const NEXT_DAY = '2026-10-21T17:00:00.000Z';
/** 2026-10-20 23:00 +08:00: the day before the bill day. */
export const PREVIOUS_DAY = '2026-10-20T15:00:00.000Z';

/** A documented trade state of each channel that is not a success (WeChat CLOSED, Alipay TRADE_CLOSED). */
export const NOT_SUCCESS: Record<PayChannelCode, string> = {
  wechat_pay: 'CLOSED',
  alipay: 'TRADE_CLOSED',
};

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

// ---------------------------------------------------------------------------------------------
// Synthetic channel with bills.

export class BillChannel extends SpecPayChannel {
  /** Every date handed to downloadBill, in call order. */
  readonly billDates: string[] = [];
  readonly #bills = new Map<string, readonly PayBillRow[] | 'unknown'>();

  /** Sets the bill of a date as later downloadBill calls see it ('unknown': not available). */
  setBill(date: string, lines: readonly PayBillRow[] | 'unknown'): void {
    this.#bills.set(date, lines);
  }

  override downloadBill(date: string): Promise<PayBillResult> {
    this.billDates.push(date);
    const bill = this.#bills.get(date);
    if (bill === undefined || bill === 'unknown') {
      return Promise.resolve({ kind: 'unknown', reason: 'spec_bill_unavailable' });
    }
    return Promise.resolve({ kind: 'ok', rows: bill.map((line) => ({ ...line })) });
  }
}

export type BillChannels = Record<PayChannelCode, BillChannel>;

export interface TradeLineInput {
  readonly outTradeNo: string;
  readonly channelTradeNo: string;
  readonly amountFen: bigint;
  readonly state: string;
  readonly feeFen?: bigint;
}

/** A trade line of the bill. */
export function tradeLine(input: TradeLineInput): PayBillRow {
  return {
    record_type: 'trade',
    out_trade_no: input.outTradeNo,
    channel_trade_no: input.channelTradeNo,
    out_refund_no: '',
    channel_refund_no: '',
    amount_fen: String(input.amountFen),
    state: input.state,
    fee_fen: String(input.feeFen ?? 0n),
  };
}

/** The trade line of one of our orders, in the channel's success state unless patched. */
export function lineOf(
  order: OrderRow,
  patch: Partial<Omit<TradeLineInput, 'outTradeNo'>> = {},
): PayBillRow {
  const channel = order.pay_channel as PayChannelCode;
  return tradeLine({
    outTradeNo: order.out_trade_no,
    channelTradeNo: order.channel_trade_no ?? tradeNo(channel),
    amountFen: order.amount_fen,
    state: SUCCESS[channel],
    ...patch,
  });
}

export interface RefundLineInput {
  /** The original payment's merchant and channel numbers. */
  readonly outTradeNo: string;
  readonly channelTradeNo: string;
  readonly outRefundNo: string;
  readonly channel: PayChannelCode;
  readonly amountFen: bigint;
  readonly state?: string;
  readonly channelRefundNo?: string;
  readonly feeFen?: bigint;
}

/** A refund line of the bill, in the channel's refund success state unless given. */
export function refundLine(input: RefundLineInput): PayBillRow {
  return {
    record_type: 'refund',
    out_trade_no: input.outTradeNo,
    channel_trade_no: input.channelTradeNo,
    out_refund_no: input.outRefundNo,
    channel_refund_no: input.channelRefundNo ?? channelRefundNo(input.channel),
    amount_fen: String(input.amountFen),
    state: input.state ?? REFUND_SUCCESS[input.channel],
    fee_fen: String(input.feeFen ?? 0n),
  };
}

/** The refund line of one of our refunds of a pay order. */
export function refundLineOf(
  order: OrderRow,
  refund: RefundRow,
  patch: Partial<Omit<RefundLineInput, 'outTradeNo' | 'channel'>> = {},
): PayBillRow {
  return refundLine({
    outTradeNo: order.out_trade_no,
    channelTradeNo: order.channel_trade_no ?? '',
    outRefundNo: refund.out_refund_no,
    channel: order.pay_channel as PayChannelCode,
    amountFen: refund.amount_fen,
    ...(refund.channel_refund_no === null ? {} : { channelRefundNo: refund.channel_refund_no }),
    ...patch,
  });
}

// ---------------------------------------------------------------------------------------------
// The reconciliation run.

export interface Recon {
  readonly f: Fixture;
  readonly channels: BillChannels;
  readonly kit: JobKit;
  /** One run of the reconciliation of the channel's bill of `billDate` for the fixture's app. */
  run(channel: PayChannelCode, billDate?: string): Promise<void>;
}

/** One app with a FixedClock at `instant`, both bill channels and the job deps over them. */
export async function recon(s: Suite, instant = NOW): Promise<Recon> {
  const f = await fixture(s, instant);
  return reconOf(f);
}

/** The reconciliation of an existing fixture (another app of the same database). */
export async function reconOf(f: Fixture): Promise<Recon> {
  const channels: BillChannels = {
    wechat_pay: new BillChannel('wechat_pay'),
    alipay: new BillChannel('alipay'),
  };
  for (const channel of CHANNELS) channels[channel].own(f.subject.app_id);
  const kit = await jobKit(f, channels);
  return {
    f,
    channels,
    kit,
    async run(channel, billDate = BILL_DATE) {
      // The kit's deps are the pay queue handler's (ledger typed loosely, as ../result/kit.ts).
      await runPayBillRecon(kit.deps as unknown as PayJobDeps, {
        app_id: f.subject.app_id,
        pay_channel: channel,
        bill_date: billDate,
      });
    },
  };
}

/** How a promise ended: 'resolved' or the error's name and message. */
export async function settled(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : `thrown ${String(error)}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Seeds: the state the earlier flows (B2-15b ～ B2-15e) would have left.

function at(instant: string | Date): Date {
  return typeof instant === 'string' ? new Date(instant) : instant;
}

/** A PAID order paid at `paidAt` (inside the bill day by default) with its PAY_RECEIPT voucher. */
export async function paidOrder(
  r: Recon,
  channel: PayChannelCode,
  options: { readonly paidAt?: string; readonly amountFen?: bigint } = {},
): Promise<OrderRow> {
  const paidAt = at(options.paidAt ?? IN_DAY);
  const createdAt = new Date(paidAt.getTime() - 60_000);
  const order = await seedOrder(r.f, {
    pay_channel: channel,
    amount_fen: options.amountFen ?? AMOUNT,
    status: 'PAID',
    channel_trade_no: tradeNo(channel),
    created_at: createdAt,
    launch_issued_at: createdAt,
    expire_at: new Date(createdAt.getTime() + TTL_MS),
    paid_at: paidAt,
    updated_at: paidAt,
  });
  await r.f.db.transaction().execute((trx) => r.kit.deps.ledger.post(trx, receiptVoucher(order)));
  return payOrder(r.f, order.id);
}

/** A PENDING order whose launch parameters went out inside the bill day. */
export function pendingOrder(
  r: Recon,
  channel: PayChannelCode,
  patch: Partial<Insertable<DB['pay_orders']>> = {},
): Promise<OrderRow> {
  const createdAt = at(IN_DAY);
  return seedOrder(r.f, {
    pay_channel: channel,
    amount_fen: AMOUNT,
    created_at: createdAt,
    launch_issued_at: createdAt,
    expire_at: new Date(createdAt.getTime() + TTL_MS),
    updated_at: createdAt,
    ...patch,
  });
}

/** A CLOSED order (BR-PAY-05: the channel confirmed it closed), no receipt. */
export function closedOrder(r: Recon, channel: PayChannelCode): Promise<OrderRow> {
  const createdAt = at(IN_DAY);
  const closedAt = new Date(createdAt.getTime() + TTL_MS + 60_000);
  return seedOrder(r.f, {
    pay_channel: channel,
    amount_fen: AMOUNT,
    status: 'CLOSED',
    created_at: createdAt,
    launch_issued_at: createdAt,
    expire_at: new Date(createdAt.getTime() + TTL_MS),
    closed_at: closedAt,
    close_reason: 'expired',
    updated_at: closedAt,
  });
}

/**
 * A refund of a PAID order. SUCCESS (the default) succeeded at `at` (inside the bill day by
 * default), moved the order's refunded_fen and has its PAY_REFUND voucher, as B2-15e leaves it.
 */
export async function orderRefund(
  r: Recon,
  order: OrderRow,
  options: {
    readonly amountFen?: bigint;
    readonly status?: 'PROCESSING' | 'SUCCESS' | 'FAILED';
    readonly at?: string;
  } = {},
): Promise<RefundRow> {
  const status = options.status ?? 'SUCCESS';
  const instant = at(options.at ?? IN_DAY);
  const refund = await seedRefund(
    r.f,
    { type: 'pay_order', id: order.id },
    {
      amount_fen: options.amountFen ?? 1_000n,
      status,
      created_at: new Date(instant.getTime() - 60_000),
      succeeded_at: status === 'SUCCESS' ? instant : null,
      failed_at: status === 'FAILED' ? instant : null,
      channel_refund_no:
        status === 'PROCESSING' ? null : channelRefundNo(order.pay_channel as PayChannelCode),
    },
  );
  if (status === 'SUCCESS') {
    const paid = await payOrder(r.f, order.id);
    await r.f.db
      .transaction()
      .execute((trx) => r.kit.deps.ledger.post(trx, refundVoucher(paid, refund)));
  }
  return refund;
}

/**
 * An anomaly receipt registered earlier (BR-PAY-05 ④) for a CLOSED order of ours, with its
 * PAY_ANOMALY voucher, as B2-15c's registration leaves it (no recon diff of this run's bill day).
 */
export async function registeredAnomaly(
  r: Recon,
  order: OrderRow,
  options: { readonly channelTradeNo?: string; readonly amountFen?: bigint } = {},
): Promise<AnomalyRow> {
  const id = randomUUID();
  await r.f.db
    .insertInto('pay_anomalies')
    .values({
      id,
      app_id: r.f.subject.app_id,
      pay_channel: order.pay_channel,
      channel_trade_no: options.channelTradeNo ?? tradeNo(order.pay_channel as PayChannelCode),
      out_trade_no: order.out_trade_no,
      pay_order_id: order.id,
      amount_fen: options.amountFen ?? order.amount_fen,
      refunded_fen: 0n,
      evidence: sql`${JSON.stringify({ source: 'notify', seeded_by: 'b2-15j-spec' })}::jsonb`,
      status: 'open',
      created_at: at(PREVIOUS_DAY),
    })
    .execute();
  const anomaly = await r.f.db
    .selectFrom('pay_anomalies')
    .selectAll()
    .where('app_id', '=', r.f.subject.app_id)
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  await r.f.db.transaction().execute((trx) => r.kit.deps.ledger.post(trx, anomalyVoucher(anomaly)));
  return anomaly;
}

/** A SUCCESS refund of an anomaly receipt with its reverse PAY_ANOMALY voucher (B2-15e). */
export async function anomalyRefund(
  r: Recon,
  anomaly: AnomalyRow,
  options: { readonly amountFen?: bigint } = {},
): Promise<RefundRow> {
  const instant = at(IN_DAY);
  const refund = await seedRefund(
    r.f,
    { type: 'pay_anomaly', id: anomaly.id },
    {
      amount_fen: options.amountFen ?? anomaly.amount_fen,
      reason_code: 'ANOMALY_RECEIPT',
      status: 'SUCCESS',
      created_at: new Date(instant.getTime() - 60_000),
      succeeded_at: instant,
      channel_refund_no: channelRefundNo(anomaly.pay_channel as PayChannelCode),
    },
  );
  await r.f.db
    .transaction()
    .execute((trx) => r.kit.deps.ledger.post(trx, anomalyRefundVoucher(anomaly, refund)));
  return refund;
}

// ---------------------------------------------------------------------------------------------
// Readers and expectations.

export type DiffRow = Selectable<DB['recon_diffs']>;

/** Everything a reconciliation must leave as it was when it only reports. */
export async function snapshot(r: Recon) {
  return {
    orders: await payOrders(r.f),
    refunds: await refunds(r.f),
    anomalies: await anomalies(r.f),
    vouchers: await vouchers(r.f),
  };
}

export function diffs(r: Recon): Promise<DiffRow[]> {
  return reconDiffs(r.f);
}

/** The recon diffs of the app that refer to `refId`. */
export async function diffsOf(r: Recon, refId: string): Promise<DiffRow[]> {
  return (await diffs(r)).filter((row) => row.ref_id === refId);
}

export interface ExpectedDiff {
  readonly type: 'pay_mismatch' | 'pay_anomaly';
  /** null leaves ref_type to the implementation (it must still be non-empty). */
  readonly refType: string | null;
  readonly refId: string;
  /** Ours: what we booked as received / refunded for it (0 when nothing). */
  readonly expectedFen: bigint;
  /** The channel's, from the bill; null leaves it unchecked. */
  readonly actualFen: bigint | null;
  /** expected_fen − actual_fen (contract AdminPayReconDiff) unless given. */
  readonly diffFen?: bigint;
  readonly period?: string;
}

/**
 * An open R4 recon diff registered by the reconciliation through ledger: the app's, the bill date
 * as period, the reference and amounts, no handler, not closed, and a dedupe key (so a run
 * delivered again finds it instead of registering a second).
 */
export function expectDiff(r: Recon, row: DiffRow | undefined, want: ExpectedDiff): void {
  expect(row, `recon diff of ${want.refId}`).toBeDefined();
  const diff = row!;
  expect(diff).toMatchObject({
    app_id: r.f.subject.app_id,
    type: want.type,
    source: 'R4',
    period: want.period ?? BILL_DATE,
    ref_id: want.refId,
    expected_fen: want.expectedFen,
    status: 'open',
    handler_id: null,
    closed_at: null,
  });
  if (want.refType === null) {
    expect(diff.ref_type.length).toBeGreaterThan(0);
  } else {
    expect(diff.ref_type).toBe(want.refType);
  }
  if (want.actualFen !== null) expect(diff.actual_fen).toBe(want.actualFen);
  expect(diff.diff_fen).toBe(want.diffFen ?? diff.expected_fen - diff.actual_fen);
  expect(typeof diff.dedupe_key === 'string' && diff.dedupe_key.length > 0, 'dedupe_key').toBe(
    true,
  );
}

/** At least one alert (warn or above) naming one of the values. */
export function alerted(r: Recon, values: readonly string[]): void {
  expect(
    alertsMentioning(r.kit.logs, values).length,
    `an alert naming ${values.join(' / ')}`,
  ).toBeGreaterThanOrEqual(1);
}

/** Nothing was opened, enqueued or published: the reconciliation never settles (BR-PAY-04). */
export function noFulfilment(r: Recon): void {
  expect(r.kit.sent.filter((job) => job.name === 'biz.reconcile')).toEqual([]);
  expect(r.kit.published).toEqual([]);
}

/** The PAY_FEE voucher of one (channel, bill date) (借 PAY_CHANNEL_FEE / 贷 CASH_PAY:{pay_channel}). */
export function feeVoucherOf(channel: PayChannelCode, billDate: string, feeFen: bigint) {
  return {
    uniq_key: `PAY_FEE:${channel}:${billDate}`,
    voucher_kind: 'PAY_FEE',
    entries: [
      {
        owner_type: 'platform',
        subject: 'PAY_CHANNEL_FEE',
        amount: String(feeFen),
        ledger_type: 'PAY_FEE',
      },
      {
        owner_type: 'platform',
        subject: `CASH_PAY:${channel}`,
        amount: String(-feeFen),
        ledger_type: 'PAY_FEE',
      },
    ],
  };
}

/** A voucher view without its biz id (the PAY_FEE voucher's biz reference is the implementation's). */
export function shape(view: VoucherView) {
  return { uniq_key: view.uniq_key, voucher_kind: view.voucher_kind, entries: view.entries };
}

/** The vouchers of the app whose uniq key starts with `prefix`. */
export async function vouchersLike(r: Recon, prefix: string): Promise<VoucherView[]> {
  return (await vouchers(r.f)).filter((view) => view.uniq_key.startsWith(prefix));
}

/** Withdraw holds of the app (BR-PAY-07: a collection diff never holds a withdrawal). */
export async function withdrawHolds(f: Fixture): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM app.withdraw_holds WHERE app_id = ${f.subject.app_id}`.execute(
    f.db,
  );
  return result.rows[0]?.n ?? -1;
}

export { userTraces };

// ---------------------------------------------------------------------------------------------
// The admin entry: GET /admin/v1/pay-recon-diffs.

export const VIEW = 'pay.view';
export const LIST_PATH = '/admin/v1/pay-recon-diffs';

export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}

export interface AdminSent {
  readonly statusCode: number;
  readonly body: string;
  json(): Envelope;
}

export interface AdminCaller {
  readonly id: string;
  readonly token: string;
}

export interface ReconAdmin {
  /** Every pino line of the entry. */
  readonly logs: string[];
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** GET /admin/v1/pay-recon-diffs with the query parameters, as the viewer unless given. */
  list(query?: Record<string, string>, caller?: AdminCaller | null): Promise<AdminSent>;
  /** An account with pay.view only. */
  readonly viewer: AdminCaller;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withReconAdmin(f: Fixture, run: (h: ReconAdmin) => Promise<void>) {
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
  const dir = mkdtempSync(join(base, 'b2-15j-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
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
        JWT_KEY_ID: 'b2_15j_test',
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
      dbHandles: { db: f.db, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        DATABASE_READ_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: f.s.redisUrl(),
      }).redisUrl,
    });
    await app.init();
    const server = app;
    const redis = server.get<RedisHandle>(REDIS);
    const caller: ReconAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.subject.app_id,
          login_name: `recon_${id}`,
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
      await createAdminSessions({ redis: redis.namespace('admin-auth'), clock: f.clock }).create(
        claims.sessionId,
        {
          adminId: id,
          appId: f.subject.app_id,
          expiresAtMs: claims.expiresAt * 1000,
          lastSeenMs: f.clock.now().getTime(),
        },
      );
      return { id, token };
    };
    const viewer = await caller([VIEW]);
    await run({
      logs,
      caller,
      viewer,
      async list(query, who) {
        const actor = who === undefined ? viewer : who;
        const headers: Record<string, string> = { 'x-trace-id': randomUUID() };
        if (actor !== null) headers['authorization'] = `Bearer ${actor.token}`;
        const text = new URLSearchParams(query ?? {}).toString();
        const response = await server.inject({
          method: 'GET',
          url: text === '' ? LIST_PATH : `${LIST_PATH}?${text}`,
          headers,
          remoteAddress: '127.0.0.1',
        });
        return {
          statusCode: response.statusCode,
          body: response.body,
          json: () => JSON.parse(response.body) as Envelope,
        };
      },
    });
  } finally {
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
};

/** The response body conforms to listAdminPayReconDiffs' schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[LIST_PATH]?.['get']?.responses[status]?.content?.[
    'application/json'
  ]?.schema;
  expect(schema, `${LIST_PATH} ${status}`).toBeDefined();
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

export interface Page {
  readonly items: Record<string, unknown>[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

/** The page of a successful list response. */
export async function page(sent: AdminSent): Promise<Page> {
  const body = await answer(sent, 0);
  const data = body.data;
  expect(typeof data === 'object' && data !== null, sent.body).toBe(true);
  expect(Array.isArray((data as Record<string, unknown>)['items']), sent.body).toBe(true);
  return data as Page;
}

/** A recon_diffs row written directly (what any reconciliation would have registered). */
export async function seedDiff(
  f: Fixture,
  patch: Partial<Insertable<DB['recon_diffs']>> = {},
): Promise<DiffRow> {
  const id = patch.id ?? randomUUID();
  const now = f.clock.now();
  await f.db
    .insertInto('recon_diffs')
    .values({
      app_id: f.subject.app_id,
      type: 'pay_mismatch',
      source: 'R4',
      period: BILL_DATE,
      ref_type: 'pay_order',
      ref_id: randomUUID(),
      expected_fen: AMOUNT,
      actual_fen: 0n,
      diff_fen: AMOUNT,
      status: 'open',
      handler_id: null,
      closed_at: null,
      dedupe_key: `spec:${randomUUID()}`,
      resolution: null,
      created_at: now,
      updated_at: now,
      ...patch,
      id,
    })
    .execute();
  const row = await f.db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .where('id', '=', id)
    .executeTakeFirst();
  expect(row, `recon_diffs ${id}`).toBeDefined();
  return row!;
}

/** The AdminPayReconDiff a row must be shown as (instants as epoch milliseconds). */
export function diffView(row: DiffRow): Record<string, unknown> {
  return {
    recon_diff_id: row.id,
    source: row.source,
    type: row.type,
    period: row.period,
    ref_type: row.ref_type,
    ref_id: row.ref_id,
    expected_fen: Number(row.expected_fen),
    actual_fen: Number(row.actual_fen),
    diff_fen: Number(row.diff_fen),
    status: row.status,
    created_at: row.created_at.getTime(),
    closed_at: row.closed_at === null ? null : row.closed_at.getTime(),
  };
}

/** An AdminPayReconDiff of a response, its instants as epoch milliseconds. */
export function diffOf(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...item };
  for (const key of ['created_at', 'closed_at']) {
    const value = out[key];
    if (typeof value === 'string') out[key] = Date.parse(value);
  }
  return out;
}

/** The required keys of the contract's AdminPayReconDiff (additionalProperties false). */
export const DIFF_KEYS = [
  'actual_fen',
  'closed_at',
  'created_at',
  'diff_fen',
  'expected_fen',
  'period',
  'recon_diff_id',
  'ref_id',
  'ref_type',
  'source',
  'status',
  'type',
] as const;

/** Every audit record of the app (reading writes none). */
export function allAudits(f: Fixture) {
  return f.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .orderBy('id')
    .execute();
}
