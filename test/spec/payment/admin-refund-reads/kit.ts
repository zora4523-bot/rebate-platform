// B2-15o rule-test kit (claude-independent, SPEC_REF 9ab94dc0; 08 BR-PAY-06 ① (退款对象是 PAID 的支付单
// 或异常收款，状态 PROCESSING / SUCCESS / FAILED，金额为正整数分), BR-PAY-05 ④; 规划/04 §6.6, §11.2
// (pay.view 只读、不要 step-up); contracts/openapi.yaml listAdminPayRefunds / getAdminPayRefund).
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// contract validation, admin's audit writer). The refunds are seeded rows: ../refund/kit.ts
// seedRefund writes what B2-15e's creation and result handling would have left. The seeds and views
// of ../admin/kit.ts and ../refund/kit.ts are reused; their harnesses know only their own routes, so
// the two GET routes are driven here the way ../recon/kit.ts drives its list.
// Missing pieces fail as assertions (an unregistered admin route answers 404, so the status and
// code checks fail). Plain SQL always names the schema.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
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
import { REFUND_TIMES, normalize, seedAnomalyRow, type AnomalyRow } from '../admin/kit.ts';
import { seedOrder, type Fixture, type OrderRow } from '../orders/kit.ts';
import { AMOUNT, tradeNo } from '../result/kit.ts';

export { AMOUNT };

/** specs/permissions.yaml: pay.view (no step-up); pay.refund and pay.resolve do not imply it. */
export const VIEW = 'pay.view';
export const LIST_PATH = '/admin/v1/pay-refunds';
export const DETAIL_PATH = '/admin/v1/pay-refunds/{pay_refund_id}';
/** The sorted required keys of the contract's AdminPayRefund (additionalProperties false). */
export const REFUND_KEYS = [
  'amount_fen',
  'channel_refund_no',
  'created_at',
  'note',
  'operator',
  'out_refund_no',
  'pay_refund_id',
  'reason_code',
  'status',
  'succeeded_at',
  'target_id',
  'target_type',
] as const;

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

// ---------------------------------------------------------------------------------------------
// Seeds.

/** A PAID pay order: a refund of target_type pay_order is taken against one (BR-PAY-06 ①). */
export function paidOrder(f: Fixture, channel: PayChannelCode): Promise<OrderRow> {
  return seedOrder(f, {
    pay_channel: channel,
    amount_fen: AMOUNT,
    status: 'PAID',
    channel_trade_no: tradeNo(channel),
    launch_issued_at: f.clock.now(),
    paid_at: f.clock.now(),
  });
}

/** A CLOSED pay order, the kind an anomaly receipt can name (BR-PAY-05 ④). */
export function closedOrder(f: Fixture, channel: PayChannelCode): Promise<OrderRow> {
  return seedOrder(f, {
    pay_channel: channel,
    amount_fen: AMOUNT,
    status: 'CLOSED',
    closed_at: f.clock.now(),
  });
}

/** An open anomaly receipt: for a CLOSED order, or (null) for no order of ours. */
export function anomalyOf(
  f: Fixture,
  channel: PayChannelCode,
  order: OrderRow | null,
): Promise<AnomalyRow> {
  return seedAnomalyRow(f, {
    channel,
    order,
    createdAt: f.clock.now(),
    evidence: { source: 'notify' },
  });
}

/** The instant `minutes` before the fixture's clock. */
export function minutesAgo(f: Fixture, minutes: number): Date {
  return new Date(f.clock.now().getTime() - minutes * 60_000);
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}

export type Operation = 'list' | 'detail';

const TEMPLATE: Record<Operation, string> = { list: LIST_PATH, detail: DETAIL_PATH };

export interface AdminSent {
  readonly op: Operation;
  readonly statusCode: number;
  readonly body: string;
  json(): Envelope;
}

export interface AdminCaller {
  readonly id: string;
  readonly token: string;
}

export interface RefundReads {
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** GET /admin/v1/pay-refunds with the query parameters, as the viewer unless given. */
  list(query?: Record<string, string>, caller?: AdminCaller | null): Promise<AdminSent>;
  /** GET /admin/v1/pay-refunds/{pay_refund_id}, as the viewer unless given. */
  detail(payRefundId: string, caller?: AdminCaller | null): Promise<AdminSent>;
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

function withQuery(path: string, query: Record<string, string> | undefined): string {
  const text = new URLSearchParams(query ?? {}).toString();
  return text === '' ? path : `${path}?${text}`;
}

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withRefundReads(
  f: Fixture,
  run: (h: RefundReads) => Promise<void>,
): Promise<void> {
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
  const dir = mkdtempSync(join(base, 'b2-15o-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
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
        JWT_KEY_ID: 'b2_15o_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'silent' },
        { write: () => undefined },
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
    const caller: RefundReads['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.subject.app_id,
          login_name: `refund_reads_${id}`,
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
    const send = async (
      op: Operation,
      url: string,
      who: AdminCaller | null,
    ): Promise<AdminSent> => {
      const headers: Record<string, string> = { 'x-trace-id': randomUUID() };
      if (who !== null) headers['authorization'] = `Bearer ${who.token}`;
      const response = await server.inject({
        method: 'GET',
        url,
        headers,
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
    const pick = (who: AdminCaller | null | undefined): AdminCaller | null =>
      who === undefined ? viewer : who;
    await run({
      caller,
      viewer,
      list: (query, who) => send('list', withQuery(LIST_PATH, query), pick(who)),
      detail: (id, who) => send('detail', `${LIST_PATH}/${encodeURIComponent(id)}`, pick(who)),
    });
  } finally {
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
  10403: 403,
  20001: 400,
};

/** The response body conforms to the contract's schema of its operation and status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const path = TEMPLATE[sent.op];
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[path]?.['get']?.responses[status]?.content?.[
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

/** An AdminPayRefund of a response, its instants as epoch milliseconds (see refundView). */
export function refundOf(data: unknown): Record<string, unknown> {
  return normalize(data, REFUND_TIMES);
}

/** The refund ids of a page, in the order returned. */
export function idsOf(data: Page): unknown[] {
  return data.items.map((item) => item['pay_refund_id']);
}
