// B2-15f rule-test kit (claude-independent, SPEC_REF 736d24c5; 08 BR-PAY-05 ③④ (needs_manual 由有
// 处置权限的账号在后台【立即查询】后按渠道结果结束：已支付 → PO2；已关闭，或符合 ② 的不存在条件 → PO3；
// step-up、写审计，凭证为查询响应；异常收款), BR-PAY-07 (PAY_RECEIPT 每张支付单至多一张), BR-PAY-08 ④
// (不返回渠道侧的用户标识); 规划/04 §6.6, §11.2 (pay.view 只读、pay.resolve step-up totp);
// contracts/openapi.yaml listAdminPayOrders / getAdminPayOrder / resolveAdminPayOrder /
// listAdminPayAnomalies).
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission
// checks, the step-up gate over Redis, contract validation, admin's audit writer, the started
// JOB_QUEUE), the api entry's notification route (../result/kit.ts withNotify), ledger's posting,
// pgboss and event_log. Synthetic: the two channels. AdminChannel extends B2-15c's SpecPayChannel:
// it answers query as scripted per merchant order number (paid / not paid / closed / not exist /
// timeout, with our identity) and records every close call; the documented states it stands for
// (WeChat trade_state SUCCESS / NOTPAY / CLOSED / ORDER_NOT_EXIST, Alipay trade_status
// TRADE_SUCCESS / WAIT_BUYER_PAY / TRADE_CLOSED / ACQ.TRADE_NOT_EXIST) are documented, not tested
// against the channels (规划/09 §5.7).
// The totp step-up token is issued the way POST /admin/v1/auth/step-up issues it after a correct
// authenticator code (admin's createAdminStepUpTokens on the entry's own Redis namespace
// admin-step-up, bound to the account, its admin session and the tier); the operation's gate is
// the real one. Admin accounts, tokens and sessions are seeded as ../refund/kit.ts does.
// Missing pieces fail as assertions (an unregistered admin route answers 404, so the status and
// code checks fail). Plain SQL always names the schema.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Selectable } from 'kysely';
import { expect, vi } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import {
  PayChannelSet,
  type PayChannelIdentity,
  type PayCloseResult,
} from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
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
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { TTL_MS, seedOrder, type Fixture, type OrderRow } from '../orders/kit.ts';
import { AMOUNT, NOT_PAID, SUCCESS, SpecPayChannel, tradeNo } from '../result/kit.ts';

export const CHANNELS = ['wechat_pay', 'alipay'] as const;
export { AMOUNT, NOT_PAID, SUCCESS };

/** specs/permissions.yaml: pay.view (no step-up), pay.resolve (step-up tier totp), pay.refund. */
export const VIEW = 'pay.view';
export const RESOLVE = 'pay.resolve';
export const REFUND = 'pay.refund';
/** The audit action of a resolve (contracts/openapi.yaml resolveAdminPayOrder). */
export const AUDIT_ACTION = 'pay_order_resolve';
/** The only body of a resolve (AdminPayOrderResolveRequest). */
export const RESOLVE_BODY = { expected_status: 'PENDING', action: 'query_and_settle' } as const;
/** The channel's own closed state (WeChat trade_state, Alipay trade_status; documented, 待实测). */
export const CLOSED_STATE: Record<PayChannelCode, string> = {
  wechat_pay: 'CLOSED',
  alipay: 'TRADE_CLOSED',
};
/** BR-PAY-05 细则 · 关单 defaults: pay.close_grace_minutes 10, pay.close_wait_minutes 60. */
export const GRACE_MINUTES = 10;
export const WAIT_MINUTES = 60;
/** How long past expire_at the seeded needs_manual orders are (past expire_at + wait). */
export const MANUAL_AGE_MS = (WAIT_MINUTES + 1) * 60_000;
export const STEP_UP_TTL_MS = 5 * 60_000;

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

// ---------------------------------------------------------------------------------------------
// Synthetic channel.

/** What query answers for a merchant order number. */
export type Answer = 'paid' | 'not_paid' | 'closed' | 'not_exist' | 'timeout';

export class AdminChannel extends SpecPayChannel {
  /** Our merchant / application identity on this channel (owned by the fixture's app). */
  readonly identity: PayChannelIdentity;
  /** Every out_trade_no handed to close, in order. */
  readonly closeCalls: string[] = [];

  constructor(channel: PayChannelCode, appId: string) {
    super(channel);
    this.identity = this.own(appId);
  }

