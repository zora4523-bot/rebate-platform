// B2-15b rule-test kit (claude-independent, SPEC_REF 48e55e6a; 08 BR-PAY-01 ～ 05, task §9 / §10).
// Real api entry (createHttpApp: module graph, contract validation, PG idempotency, version gate,
// started JOB_QUEUE), real PostgreSQL through @couli/db/testing (business role couli_app only).
// Synthetic: the device secret of the signature check, the token verification, and the two
// channels, which are FakePayChannel instances put in through the PayChannelSet token. Every
// launch parameter is synthetic; no real merchant data is used.
// Missing pieces fail as assertions (route not registered → status) or as NotImplemented.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql, type Insertable, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import {
  TokenRejection,
  createTokenCheck,
} from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { PayChannelSet } from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import { FakePayChannel } from '../../../../apps/api/src/modules/payment/infra/channels/fake-pay-channel.ts';
import {
  FixedClock,
  REQUEST_CHECKS,
  createRootLogger,
  isContractSignedRoute,
  loadConfig,
  type DbHandles,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createSignatureCheck } from '../../../../apps/api/src/modules/risk/index.ts';
import { redisConnection } from '../../identity/sms-codes/kit.ts';
import { at, check, compile, contract, object, operation } from '../../contracts/pay-http/kit.ts';

export const NOW = '2026-10-22T01:00:00.000Z';
/** The non-production test business type (task §9.2): 1 fen, title 测试商品, three apps. */
export const BIZ = 'test_item';
export const TITLE = '测试商品';
export const TTL_MS = 15 * 60_000;
export const CHANNELS = ['wechat_pay', 'alipay'] as const;
export const OUT_TRADE_NO = /^P[0-9A-Z]{20}$/;

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

// ---------------------------------------------------------------------------------------------
// Database of one test file.

export function suite() {
  let database: TestDatabase | undefined;
  let server: TestRedis | undefined;
  let db: Kysely<DB> | undefined;
  let holder: Kysely<DB> | undefined;
  beforeAll(async () => {
    database = await createTestDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
    holder = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
    server = await acquireTestRedis();
  }, 180_000);
  afterAll(async () => {
    try {
      if (holder) await destroyDb(holder);
    } finally {
      try {
        if (db) await destroyDb(db);
      } finally {
        try {
          await database?.drop();
        } finally {
          await server?.stop();
        }
      }
    }
  }, 30_000);
  return {
    db(): Kysely<DB> {
      expect(db, 'test database').toBeDefined();
      return db!;
    },
    /** A second pool of one connection, for the advisory-lock barrier. */
    holder(): Kysely<DB> {
      expect(holder, 'test database').toBeDefined();
      return holder!;
    },
    redisUrl(): string {
      expect(server, 'test redis').toBeDefined();
      return server!.url;
    },
  };
}
export type Suite = ReturnType<typeof suite>;

export interface Subject {
  readonly app_id: string;
  readonly user_id: string;
}

export async function user(db: Kysely<DB>, appId: string, clock: FixedClock, id = randomUUID()) {
  await db
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: 'synthetic payer',
      avatar: '',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'member',
      register_method: 'synthetic',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  return id;
}

