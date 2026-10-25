// B1-27c fixtures: the admin entry over a real test database, FieldCrypto, Redis and admin sessions
// (container runner only). Users, deletion requests, earlier copy requests, admin accounts with
// their permission points and the working-day calendar (config_items) are written straight into
// app.* by the test, so every expected value is derived from what was seeded here. The entry's
// JobQueue is the real one with send spied: each data-copy send records whether it came with a
// transaction and whether the new request was visible inside it and not yet outside.
// Sources: 08 BR-ID-40 细则「截止时刻」「副本请求与注销状态」「企业微信会话交付的下载」「重新登记与登记人停用」;
// contract adminCreateUserDataExport / adminListUserDataExports (CT-24q); task §9 ①–⑤.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Selectable } from 'kysely';
import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import type {
  JobPayload,
  JobQueue,
  SendOptions,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { grant, seed, type Seed } from '../../admin/accounts/kit.ts';
import {
  factory,
  READ,
  signedIn,
  totp,
  type Fixture,
  type Harness,
  type HttpApp,
  type Response,
} from '../../admin/auth/kit.ts';
import { memoryLogger, redisConnection } from '../sms-codes/kit.ts';
import { EXPORTS, validate, type Method } from './schema.ts';

const ROOT = new URL('../../../../', import.meta.url);
export const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
/** 2026-11-02 10:00 +08:00, a Monday (BR-ID-40 细则「例」). */
export const NOW = '2026-11-02T02:00:00.000Z';
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
/** BR-ID-40 细则「例」: 15 working days after Monday 11-02 end on 11-23 (no holiday in November). */
export const DUE_OF_NOW = '2026-11-23T16:00:00.000Z';

export const ACTION = 'user_data_copy_request';
export const PERMISSION = 'user.data_export';
export const PII = 'pii.reveal_phone';
/** The generation job of B1-27h (identity/application/data-copy-worker.ts). */
export const QUEUE = 'data-copy';
export const GENERATE = 'generate';

export const REASON = '企业微信核对注册时间、最近一笔订单号与绑定手机号后四位，确认本人申请副本';
export const WECOM_REASON =
  '手机丢失、旧号已停用无法收短信，App 登不上；企业微信核对证件照片与最近三笔订单后确认本人';
export const PHONE_CONTEXT = 'users.phone';

export type Delivery = 'in_app_sms' | 'wecom_session';
export type CopyStatus =
  'pending' | 'running' | 'ready' | 'delivered' | 'failed' | 'expired' | 'cancelled';
export const OPEN: readonly CopyStatus[] = ['pending', 'running', 'ready'];
export type CopyRow = Selectable<DB['personal_data_copies']>;
export type Body = Record<string, unknown>;

/** A registration's response data (AdminUserDataExportCreateResult). */
export interface Registered {
  export_id: string;
  user_id: string;
  delivery: Delivery;
  status: CopyStatus;
  requested_by: string;
  requested_by_name?: string | null;
  created_at: string;
  due_at: string;
  retry_of: string | null;
  generated_at: string | null;
  delivered_at: string | null;
  expires_at: string | null;
  failure_reason: string | null;
  reused: boolean;
}
export type Listed = Omit<Registered, 'reused'>;
export interface Page {
  items: Listed[];
  page: number;
  page_size: number;
  total: number;
}

/** Both channels work: in_app_sms. */
export const inApp = (extra: Body = {}): Body => ({
  reason: REASON,
  app_login_ok: true,
  phone_sms_ok: true,
  ...extra,
});
/** Neither channel works: wecom_session. */
export const wecom = (extra: Body = {}): Body => ({
  reason: WECOM_REASON,
  app_login_ok: false,
  phone_sms_ok: false,
  ...extra,
});

/** Instant `ms` after `base` (default NOW). */
export const at = (offset: number, base: string = NOW) => new Date(Date.parse(base) + offset);
/** A response timestamp (any contract-valid offset spelling) as epoch milliseconds. */
export const ms = (value: string | Date | null | undefined) =>
  value === null || value === undefined ? null : new Date(value).getTime();

// ---------------------------------------------------------------- the admin entry

interface Inject {
  method: 'POST' | 'GET';
  url: string;
  headers: Record<string, string>;
  payload?: string;
  remoteAddress?: string;
}
interface RouteApp {
  inject(request: Inject): Promise<Response>;
  getHttpAdapter(): {
    getInstance(): { hasRoute(options: { method: string; url: string }): boolean };
  };
}
const routeApp = (app: HttpApp) => app as unknown as RouteApp;

export function mounted(app: HttpApp, method: 'POST' | 'GET'): boolean {
  return routeApp(app)
    .getHttpAdapter()
    .getInstance()
    .hasRoute({ method, url: EXPORTS.replace('{user_id}', ':user_id') });
}

/** One send of the generation queue as the entry made it. */
export interface SentJob {
  readonly queue: string;
  readonly name: string;
  readonly payload: JobPayload;
  readonly inTransaction: boolean;
  /** The request named by payload.copyId, read on the send's transaction (null: none there). */
  readonly insideStatus: string | null;
  /** The same request read outside that transaction at the moment of the send. */
  readonly visibleOutside: boolean;
}

export interface SetupOptions {
  /** The entry's fixed clock (default NOW). */
  now?: string;
}

export async function setup(h: Harness, options: SetupOptions = {}) {
  const clock = new FixedClock(options.now ?? NOW);
  const { logger, lines } = memoryLogger();
  const overrides = {
    config: loadConfig(h.env),
    clock,
    logger,
    dbHandles: { db: h.db, dbRead: null, close: async () => undefined },
    redisUrl: redisConnection(h.redis.url).redisUrl,
  };
  const app = await (await factory())('admin', overrides);
  h.apps.push(app);
  await expect(app.init()).resolves.toBeDefined();
  const post = (
    suffix: string,
    payload: Record<string, unknown> = {},
    headers: Record<string, string> = {},
    ip = '127.0.0.1',
  ) =>
    app.inject({
      method: 'POST',
      url: `/admin/v1/auth${suffix}`,
      payload: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', ...headers },
      remoteAddress: ip,
    });
  const read = (
    token: string,
    url = READ,
    headers: Record<string, string> = {},
    ip = '127.0.0.1',
  ) =>
    app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}`, ...headers },
      remoteAddress: ip,
    });
  const f: Fixture = {
    app,
    clock,
    lines,
    overrides,
    post,
    read,
    closeRedis: async () => undefined,
  };
  // Every integration case is red before the routes exist, negative cases included.
  expect(
    mounted(app, 'POST'),
    'admin 入口必须挂载 POST /admin/v1/users/{user_id}/data-exports',
  ).toBe(true);
  expect(mounted(app, 'GET'), 'admin 入口必须挂载 GET /admin/v1/users/{user_id}/data-exports').toBe(
    true,
  );

  const { JOB_QUEUE } = (await import(
    new URL('apps/api/src/modules/platform/platform.module.ts', ROOT).href
  )) as { JOB_QUEUE: symbol };
  const queue = app.get<JobQueue>(JOB_QUEUE);
  const realSend = queue.send.bind(queue);
  const sent: SentJob[] = [];
  /** failNext: the next data-copy send is really made, then throws (the caller must roll back). */
  const control = { failNext: false };
  vi.spyOn(queue, 'send').mockImplementation(
    async (name: string, job: string, payload: JobPayload, sendOptions: SendOptions) => {
      if (name === QUEUE && control.failNext) {
        control.failNext = false;
        await realSend(name, job, payload, sendOptions);
        throw new Error('synthetic enqueue failure');
      }
      if (name === QUEUE) {
        const copyId = typeof payload['copyId'] === 'string' ? payload['copyId'] : '';
        const inside =
          sendOptions.trx === null
            ? undefined
            : await sendOptions.trx
                .withSchema('app')
                .selectFrom('personal_data_copies')
                .select('status')
                .where('id', '=', copyId)
                .executeTakeFirst();
        const outside = await h.db
          .selectFrom('personal_data_copies')
          .select('id')
          .where('id', '=', copyId)
          .executeTakeFirst();
        sent.push({
          queue: name,
          name: job,
          payload,
          inTransaction: sendOptions.trx !== null && sendOptions.trx.isTransaction,
          insideStatus: inside?.status ?? null,
          visibleOutside: outside !== undefined,
        });
      }
      return realSend(name, job, payload, sendOptions);
    },
  );

  const appId = `rg_${randomBytes(8).toString('hex')}`;
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  logger.info({ event: 'admin_data_copies_test_capture_ready' }, 'capture ready');
  return { ...f, h, appId, actor, token: session.admin_token, sent, control };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

/** A signed-in non-super admin of the same app holding exactly `permissions`. */
export async function member(s: Setup, permissions: readonly string[]) {
  const who = await seed(s.h, s.appId);
  if (permissions.length !== 0) await grant(s.h, who, s.actor, permissions);
  const session = await signedIn(s, who);
  return { who, token: session.admin_token };
}
export type Member = Awaited<ReturnType<typeof member>>;

/** A signed-in super admin of the same app (no explicit permission points). */
export async function superAdmin(s: Setup): Promise<Member> {
  const who = await seed(s.h, s.appId, { isSuper: true });
  const session = await signedIn(s, who);
  return { who, token: session.admin_token };
}

/** An admin account that only appears as an earlier registrant (never signs in here). */
export async function registrant(
  s: Setup,
  options: {
    permissions?: readonly string[] | undefined;
    status?: 'active' | 'disabled' | undefined;
    isSuper?: boolean | undefined;
    displayName?: string | null | undefined;
  } = {},
): Promise<Seed> {
  const who = await seed(s.h, s.appId, {
    isSuper: options.isSuper ?? false,
    status: options.status ?? 'active',
  });
  const permissions = options.permissions ?? [PERMISSION, PII];
  if (permissions.length !== 0) await grant(s.h, who, s.actor, permissions);
  if (options.displayName !== undefined) {
    await s.h.db
      .updateTable('admin_users')
      .set({ display_name: options.displayName })
      .where('app_id', '=', s.appId)
      .where('id', '=', who.id)
      .execute();
  }
  return who;
}

/** A fresh totp-tier step-up token of `who`. */
export async function stepUp(s: Setup, who: Seed = s.actor, token = s.token): Promise<string> {
  s.clock.advanceMs(30_000);
  const response = await s.post(
    '/step-up',
    { tier: 'totp', code: totp(who.secret, s.clock) },
    { authorization: `Bearer ${token}` },
  );
  expect(response.statusCode).toBe(200);
  const data = response.json<{ data: { step_up_token: string } }>().data;
  expect(typeof data.step_up_token).toBe('string');
  return data.step_up_token;
}

export interface CallOptions {
  /** The admin calling (default: the super admin of setup). */
  as?: Member;
  /** undefined: a fresh valid totp token of the admin; null: no X-Step-Up-Token. */
  stepUp?: string | null;
}

/** POST /admin/v1/users/{user_id}/data-exports with `payload` as JSON. */
export async function register(
  s: Setup,
  userId: string,
  payload: Body = inApp(),
  options: CallOptions = {},
) {
  const who = options.as?.who ?? s.actor;
  const token = options.as?.token ?? s.token;
  const step = options.stepUp === undefined ? await stepUp(s, who, token) : options.stepUp;
  return routeApp(s.app).inject({
    method: 'POST',
    url: EXPORTS.replace('{user_id}', encodeURIComponent(userId)),
    headers: {
      'content-type': 'application/json',
      'x-trace-id': TRACE,
      authorization: `Bearer ${token}`,
      ...(step === null ? {} : { 'x-step-up-token': step }),
    },
    payload: JSON.stringify(payload),
    remoteAddress: '127.0.0.1',
  });
}

/** GET /admin/v1/users/{user_id}/data-exports`query` (no step-up token). */
export function list(s: Setup, userId: string, query = '', options: { as?: Member } = {}) {
  const token = options.as?.token ?? s.token;
  return routeApp(s.app).inject({
    method: 'GET',
    url: `${EXPORTS.replace('{user_id}', encodeURIComponent(userId))}${query}`,
    headers: { 'x-trace-id': TRACE, authorization: `Bearer ${token}` },
    remoteAddress: '127.0.0.1',
  });
}

/** A 200 registration: the contract envelope and its 200 schema; returns data. */
export async function ok(response: Response): Promise<Registered> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, msg: '', trace_id: TRACE });
  await validate(response, 'post');
  return response.json<{ data: Registered }>().data;
}

/** A 200 list page: the contract envelope and its 200 schema; returns data. */
export async function listed(response: Response): Promise<Page> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, msg: '', trace_id: TRACE });
  await validate(response, 'get');
  return response.json<{ data: Page }>().data;
}

/** contracts/error-codes.yaml statuses of the codes these operations answer. */
const STATUS: Readonly<Record<number, number>> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  30419: 422,
};

/** A refusal: code, HTTP status and, when given, the exact data. */
export async function rejected(
  response: Response,
  code: number,
  data?: object,
  method: Method = 'post',
) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(STATUS[code]);
  expect(response.json()).toMatchObject({ code, trace_id: TRACE });
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response, method);
}

// ---------------------------------------------------------------- seeds

let serial = randomInt(10_000);
/** An obviously synthetic mainland mobile number of the 199 0000 test range. */
export function testPhone(): string {
  serial = (serial + 1) % 10_000;
  return `1990000${String(serial).padStart(4, '0')}`;
}

export interface UserOptions {
  /** undefined: a bound test phone; null: no bound phone. */
  phone?: string | null;
  status?: 'normal' | 'deleting' | 'deleted';
  /** Another app (default: the setup's). */
  appId?: string;
}

export async function user(s: Setup, options: UserOptions = {}) {
  const id = randomUUID();
  const appId = options.appId ?? s.appId;
  const phone = options.phone === undefined ? testPhone() : options.phone;
  const status = options.status ?? 'normal';
  await s.h.db
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: `会员${randomBytes(3).toString('hex')}`,
      avatar: 'avatar:default',
      phone_cipher:
        phone === null ? null : Buffer.from(s.h.fields.encrypt(phone, PHONE_CONTEXT), 'utf8'),
      phone_hmac: phone === null ? null : s.h.fields.blindIndex(phone, PHONE_CONTEXT),
      invite_code: id.replaceAll('-', ''),
      attr_code: `a-${id}`,
      level: 'L1',
      status,
      deleted_reason: status === 'deleted' ? 'user_request' : null,
      register_method: phone === null ? 'wechat' : 'phone',
      registered_channel: 'test',
    })
    .execute();
  return { id, appId, phone };
}
export type User = Awaited<ReturnType<typeof user>>;

/** A deletion request of `target` in `status` (BR-ID-27), consistent with the setup's clock. */
export async function deletion(s: Setup, target: User, status: 'cooling' | 'processing' | 'done') {
  const now = s.clock.now().getTime();
  const applied = status === 'cooling' ? now - DAY_MS : now - 20 * DAY_MS;
  await s.h.db
    .insertInto('deletion_requests')
    .values({
      id: randomUUID(),
      app_id: target.appId,
      user_id: target.id,
      status,
      apply_at: new Date(applied),
      cooling_until: new Date(applied + 7 * DAY_MS),
      processed_at: status === 'done' ? new Date(applied + 8 * DAY_MS) : null,
      balance_snapshot_fen: 0n,
    })
    .execute();
}

export interface CopySeed {
  readonly requestedBy: string;
  readonly delivery?: Delivery;
  readonly status?: CopyStatus;
  readonly retryOf?: string | null;
  readonly dueAt?: Date;
  readonly createdAt?: Date;
  readonly generatedAt?: Date | null;
  readonly deliveredAt?: Date | null;
  readonly expiresAt?: Date | null;
  readonly failureReason?: string | null;
  readonly objectKey?: string | null;
}

/**
 * A copy request of `target` written directly (synthetic fixture), read back. Status-dependent
 * columns default to values consistent with the status: ready / delivered / expired have a file
 * generated an hour before created_at + 1 h, delivered has delivered_at (expired keeps delivered_at
 * only when given), failed has a failure_reason.
 */
export async function copy(s: Setup, target: User, spec: CopySeed): Promise<CopyRow> {
  const status = spec.status ?? 'pending';
  const createdAt = spec.createdAt ?? at(-3 * DAY_MS, s.clock.now().toISOString());
  const generated = ['ready', 'delivered', 'expired'].includes(status)
    ? new Date(createdAt.getTime() + HOUR_MS)
    : null;
  const generatedAt = spec.generatedAt === undefined ? generated : spec.generatedAt;
  const expiresAt =
    spec.expiresAt === undefined
      ? generatedAt === null
        ? null
        : new Date(generatedAt.getTime() + DAY_MS)
      : spec.expiresAt;
  const delivered = status === 'delivered' ? generatedAt : null;
  const deliveredAt = spec.deliveredAt === undefined ? delivered : spec.deliveredAt;
  const objectKey =
    spec.objectKey === undefined
      ? status === 'ready' || status === 'delivered'
        ? `data-copies/${s.appId}/${randomUUID()}/seed.zip`
        : null
      : spec.objectKey;
  return s.h.db
    .insertInto('personal_data_copies')
    .values({
      id: randomUUID(),
      app_id: target.appId,
      user_id: target.id,
      requested_by: spec.requestedBy,
      delivery: spec.delivery ?? 'in_app_sms',
      status,
      retry_of: spec.retryOf ?? null,
      object_key: objectKey,
      due_at: spec.dueAt ?? new Date(Date.parse('2026-11-20T16:00:00.000Z')),
      generated_at: generatedAt,
      delivered_at: deliveredAt,
      expires_at: expiresAt,
      failure_reason:
        spec.failureReason === undefined
          ? status === 'failed'
            ? '副本文件生成失败，请重新登记'
            : null
          : spec.failureReason,
      created_at: createdAt,
      updated_at: createdAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Working-day calendar of `year` for the setup's app (calendar.cn_holidays / cn_makeup_workdays). */
export async function calendar(
  s: Setup,
  year: number,
  holidays: readonly string[],
  makeupWorkdays: readonly string[],
) {
  await s.h.db
    .insertInto('config_items')
    .values([
      {
        app_id: s.appId,
        key: `calendar.cn_holidays.${year}`,
        value: JSON.stringify(holidays),
        updated_by: 'b1-27c',
      },
      {
        app_id: s.appId,
        key: `calendar.cn_makeup_workdays.${year}`,
        value: JSON.stringify(makeupWorkdays),
        updated_by: 'b1-27c',
      },
    ])
    .execute();
}

// ---------------------------------------------------------------- reads

export const copiesOf = (s: Setup, target: User) =>
  s.h.db
    .selectFrom('personal_data_copies')
    .selectAll()
    .where('app_id', '=', target.appId)
    .where('user_id', '=', target.id)
    .orderBy('created_at')
    .orderBy('id')
    .execute();

export const copyRow = (s: Setup, id: string) =>
  s.h.db
    .selectFrom('personal_data_copies')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

export const audits = (s: Setup) =>
  s.h.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', s.appId)
    .where('action', '=', ACTION)
    .orderBy('id')
    .execute();
export type AuditRow = Awaited<ReturnType<typeof audits>>[number];

/** Every audit row of the app (any action). */
export const allAudits = (s: Setup) =>
  s.h.db.selectFrom('audit_logs').selectAll().where('app_id', '=', s.appId).orderBy('id').execute();

/** The audit rows added after `before`. */
export function added(before: readonly AuditRow[], after: readonly AuditRow[]): AuditRow[] {
  return after.filter((entry) => !before.some((old) => old.id === entry.id));
}

/** A row as text (bigint ids and byte strings included), for containment checks. */
export function rowText(entry: unknown): string {
  return JSON.stringify(entry, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/** The data-copy sends of this test. */
export const jobs = (s: Setup) => s.sent.filter((job) => job.queue === QUEUE);

/** data-copy jobs of the setup's app that really are in the queue's table. */
export async function queuedJobs(s: Setup): Promise<number> {
  const { rows } = await sql<{ n: string }>`select count(*)::text as n from pgboss.job
    where name = ${QUEUE} and data::text like ${`%${s.appId}%`}`.execute(s.h.db);
  return Number(rows[0]?.n ?? '0');
}

/** The two channel facts of a registration. */
export interface Channels {
  readonly app: boolean;
  readonly sms: boolean;
}
/** The channel facts a registration body states. */
export const channelsOf = (payload: Body): Channels => ({
  app: payload['app_login_ok'] === true,
  sms: payload['phone_sms_ok'] === true,
});

/** Every boolean leaf of a JSON value by path ('true' / 'false' strings count as booleans). */
export function booleanLeaves(
  value: unknown,
  path = '$',
  out: Map<string, boolean> = new Map(),
): Map<string, boolean> {
  if (typeof value === 'boolean') out.set(path, value);
  else if (value === 'true' || value === 'false') out.set(path, value === 'true');
  else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) booleanLeaves(item, `${path}[${index}]`, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) booleanLeaves(child, `${path}.${key}`, out);
  }
  return out;
}

/**
 * The two channel facts can be read back from the audit records: one leaf (same path in every
 * record) holds the App fact and another the SMS fact of each record. Key names are the
 * implementation's; a fact whose value was redacted away does not count.
 */
export function expectChannelsRecorded(
  records: readonly { row: AuditRow | undefined; channels: Channels }[],
) {
  const leaves = records.map(({ row }) =>
    booleanLeaves({ target: row?.target, before: row?.before, after: row?.after }),
  );
  const holding = (pick: (channels: Channels) => boolean) =>
    [...(leaves[0]?.keys() ?? [])].filter((path) =>
      records.every((record, index) => leaves[index]?.get(path) === pick(record.channels)),
    );
  const appPaths = holding((channels) => channels.app);
  const smsPaths = holding((channels) => channels.sms);
  const wanted = JSON.stringify(records.map((record) => record.channels));
  const found = JSON.stringify(leaves.map((map) => Object.fromEntries(map)));
  expect(
    appPaths.some((app) => smsPaths.some((sms) => sms !== app)),
    `审计必须能还原两项通道情况 ${wanted}；审计里的真假值：${found}`,
  ).toBe(true);
}

/**
 * One audit record of a registration (contract: admin, user, reason, the two channel facts and the
 * result — the created / reused request's id, or the refusal code).
 */
export function expectRequestAudit(
  s: Setup,
  row: AuditRow | undefined,
  expected: {
    admin: string;
    user: User;
    reason: string;
    channels: Channels;
    contains: readonly string[];
  },
) {
  expect(row, '必须写一条 user_data_copy_request 审计').toBeDefined();
  expect(row).toMatchObject({ app_id: s.appId, admin_id: expected.admin, action: ACTION });
  const text = rowText(row);
  expect(text).toContain(expected.user.id);
  expect(text).toContain(expected.reason);
  expectChannelsRecorded([{ row, channels: expected.channels }]);
  for (const value of expected.contains) expect(text).toContain(value);
}

/**
 * 24:00 (+08:00) of the `n`th weekday (Monday–Friday) after the +08:00 civil date of `from`, the
 * deadline when the calendar has no holiday or make-up day in the range (independent of the code).
 */
export function weekdayDeadline(from: Date, n = 15): Date {
  const offset = 8 * HOUR_MS;
  const local = new Date(from.getTime() + offset);
  let day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  let counted = 0;
  while (counted < n) {
    day += DAY_MS;
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6) counted += 1;
  }
  return new Date(day + DAY_MS - offset);
}