  /**
   * Sets what query answers for the order from now on; a paid answer is the order's amount in the
   * channel's success state (amountFen overrides the amount); returns the paid trade number.
   * not_exist is what an order the channel never saw answers (nothing set).
   */
  script(order: OrderRow, answer: Answer, options: { readonly amountFen?: bigint } = {}): string {
    const trade = tradeNo(this.channel);
    switch (answer) {
      case 'paid':
        this.setTrade(
          order.out_trade_no,
          this.paid(this.identity, options.amountFen ?? order.amount_fen, trade),
        );
        break;
      case 'not_paid':
      case 'closed':
        this.setTrade(order.out_trade_no, {
          state: answer,
          channelState: answer === 'not_paid' ? NOT_PAID[this.channel] : CLOSED_STATE[this.channel],
          amountFen: null,
          channelTradeNo: null,
          identity: this.identity,
        });
        break;
      case 'timeout':
        this.setTrade(order.out_trade_no, 'timeout');
        break;
      case 'not_exist':
        break;
    }
    return trade;
  }

  override close(outTradeNo: string): Promise<PayCloseResult> {
    this.closeCalls.push(outTradeNo);
    return super.close(outTradeNo);
  }
}

export type AdminChannels = Record<PayChannelCode, AdminChannel>;

/** Both channels, each with an identity registered as the fixture app's. */
export function adminChannels(f: Fixture): AdminChannels {
  return {
    wechat_pay: new AdminChannel('wechat_pay', f.subject.app_id),
    alipay: new AdminChannel('alipay', f.subject.app_id),
  };
}

// ---------------------------------------------------------------------------------------------
// Seeds.

/**
 * A PENDING order as B2-15d's close flow leaves it at expire_at + pay.close_wait_minutes without a
 * result (BR-PAY-05 ③): launch issued, closing (expired), needs_manual; expire_at MANUAL_AGE_MS ago.
 */
export function seedNeedsManual(
  f: Fixture,
  channel: PayChannelCode,
  patch: Parameters<typeof seedOrder>[1] = {},
): Promise<OrderRow> {
  const now = f.clock.now().getTime();
  return seedOrder(f, {
    pay_channel: channel,
    amount_fen: AMOUNT,
    created_at: new Date(now - MANUAL_AGE_MS - TTL_MS),
    launch_issued_at: new Date(now - MANUAL_AGE_MS - TTL_MS),
    expire_at: new Date(now - MANUAL_AGE_MS),
    closing: true,
    close_reason: 'expired',
    needs_manual: true,
    ...patch,
  });
}

export type AnomalyRow = Selectable<DB['pay_anomalies']>;

export interface AnomalySeed {
  readonly channel: PayChannelCode;
  /** The CLOSED order the money was received for; null: a merchant number naming no order. */
  readonly order: OrderRow | null;
  /** The merchant number the channel gave when there is no order (null: none given). */
  readonly outTradeNo?: string | null;
  readonly amountFen?: bigint;
  readonly refundedFen?: bigint;
  readonly status?: 'open' | 'refunded' | 'closed';
  readonly createdAt: Date;
  /** Kept server side, never returned (contract AdminPayAnomaly). */
  readonly evidence: Record<string, unknown>;
}

/** A pay_anomalies row as the anomaly registration (B2-15c) would have left it. */
export async function seedAnomalyRow(f: Fixture, seed: AnomalySeed): Promise<AnomalyRow> {
  const id = randomUUID();
  await f.db
    .insertInto('pay_anomalies')
    .values({
      id,
      app_id: f.subject.app_id,
      pay_channel: seed.channel,
      channel_trade_no: tradeNo(seed.channel),
      out_trade_no: seed.order?.out_trade_no ?? seed.outTradeNo ?? null,
      pay_order_id: seed.order?.id ?? null,
      amount_fen: seed.amountFen ?? AMOUNT,
      refunded_fen: seed.refundedFen ?? 0n,
      evidence: sql`${JSON.stringify(seed.evidence)}::jsonb`,
      status: seed.status ?? 'open',
      created_at: seed.createdAt,
    })
    .execute();
  const row = await f.db
    .selectFrom('pay_anomalies')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .where('id', '=', id)
    .executeTakeFirst();
  expect(row, `pay_anomalies ${id}`).toBeDefined();
  return row!;
}