/** One app, one user, a FixedClock and two fresh fake channels; switches stay at their default. */
export async function fixture(s: Suite, instant = NOW) {
  const db = s.db();
  const clock = new FixedClock(instant);
  const appId = `pay_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const subject: Subject = { app_id: appId, user_id: await user(db, appId, clock) };
  const channels: Record<PayChannelCode, FakePayChannel> = {
    wechat_pay: new FakePayChannel('wechat_pay'),
    alipay: new FakePayChannel('alipay'),
  };
  return {
    s,
    db,
    clock,
    subject,
    channels,
    /** Another user of the same app. */
    async stranger(): Promise<Subject> {
      return { app_id: appId, user_id: await user(db, appId, clock) };
    },
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A config_items row (content reads it; set before the app is created: content caches reads). */
export async function setConfig(f: Fixture, key: string, value: unknown) {
  await sql`INSERT INTO config_items (app_id, key, value, updated_by)
    VALUES (${f.subject.app_id}, ${key}, ${JSON.stringify(value)}::jsonb, 'b2-15b-spec')`.execute(
    f.db,
  );
}

/** pay.enabled and the given channel switches on (exactly the JSON boolean true). */
export async function enable(f: Fixture, channels: readonly PayChannelCode[] = CHANNELS) {
  await setConfig(f, 'pay.enabled', true);
  for (const channel of channels) await setConfig(f, `pay.channel_enabled.${channel}`, true);
}

export function payOrders(f: Fixture) {
  return f.db
    .selectFrom('pay_orders')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .orderBy('created_at')
    .orderBy('out_trade_no')
    .execute();
}
export type OrderRow = Awaited<ReturnType<typeof payOrders>>[number];

export async function payOrder(f: Fixture, id: string): Promise<OrderRow> {
  const row = (await payOrders(f)).find((candidate) => candidate.id === id);
  expect(row, `pay_orders ${id}`).toBeDefined();
  return row!;
}

export function attempts(f: Fixture) {
  return f.db
    .selectFrom('pay_query_attempts')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .orderBy('at')
    .orderBy('created_at')
    .execute();
}

/** A pay order written directly (the state another flow would have left). */
export async function seedOrder(
  f: Fixture,
  patch: Partial<Insertable<DB['pay_orders']>> = {},
): Promise<OrderRow> {
  const id = patch.id ?? randomUUID();
  await f.db
    .insertInto('pay_orders')
    .values({
      app_id: f.subject.app_id,
      user_id: f.subject.user_id,
      biz_type: BIZ,
      biz_ref: randomUUID(),
      pay_channel: 'wechat_pay',
      amount_fen: 1n,
      status: 'PENDING',
      out_trade_no: `S${randomBytes(10).toString('hex').toUpperCase()}`,
      expire_at: new Date(f.clock.now().getTime() + TTL_MS),
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
      ...patch,
      id,
    })
    .execute();
  return payOrder(f, id);
}

export interface JobRow {
  readonly job: string | null;
  readonly singleton_key: string | null;
  readonly state: string;
  readonly delay: number;
}

/** Jobs of queue `pay` whose data mentions the pay order (pgboss.job, plain SQL). */
export async function payJobs(f: Fixture, payOrderId: string): Promise<JobRow[]> {
  const result = await sql<JobRow>`
    SELECT data->>'name' AS job, singleton_key, state::text AS state,
      extract(epoch FROM (start_after - created_on))::float8 AS delay
    FROM pgboss.job WHERE name = 'pay' AND data::text LIKE ${`%${payOrderId}%`}
    ORDER BY created_on, id`.execute(f.db);
  return result.rows;
}

/** Ledger rows of the app: payment never posts in these flows (payment/AGENTS.md rule 1). */
export async function ledgerRows(f: Fixture) {
  const result = await sql<{ vouchers: number; entries: number }>`
    SELECT (SELECT count(*)::int FROM ledger_vouchers WHERE app_id = ${f.subject.app_id}) AS vouchers,
      (SELECT count(*)::int FROM ledger_entries WHERE app_id = ${f.subject.app_id}) AS entries`.execute(
    f.db,
  );
  return result.rows[0];
}

// ---------------------------------------------------------------------------------------------
// The pay order as the contract shows it.

const TIMES = ['expire_at', 'paid_at', 'closed_at', 'created_at'] as const;

/** The PayOrder a row must be shown as (instants as epoch milliseconds). */
export function view(row: OrderRow): Record<string, unknown> {
  return {
    pay_order_id: row.id,
    biz_type: row.biz_type,
    biz_ref: row.biz_ref,
    pay_channel: row.pay_channel,
    amount_fen: Number(row.amount_fen),
    refunded_fen: Number(row.refunded_fen),
    status: row.status,
    expire_at: row.expire_at.getTime(),
    paid_at: row.paid_at === null ? null : row.paid_at.getTime(),
    closed_at: row.closed_at === null ? null : row.closed_at.getTime(),
    created_at: row.created_at.getTime(),
  };
}

/** Response data with its date-time strings turned into epoch milliseconds. */
export function normalize(data: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...object(data) };
  for (const key of TIMES) {
    const value = out[key];
    if (typeof value === 'string') out[key] = Date.parse(value);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// HTTP through the real api entry.

export type Op = 'create' | 'get' | 'returned' | 'cancel';
export type Platform = 'ios' | 'android' | 'harmony';
const INSTALL_CHANNEL: Record<Platform, string> = {
  ios: 'appstore',
  android: 'official',
  harmony: 'agc',
};
const ROUTES: Record<Op, { method: 'GET' | 'POST'; path: string; suffix: string }> = {
  create: { method: 'POST', path: '/v1/pay/orders', suffix: '' },
  get: { method: 'GET', path: '/v1/pay/orders/{pay_order_id}', suffix: '' },
  returned: { method: 'POST', path: '/v1/pay/orders/{pay_order_id}/returned', suffix: '/returned' },
  cancel: { method: 'POST', path: '/v1/pay/orders/{pay_order_id}/cancel', suffix: '/cancel' },
};

export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}
export interface Sent {
  readonly op: Op;
  readonly statusCode: number;
  readonly body: string;
  json(): Envelope;
}
export interface SendOptions {
  /** pay_order_id of get / returned / cancel. */
  readonly id?: string;
  /** Request body of create. */
  readonly body?: unknown;
  /** Idempotency-Key of create: a fresh one by default; null sends none. */
  readonly key?: string | null;
  readonly subject?: Subject;
  readonly platform?: Platform;
  /** access (scp full, default), deletion_only (restricted session) or an h5_token. */
  readonly token?: 'access' | 'deletion_only' | 'h5';
  /** POSTs are signed by default; false sends no signature headers. */
  readonly signed?: boolean;
  /** A signature over other bytes. */
  readonly badSign?: boolean;
}
export type Send = (op: Op, options?: SendOptions) => Promise<Sent>;

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    payload?: string;
    headers: Record<string, string>;
  }): Promise<{ statusCode: number; body: string }>;
}
interface Builder {
  overrideProvider(token: unknown): { useValue(value: unknown): Builder };
  compile(): Promise<{ createNestApplication(adapter: unknown, options: unknown): HttpApp }>;
}

/** Runs `run` against a started api entry on the fixture's database, clock and fake channels. */
export async function withHttp(
  f: Fixture,
  run: (send: Send, logs: string[]) => Promise<void>,
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
        redisUrl: ReturnType<typeof redisConnection>['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const deviceId = randomUUID();
  const secret = randomBytes(32).toString('hex');
  const tokens = new Map<string, { subject: Subject; kind: 'access' | 'deletion_only' | 'h5' }>();
  const signature = createSignatureCheck({
    clock: f.clock,
    devices: {
      findActive: async () => ({ appId: f.subject.app_id, deviceId, installSecret: secret }),
    },
    redis: {
      namespace: () => ({
        get: async () => null,
        set: async () => undefined,
        eval: async () => 'OK',
      }),
    },
  });
  const tokenCheck = createTokenCheck({
    tokens: {
      verifyAccess: async (token) => {
        const entry = tokens.get(token);
        if (entry === undefined || entry.kind === 'h5') throw new TokenRejection(10002);
        return {
          uid: entry.subject.user_id,
          app_id: entry.subject.app_id,
          sid: randomUUID(),
          device_id: deviceId,
          scp: entry.kind === 'access' ? 'full' : 'deletion_only',
        };
      },
      verifyH5: async (token) => {
        const entry = tokens.get(token);
        if (entry === undefined || entry.kind !== 'h5') throw new TokenRejection(10002);
        return {
          uid: entry.subject.user_id,
          app_id: entry.subject.app_id,
          sid: randomUUID(),
          device_id: deviceId,
          scp: 'standard',
        };
      },
      issueAccess: async () => 'synthetic-access',
      issueRefresh: () => ({
        token: 'synthetic-refresh',
        hash: 'synthetic-hash',
        expireAt: f.clock.now(),
      }),
    },
    sessions: { find: async () => ({ revoked_at: null }) },
  });
  const channels = { of: (channel: PayChannelCode) => f.channels[channel] };
  const spy = vi.spyOn(NestFactory, 'create').mockImplementation(async (module, adapter, opts) => {
    const builder = Test.createTestingModule({ imports: [module] });
    builder
      .overrideProvider(REQUEST_CHECKS)
      .useValue({ checks: [signature, tokenCheck], bufferWhen: isContractSignedRoute });
    builder.overrideProvider(PayChannelSet).useValue(channels);
    return (await builder.compile()).createNestApplication(adapter, opts);
  });
  const logs: string[] = [];
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('api', {
      config: loadConfig({ APP_ENV: 'test' }),
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
      redisUrl: redisConnection(f.s.redisUrl()).redisUrl,
    });
    await app.init();
    const server = app;
    const send: Send = async (op, options = {}) => {
      const route = ROUTES[op];
      const subject = options.subject ?? f.subject;
      const token = randomUUID();
      tokens.set(token, { subject, kind: options.token ?? 'access' });
      const url =
        op === 'create' ? route.path : `/v1/pay/orders/${options.id ?? ''}${route.suffix}`;
      const raw = options.body === undefined ? '' : JSON.stringify(options.body);
      const platform = options.platform ?? 'android';
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        'x-app-id': subject.app_id,
        'x-device-id': deviceId,
        'x-platform': platform,
        'x-channel': INSTALL_CHANNEL[platform],
        'x-app-version': '2.0.0',
        'x-trace-id': randomUUID(),
      };
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      if (op === 'create' && options.key !== null) {
        headers['idempotency-key'] = options.key ?? randomUUID();
      }
      if (options.signed ?? route.method === 'POST') {
        const timestamp = String(Math.floor(f.clock.now().getTime() / 1000));
        const nonce = randomBytes(16).toString('hex');
        const signedBody = options.badSign === true ? `${raw} ` : raw;
        const message = [
          route.method,
          url,
          timestamp,
          nonce,
          createHash('sha256').update(signedBody).digest('hex'),
        ].join('\n');
        headers['x-timestamp'] = timestamp;
        headers['x-nonce'] = nonce;
        headers['x-sign'] = createHmac('sha256', secret).update(message).digest('hex');
      }
      const response = await server.inject({
        method: route.method,
        url,
        headers,
        ...(options.body === undefined ? {} : { payload: raw }),
      });
      return {
        op,
        statusCode: response.statusCode,
        body: response.body,
        json: () => JSON.parse(response.body) as Envelope,
      };
    };
    await run(send, logs);
  } finally {
    spy.mockRestore();
    await app?.close();
  }
}

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10401: 401,
  10403: 403,
  10405: 403,
  20001: 400,
  20901: 409,
  20902: 409,
  30701: 404,
  30901: 422,
  30902: 409,
  50306: 503,
};

/** The response body conforms to the contract's schema of its operation and status class. */
export async function conforms(sent: Sent) {
  const route = ROUTES[sent.op];
  const op = operation(await contract(), route.method.toLowerCase(), route.path);
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = at(op, 'responses', status, 'content', 'application/json', 'schema');
  check(compile(schema), sent.json(), true);
}

/** Status, code and (when given) exact data, then the contract schema. */
export async function answer(sent: Sent, code: number, data?: unknown): Promise<Envelope> {
  expect(sent.statusCode, `${sent.op}: ${sent.body}`).toBe(HTTP_STATUS[code]);
  const body = sent.json();
  expect(body.code, sent.body).toBe(code);
  if (data !== undefined) expect(body.data, sent.body).toEqual(data);
  await conforms(sent);
  return body;
}

/** The data of a successful response. */
export async function success(sent: Sent): Promise<Record<string, unknown>> {
  return object((await answer(sent, 0)).data);
}

export const conflict = { resource: 'pay_order' } as const;

export function createBody(bizRef: string, payChannel: PayChannelCode, bizType: string = BIZ) {
  return { biz_type: bizType, biz_ref: bizRef, pay_channel: payChannel };
}

// ---------------------------------------------------------------------------------------------
// Advisory-lock barrier of the concurrency tests (task §9.4 lock key; two connections).

export function lockKey(f: Fixture, bizRef: string, bizType: string = BIZ): string {
  return `payment.biz:${f.subject.app_id}:${bizType}:${bizRef}`;
}

/** Holds the business object's advisory lock on the holder connection while `run` goes. */
export async function holdingBizLock<T>(
  f: Fixture,
  key: string,
  run: (release: () => Promise<void>) => Promise<T>,
): Promise<T> {
  return f.s
    .holder()
    .connection()
    .execute(async (connection) => {
      await sql`SELECT pg_advisory_lock(hashtextextended(${key}::text, 0))`.execute(connection);
      let held = true;
      const release = async () => {
        if (!held) return;
        held = false;
        await sql`SELECT pg_advisory_unlock(hashtextextended(${key}::text, 0))`.execute(connection);
      };
      try {
        return await run(release);
      } finally {
        await release();
      }
    });
}

/** Sessions waiting for that advisory lock in this database. */
export async function lockWaiters(f: Fixture, key: string): Promise<number> {
  const result = await sql<{ n: number }>`
    WITH k AS (SELECT hashtextextended(${key}::text, 0) AS v)
    SELECT count(*)::int AS n FROM pg_locks, k
    WHERE pg_locks.locktype = 'advisory' AND NOT pg_locks.granted AND pg_locks.objsubid = 1
      AND pg_locks.classid::text::bigint = ((k.v >> 32) & 4294967295)
      AND pg_locks.objid::text::bigint = (k.v & 4294967295)
      AND pg_locks.database = (SELECT oid FROM pg_database WHERE datname = current_database())`.execute(
    f.db,
  );
  return result.rows[0]?.n ?? 0;
}

export interface Tracked<T> {
  readonly promise: Promise<T>;
  settled: boolean;
}
export function track<T>(promise: Promise<T>): Tracked<T> {
  const tracked: Tracked<T> = { promise, settled: false };
  promise.then(
    () => {
      tracked.settled = true;
    },
    () => {
      tracked.settled = true;
    },
  );
  return tracked;
}

/** True once `n` sessions wait for the lock; false when a request ended first or on timeout. */
export async function untilWaiting(
  f: Fixture,
  key: string,
  n: number,
  pending: readonly Tracked<unknown>[],
  timeoutMs = 15_000,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await lockWaiters(f, key)) >= n) return true;
    if (pending.some((p) => p.settled)) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