/** A pay_query_attempts row written directly (what an earlier channel call left). */
export async function seedAttempt(
  f: Fixture,
  target: { readonly payOrderId: string } | { readonly payRefundId: string },
  attempt: {
    readonly kind: 'query' | 'close' | 'refund' | 'refund_query';
    readonly result: string;
    readonly at: Date;
    readonly request?: Record<string, unknown>;
    readonly response?: Record<string, unknown>;
  },
): Promise<void> {
  const payOrderId = 'payOrderId' in target ? target.payOrderId : null;
  const payRefundId = 'payRefundId' in target ? target.payRefundId : null;
  await sql`
    INSERT INTO app.pay_query_attempts
      (id, app_id, pay_order_id, pay_refund_id, kind, request, response, result, at, created_at)
    VALUES (${randomUUID()}::uuid, ${f.subject.app_id}, ${payOrderId}::uuid, ${payRefundId}::uuid,
      ${attempt.kind}, ${JSON.stringify(attempt.request ?? { op: attempt.kind })}::jsonb,
      ${JSON.stringify(attempt.response ?? { kind: 'ok' })}::jsonb, ${attempt.result},
      ${attempt.at}, ${attempt.at})`.execute(f.db);
}

/** A synthetic WeChat openid / Alipay buyer id (channel-side user identifiers, BR-PAY-08 ④). */
export function payerIds(): { readonly openid: string; readonly buyerId: string } {
  return {
    openid: `o${randomBytes(14).toString('base64url')}`,
    buyerId: `2088${Array.from(randomBytes(12), (byte) => String(byte % 10)).join('')}`,
  };
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}

export type Operation = 'list' | 'detail' | 'resolve' | 'anomalies';

const TEMPLATE: Record<Operation, { readonly method: 'get' | 'post'; readonly path: string }> = {
  list: { method: 'get', path: '/admin/v1/pay-orders' },
  detail: { method: 'get', path: '/admin/v1/pay-orders/{pay_order_id}' },
  resolve: { method: 'post', path: '/admin/v1/pay-orders/{pay_order_id}/resolve' },
  anomalies: { method: 'get', path: '/admin/v1/pay-anomalies' },
};

export interface AdminSent {
  readonly op: Operation;
  readonly statusCode: number;
  readonly body: string;
  json(): Envelope;
}

export interface AdminCaller {
  readonly id: string;
  readonly token: string;
  readonly sessionId: string;
}

export interface ResolveOptions {
  /** The request body; RESOLVE_BODY by default. */
  readonly body?: unknown;
  /** The caller; the harness's resolver by default; null sends no admin token. */
  readonly caller?: AdminCaller | null;
  /** X-Step-Up-Token: a fresh totp-tier token of the caller by default; null sends none. */
  readonly stepUp?: string | null;
}

export interface AdminHarness {
  /** Every pino line of the entry. */
  readonly logs: string[];
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** A step-up token of the caller's account and admin session (tier totp by default). */
  stepUp(caller: AdminCaller, tier?: 'totp' | 'sms'): Promise<string>;
  /** GET /admin/v1/pay-orders with the query parameters, as the viewer unless given. */
  list(query?: Record<string, string>, caller?: AdminCaller | null): Promise<AdminSent>;
  /** GET /admin/v1/pay-orders/{pay_order_id}, as the viewer unless given. */
  detail(payOrderId: string, caller?: AdminCaller | null): Promise<AdminSent>;
  /** GET /admin/v1/pay-anomalies with the query parameters, as the viewer unless given. */
  anomalies(query?: Record<string, string>, caller?: AdminCaller | null): Promise<AdminSent>;
  /** POST /admin/v1/pay-orders/{pay_order_id}/resolve. */
  resolve(payOrderId: string, options?: ResolveOptions): Promise<AdminSent>;
  /** An account with pay.view only. */
  readonly viewer: AdminCaller;
  /** An account with pay.view and pay.resolve. */
  readonly resolver: AdminCaller;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}
interface Builder {
  overrideProvider(token: unknown): { useValue(value: unknown): Builder };
  compile(): Promise<{ createNestApplication(adapter: unknown, options: unknown): HttpApp }>;
}

function withQuery(path: string, query: Record<string, string> | undefined): string {
  const text = new URLSearchParams(query ?? {}).toString();
  return text === '' ? path : `${path}?${text}`;
}

/**
 * Runs `run` against a started admin entry on the fixture's database, clock and Redis, with the
 * spec channels in place of the process's channel set.
 */
export async function withAdmin(
  f: Fixture,
  channels: AdminChannels,
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
  const dir = mkdtempSync(join(base, 'b2-15f-'));
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
        JWT_KEY_ID: 'b2_15f_test',
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
    const caller: AdminHarness['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.subject.app_id,
          login_name: `pay_${id}`,
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
        redis: redis.namespace('admin-auth'),
        clock: f.clock,
      }).create(claims.sessionId, {
        adminId: id,
        appId: f.subject.app_id,
        expiresAtMs: claims.expiresAt * 1000,
        lastSeenMs: f.clock.now().getTime(),
      });
      return { id, token, sessionId: claims.sessionId };
    };
    const stepUp: AdminHarness['stepUp'] = async (who, tier = 'totp') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.subject.app_id, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const send = async (
      op: Operation,
      url: string,
      who: AdminCaller | null,
      extra: { readonly body?: unknown; readonly stepUp?: string | null } = {},
    ): Promise<AdminSent> => {
      const headers: Record<string, string> = { 'x-trace-id': randomUUID() };
      if (who !== null) headers['authorization'] = `Bearer ${who.token}`;
      if (extra.stepUp !== undefined && extra.stepUp !== null) {
        headers['x-step-up-token'] = extra.stepUp;
      }
      const post = TEMPLATE[op].method === 'post';
      if (post) headers['content-type'] = 'application/json';
      const response = await server.inject({
        method: post ? 'POST' : 'GET',
        url,
        headers,
        ...(post ? { payload: JSON.stringify(extra.body) } : {}),
        remoteAddress: '127.0.0.1',
      });
      return {
        op,
        statusCode: response.statusCode,
        body: response.body,
        json: () => JSON.parse(response.body) as Envelope,
      };
    };
    const viewer = await caller([VIEW]);
    const resolver = await caller([VIEW, RESOLVE]);
    const pick = (who: AdminCaller | null | undefined): AdminCaller | null =>
      who === undefined ? viewer : who;
    await run({
      logs,
      caller,
      stepUp,
      viewer,
      resolver,
      list: (query, who) => send('list', withQuery('/admin/v1/pay-orders', query), pick(who)),
      detail: (id, who) => send('detail', `/admin/v1/pay-orders/${id}`, pick(who)),
      anomalies: (query, who) =>
        send('anomalies', withQuery('/admin/v1/pay-anomalies', query), pick(who)),
      async resolve(id, options = {}) {
        const who = options.caller === undefined ? resolver : options.caller;
        const token =
          options.stepUp !== undefined ? options.stepUp : who === null ? null : await stepUp(who);
        return send('resolve', `/admin/v1/pay-orders/${id}/resolve`, who, {
          body: options.body === undefined ? RESOLVE_BODY : options.body,
          stepUp: token,
        });
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

// ---------------------------------------------------------------------------------------------
// Contract checks.

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
  10003: 403,
  10403: 403,
  20001: 400,
  20902: 409,
};

/** The response body conforms to the contract's schema of its operation and status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const { method, path } = TEMPLATE[sent.op];
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[path]?.[method]?.responses[status]?.content?.[
    'application/json'
  ]?.schema;
  expect(schema, `${path} ${status}`).toBeDefined();
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
  expect(sent.statusCode, `${sent.op}: ${sent.body}`).toBe(HTTP_STATUS[code]);
  const body = sent.json();
  expect(body.code, sent.body).toBe(code);
  if (data !== undefined) expect(body.data, sent.body).toEqual(data);
  await conforms(sent);
  return body;
}

/** The data object of a successful response. */
export async function ok(sent: AdminSent): Promise<Record<string, unknown>> {
  const body = await answer(sent, 0);
  expect(typeof body.data === 'object' && body.data !== null, sent.body).toBe(true);
  return body.data as Record<string, unknown>;
}

export interface Page {
  readonly items: Record<string, unknown>[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

/** The page of a successful list response. */
export async function page(sent: AdminSent): Promise<Page> {
  const data = await ok(sent);
  expect(Array.isArray(data['items']), sent.body).toBe(true);
  return data as unknown as Page;
}

/** 10003 of an operation that needs a totp-tier step-up token. */
export const STEP_UP_TOTP = { tier: 'totp' } as const;
/** 20902 of a pay order not in the expected state. */
export const CONFLICT = { resource: 'pay_order' } as const;

// ---------------------------------------------------------------------------------------------
// Views (instants as epoch milliseconds).

function ms(value: Date | null): number | null {
  return value === null ? null : value.getTime();
}

function instant(value: unknown): unknown {
  return typeof value === 'string' ? Date.parse(value) : value;
}

/** Response data with the named date-time strings turned into epoch milliseconds. */
export function normalize(data: unknown, keys: readonly string[]): Record<string, unknown> {
  expect(typeof data === 'object' && data !== null, JSON.stringify(data)).toBe(true);
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const key of keys) out[key] = instant(out[key]);
  return out;
}

export const ORDER_TIMES = ['expire_at', 'paid_at', 'closed_at', 'created_at'] as const;
export const REFUND_TIMES = ['created_at', 'succeeded_at'] as const;

/** The AdminPayOrder a row must be shown as. */
export function orderView(row: OrderRow): Record<string, unknown> {
  return {
    pay_order_id: row.id,
    user_id: row.user_id,
    biz_type: row.biz_type,
    biz_ref: row.biz_ref,
    pay_channel: row.pay_channel,
    amount_fen: Number(row.amount_fen),
    refunded_fen: Number(row.refunded_fen),
    status: row.status,
    out_trade_no: row.out_trade_no,
    channel_trade_no: row.channel_trade_no,
    needs_manual: row.needs_manual,
    closing: row.closing,
    expire_at: row.expire_at.getTime(),
    paid_at: ms(row.paid_at),
    closed_at: ms(row.closed_at),
    created_at: row.created_at.getTime(),
  };
}

/** An AdminPayOrder of a response, its instants as epoch milliseconds. */
export function orderOf(data: unknown): Record<string, unknown> {
  return normalize(data, ORDER_TIMES);
}

export type RefundRow = Selectable<DB['pay_refunds']>;

/** The AdminPayRefund a row must be shown as. */
export function refundView(row: RefundRow): Record<string, unknown> {
  return {
    pay_refund_id: row.id,
    target_type: row.target_type,
    target_id: row.target_id,
    out_refund_no: row.out_refund_no,
    amount_fen: Number(row.amount_fen),
    reason_code: row.reason_code,
    note: row.note,
    status: row.status,
    channel_refund_no: row.channel_refund_no,
    operator: row.operator,
    created_at: row.created_at.getTime(),
    succeeded_at: ms(row.succeeded_at),
  };
}

/** The AdminPayAnomaly a row must be shown as. */
export function anomalyView(row: AnomalyRow): Record<string, unknown> {
  return {
    pay_anomaly_id: row.id,
    pay_channel: row.pay_channel,
    channel_trade_no: row.channel_trade_no,
    out_trade_no: row.out_trade_no,
    pay_order_id: row.pay_order_id,
    amount_fen: Number(row.amount_fen),
    refunded_fen: Number(row.refunded_fen),
    status: row.status,
    created_at: row.created_at.getTime(),
  };
}

/** The required keys of the contract's AdminPayOrder (additionalProperties false). */
export const ORDER_KEYS = [
  'amount_fen',
  'biz_ref',
  'biz_type',
  'channel_trade_no',
  'closed_at',
  'closing',
  'created_at',
  'expire_at',
  'needs_manual',
  'out_trade_no',
  'paid_at',
  'pay_channel',
  'pay_order_id',
  'refunded_fen',
  'status',
  'user_id',
] as const;
export const ANOMALY_KEYS = [
  'amount_fen',
  'channel_trade_no',
  'created_at',
  'out_trade_no',
  'pay_anomaly_id',
  'pay_channel',
  'pay_order_id',
  'refunded_fen',
  'status',
] as const;
export const ATTEMPT_KEYS = ['at', 'kind', 'result'] as const;
export const RESULT_KEYS = ['channel_state', 'channel_trade_no', 'queried_at', 'state'] as const;

/** The sorted keys of a response object. */
export function keysOf(value: unknown): string[] {
  expect(typeof value === 'object' && value !== null, JSON.stringify(value)).toBe(true);
  return Object.keys(value as Record<string, unknown>).sort();
}

/** An instant with a +08:00 offset (the console's way of writing created_from / created_to). */
export function cst(at: Date): string {
  return new Date(at.getTime() + 8 * 3_600_000).toISOString().replace('Z', '+08:00');
}

// ---------------------------------------------------------------------------------------------
// Readers (plain SQL always names the schema).

export type AuditRow = Selectable<DB['audit_logs']>;

/** The resolve audit records of the app, oldest first. */
export function resolveAudits(f: Fixture): Promise<AuditRow[]> {
  return f.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .where('action', '=', AUDIT_ACTION)
    .orderBy('id')
    .execute();
}

/** Every audit record of the app. */
export function allAudits(f: Fixture): Promise<AuditRow[]> {
  return f.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .orderBy('id')
    .execute();
}

/** target, before and after of an audit record as one text. */
export function auditText(row: AuditRow): string {
  return JSON.stringify([row.target, row.before, row.after]);
}

/** The pay_refunds rows of the app. */
export function refundRows(f: Fixture): Promise<RefundRow[]> {
  return f.db
    .selectFrom('pay_refunds')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .orderBy('created_at')
    .execute();
}
