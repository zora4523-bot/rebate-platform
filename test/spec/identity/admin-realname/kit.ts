// B1-27a fixtures: real database, FieldCrypto, Redis and admin sessions (container runner only).
// Users, real names, withdrawals, payout accounts, deletion requests and blocklist entries are
// written straight into app.* by the test, so every expected value is derived from what was seeded
// here. Only the two-element vendor is replaced (createRealnameVerifier, as the self-service
// real-name tests do), and the statements the entry runs are observed: app.realname_prior_identities
// is INSERT-only for every runtime role (B1-27d), so the inserts into it are read from the SQL the
// application sends, and counted only once PostgreSQL answered them. Sources: 08 BR-ID-25 细则「实名
// 更正」, BR-ID-26, BR-ID-31, BR-ID-33; contract adminCorrectUserRealname (CT-24q); task §9.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type KyselyPlugin } from 'kysely';
import { expect, vi } from 'vitest';
import type * as Verifier from '../../../../apps/api/src/modules/identity/infra/fake-realname-verifier.ts';
import type {
  RealnameVerificationInput,
  RealnameVerificationResult,
} from '../../../../apps/api/src/modules/identity/ports/realname-verifier.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  loadConfig,
  PRIOR_IDENTITY_FIELD_CRYPTO,
} from '../../../../apps/api/src/modules/platform/config/index.ts';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { grant, seed, type Seed } from '../../admin/accounts/kit.ts';
import {
  factory,
  NOW,
  READ,
  signedIn,
  totp,
  type Fixture,
  type Harness,
  type HttpApp,
  type Response,
} from '../../admin/auth/kit.ts';
import { memoryLogger, redisConnection } from '../sms-codes/kit.ts';
import { CORRECTION, validate } from './schema.ts';

const ROOT = new URL('../../../../', import.meta.url);
export const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const REASON = '企业微信核对注册手机号、最近一笔订单号与证件照片后，按用户本人身份更正';
export const ACTION = 'user_realname_correct';
export const PERMISSION = 'user.realname_fix';
export const PROVIDER = 'test-two-elements';
export const EVENT = 'user.realname_corrected';
/** FieldCrypto contexts of the realname columns (identity/infra/realname-reader.ts). */
export const REALNAME = {
  name: 'realname.name',
  idNo: 'realname.id_no',
  birthDate: 'realname.birth_date',
} as const;
/**
 * Contexts of the prior identity cipher (B1-27e §6: they start with `prior_identity.`; fixed by
 * this task's skeleton, infra/realname-prior-identities.ts).
 */
export const PRIOR = { name: 'prior_identity.name', idNo: 'prior_identity.id_no' } as const;
/** risk's blocklist context of the id_no dimension (risk/application/blocklist.ts). */
const BLOCKLIST_ID_NO = 'blocklist.id_no';
/** BR-WDR-08: the terminal states; anything else is in progress. */
export const OPEN = ['PENDING_REVIEW', 'APPROVED', 'PAYING'] as const;
export const CLOSED = ['REJECTED', 'PAID_API', 'PAID_MANUAL', 'FAILED'] as const;
export type WithdrawalStatus = (typeof OPEN)[number] | (typeof CLOSED)[number];

export type Realname = {
  user_id: string;
  realname_status: 'verified';
  masked_name: string;
  masked_id_no: string;
  verified_at: string;
};
export type Body = Record<string, unknown>;

// ---------------------------------------------------------------- identities

/** An 18-digit resident ID number with a valid GB 11643 check digit. */
export function residentId(region: string, birth: string, serial = '002'): string {
  const prefix = `${region}${birth.replaceAll('-', '')}${serial}`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = [...prefix].reduce((n, char, i) => n + Number(char) * weights[i]!, 0);
  return prefix + '10X98765432'[sum % 11]!;
}
/** The same number with another (so wrong) check digit. */
export function wrongCheckDigit(idNo: string): string {
  const last = idNo.slice(-1);
  return idNo.slice(0, 17) + (last === '0' ? '1' : '0');
}

export interface Identity {
  readonly name: string;
  readonly idNo: string;
  readonly birth: string;
}
export function identity(name: string, region: string, birth: string, serial = '002'): Identity {
  return { name, idNo: residentId(region, birth, serial), birth };
}
/** The identity the user verified with first (a relative's), starting with 1. */
export const OLD = identity('欧阳小明', '110105', '1968-03-12', '017');
/** The user's own identity customer service corrects to, starting with 4. */
export const NEW = identity('林小雨', '440305', '1996-07-21', '028');
/** A third person, starting with 3. */
export const OTHER = identity('周一鸣', '310104', '1988-11-02', '035');
/** 13 years old at NOW (BR-ID-26: under the minimum real-name age 14). */
export const MINOR = identity('林小禾', '440305', '2013-05-04', '046');

/** BR-ID-33: n − 1 "*" and the last character. */
export const maskName = (name: string) => '*'.repeat([...name].length - 1) + [...name].at(-1)!;
/** BR-ID-33: first and last character of an 18-digit ID number. */
export const maskIdNo = (idNo: string) => `${idNo[0]!}${'*'.repeat(16)}${idNo.slice(-1)}`;
export const hmacOf = (h: Harness, idNo: string) => h.fields.blindIndex(idNo, REALNAME.idNo);

/** The body of a correction to `who` (default: the user's own identity). */
export function body(who: Identity = NEW, extra: Body = {}): Body {
  return { name: who.name, id_no: who.idNo, reason: REASON, ...extra };
}

// ---------------------------------------------------------------- the admin entry

interface Inject {
  method: 'POST' | 'GET';
  url: string;
  headers: Record<string, string>;
  payload?: string;
  remoteAddress?: string;
}
interface PostApp {
  inject(request: Inject): Promise<Response>;
  getHttpAdapter(): {
    getInstance(): { hasRoute(options: { method: string; url: string }): boolean };
  };
}
const postApp = (app: HttpApp) => app as unknown as PostApp;

export function mounted(app: HttpApp): boolean {
  return postApp(app)
    .getHttpAdapter()
    .getInstance()
    .hasRoute({ method: 'POST', url: CORRECTION.replace('{user_id}', ':user_id') });
}

/** One INSERT into app.realname_prior_identities the entry sent; `done` once it succeeded. */
export interface PriorInsert {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  done: boolean;
}

function observePriorInserts(h: Harness) {
  const inserts: PriorInsert[] = [];
  const pending = new Map<object, PriorInsert>();
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      const compiled = h.db.getExecutor().compileQuery(node, queryId);
      const text = compiled.sql.replaceAll('"', '');
      if (/\binsert\s+into\s+(?:app\.)?realname_prior_identities\b/i.test(text)) {
        const entry: PriorInsert = { sql: text, parameters: compiled.parameters, done: false };
        inserts.push(entry);
        pending.set(queryId, entry);
      }
      return node;
    },
    async transformResult({ result, queryId }) {
      const entry = pending.get(queryId);
      pending.delete(queryId);
      if (entry !== undefined) entry.done = true;
      return result;
    },
  };
  return { plugin, inserts };
}

export interface SetupOptions {
  /** createRealnameVerifier assembles no vendor (staging / prod today). */
  verifierAbsent?: boolean;
}

export async function setup(h: Harness, options: SetupOptions = {}) {
  const verifiers = (await import(
    new URL('apps/api/src/modules/identity/infra/fake-realname-verifier.ts', ROOT).href
  )) as typeof Verifier;
  const vendor = vi
    .fn<(input: RealnameVerificationInput) => Promise<RealnameVerificationResult>>()
    .mockResolvedValue({ outcome: 'match', provider: PROVIDER });
  const spy = vi
    .spyOn(verifiers, 'createRealnameVerifier')
    .mockImplementation(() => (options.verifierAbsent === true ? null : { verify: vendor }));
  const observed = observePriorInserts(h);
  const clock = new FixedClock(NOW);
  const { logger, lines } = memoryLogger();
  const overrides = {
    config: loadConfig(h.env),
    clock,
    logger,
    dbHandles: { db: h.db.withPlugin(observed.plugin), dbRead: null, close: async () => undefined },
    redisUrl: redisConnection(h.redis.url).redisUrl,
  };
  // The vendor is assembled while the entry starts; the spy ends once it has.
  const boot = async (): Promise<HttpApp> => {
    try {
      const created = await (await factory())('admin', overrides);
      h.apps.push(created);
      await expect(created.init()).resolves.toBeDefined();
      return created;
    } finally {
      spy.mockRestore();
    }
  };
  const app = await boot();
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
  // Every integration case is red before the route exists, negative cases included.
  expect(
    mounted(app),
    'admin 入口必须挂载 POST /admin/v1/users/{user_id}/realname-correction',
  ).toBe(true);
  const appId = `b1-27a-${randomUUID()}`;
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  logger.info({ event: 'admin_realname_test_capture_ready' }, 'capture ready');
  return {
    ...f,
    h,
    appId,
    actor,
    token: session.admin_token,
    vendor,
    prior: observed.inserts,
    priorCrypto: app.get<FieldCrypto>(PRIOR_IDENTITY_FIELD_CRYPTO),
  };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

/** A non-super admin of the same app holding exactly `permissions`. */
export async function member(s: Setup, permissions: readonly string[]) {
  const who = await seed(s.h, s.appId);
  if (permissions.length !== 0) await grant(s.h, who, s.actor, permissions);
  const session = await signedIn(s, who);
  return { who, token: session.admin_token };
}
export type Member = Awaited<ReturnType<typeof member>>;

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

export interface CorrectOptions {
  /** The admin submitting (default: the super admin of setup). */
  as?: Member;
  /** undefined: a fresh valid totp token of the admin; null: no X-Step-Up-Token. */
  stepUp?: string | null;
}

/** POST /admin/v1/users/{user_id}/realname-correction with `payload` as JSON. */
export async function correct(
  s: Setup,
  userId: string,
  payload: Body = body(),
  options: CorrectOptions = {},
) {
  const who = options.as?.who ?? s.actor;
  const token = options.as?.token ?? s.token;
  const step = options.stepUp === undefined ? await stepUp(s, who, token) : options.stepUp;
  return postApp(s.app).inject({
    method: 'POST',
    url: CORRECTION.replace('{user_id}', encodeURIComponent(userId)),
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

/** A 200 correction: the contract envelope and its 200 schema; returns data. */
export async function ok(response: Response): Promise<Realname> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, msg: '', trace_id: TRACE });
  await validate(response);
  return response.json<{ data: Realname }>().data;
}

/** contracts/error-codes.yaml statuses of the codes this operation answers. */
const STATUS: Readonly<Record<number, number>> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  30405: 422,
  30406: 422,
  30407: 422,
  30419: 422,
  44001: 403,
  50301: 503,
  50401: 504,
};

/** A refusal: code, HTTP status and, when given, the exact data. */
export async function rejected(response: Response, code: number, data?: object) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(STATUS[code]);
  expect(response.json()).toMatchObject({ code, trace_id: TRACE });
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response);
}

// ---------------------------------------------------------------- seeds

export async function user(
  h: Harness,
  appId: string,
  status: 'normal' | 'deleting' | 'deleted' = 'normal',
) {
  const id = randomUUID();
  await h.db
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: `会员${randomBytes(3).toString('hex')}`,
      avatar: 'avatar:default',
      invite_code: id.replaceAll('-', ''),
      attr_code: `a-${id}`,
      level: 'L1',
      status,
      deleted_reason: status === 'deleted' ? 'user_request' : null,
      register_method: 'wechat',
      registered_channel: 'test',
    })
    .execute();
  return { id, appId };
}
export type User = Awaited<ReturnType<typeof user>>;

const cipher = (h: Harness, value: string, context: string) =>
  Buffer.from(h.fields.encrypt(value, context), 'utf8');

/** A verified real name of `target` (verified 200 days before NOW unless `at` is given). */
export async function verified(
  h: Harness,
  target: User,
  who: Identity = OLD,
  at = new Date(new Date(NOW).getTime() - 200 * 86_400_000),
) {
  const id = randomUUID();
  const hmac = hmacOf(h, who.idNo);
  await h.db
    .insertInto('realname')
    .values({
      id,
      app_id: target.appId,
      user_id: target.id,
      status: 'verified',
      name_cipher: cipher(h, who.name, REALNAME.name),
      id_no_cipher: cipher(h, who.idNo, REALNAME.idNo),
      id_no_hmac: hmac,
      birth_date_cipher: cipher(h, who.birth, REALNAME.birthDate),
      provider: 'earlier-two-elements',
      verified_at: at,
    })
    .execute();
  return { id, hmac, verifiedAt: at, who };
}
export type Verified = Awaited<ReturnType<typeof verified>>;

/** A real-name row without a verified record (E27: failed, no ciphertext). */
export async function failedRealname(h: Harness, target: User) {
  await h.db
    .insertInto('realname')
    .values({
      id: randomUUID(),
      app_id: target.appId,
      user_id: target.id,
      status: 'failed',
      provider: 'earlier-two-elements',
    })
    .execute();
}

/** A withdrawal of `target` already in `status` (seed only, no ledger). */
export async function withdrawal(
  db: Kysely<DB>,
  clock: FixedClock,
  target: User,
  status: WithdrawalStatus,
) {
  const id = randomUUID();
  const paid = status === 'PAID_API' || status === 'PAID_MANUAL';
  await db
    .insertInto('withdrawals')
    .values({
      id,
      app_id: target.appId,
      user_id: target.id,
      amount_fen: 1000n,
      fee_fen: 0n,
      tax_fen: 0n,
      net_fen: 1000n,
      income_type: 'SERVICE_FEE',
      payout_method: 'alipay',
      payout_channel: 'alipay',
      payee_name: '合成收款人',
      payee_account_cipher: Buffer.from('synthetic-payee'),
      payee_hmac: randomBytes(32).toString('hex'),
      status,
      out_biz_no: id.replaceAll('-', ''),
      reject_reason_code: status === 'REJECTED' ? 'USER_REQUEST' : null,
      paid_at: paid ? clock.now() : null,
      manual_entry_by: status === 'PAID_MANUAL' ? randomUUID() : null,
      manual_confirm_by: status === 'PAID_MANUAL' ? randomUUID() : null,
    })
    .execute();
  return id;
}

/** A bound payout account of `target` (current or an earlier one). */
export async function payoutAccount(
  h: Harness,
  target: User,
  method: 'alipay' | 'bank_card',
  current: boolean,
  payee = OLD.name,
) {
  const id = randomUUID();
  const hmac = randomBytes(32).toString('hex');
  await h.db
    .insertInto('payout_accounts')
    .values({
      id,
      app_id: target.appId,
      user_id: target.id,
      payout_method: method,
      alipay_logon_id_cipher: method === 'alipay' ? Buffer.from('synthetic-logon') : null,
      alipay_hmac: method === 'alipay' ? hmac : null,
      bank_card_no_cipher: method === 'bank_card' ? Buffer.from('synthetic-card') : null,
      bank_card_hmac: method === 'bank_card' ? hmac : null,
      bank_name: method === 'bank_card' ? '合成银行' : null,
      card_bin: method === 'bank_card' ? '622202' : null,
      payee_name: payee,
      is_current: current,
    })
    .execute();
  return id;
}

/** A deletion request of `target` in `status` (BR-ID-27), consistent with NOW. */
export async function deletion(
  h: Harness,
  target: User,
  status: 'cooling' | 'processing' | 'done',
) {
  const day = 86_400_000;
  const now = new Date(NOW).getTime();
  const applied = status === 'cooling' ? now - day : now - 20 * day;
  await h.db
    .insertInto('deletion_requests')
    .values({
      id: randomUUID(),
      app_id: target.appId,
      user_id: target.id,
      status,
      apply_at: new Date(applied),
      cooling_until: new Date(applied + 7 * day),
      processed_at: status === 'done' ? new Date(applied + 8 * day) : null,
      balance_snapshot_fen: 0n,
    })
    .execute();
}

/**
 * An active id_no blocklist entry of the app (BR-ID-31 ID-number dimension). Entries are written
 * under both digests the code base uses for this dimension today — realname.id_no_hmac, which the
 * withdrawal check compares (risk/ports/blocklist-match.ts), and risk's own blocklist context — so
 * the case does not depend on which of the two the implementation matches.
 */
export async function blacklisted(h: Harness, appId: string, idNo: string) {
  for (const value of [hmacOf(h, idNo), h.fields.blindIndex(idNo, BLOCKLIST_ID_NO)]) {
    await h.db
      .insertInto('blocklist')
      .values({
        id: randomUUID(),
        app_id: appId,
        dimension: 'id_no',
        value_hmac: value,
        violation_type: 'other',
        status: 'active',
        created_by: 'b1-27a',
        expire_at: new Date(new Date(NOW).getTime() + 365 * 86_400_000),
      })
      .execute();
  }
}

// ---------------------------------------------------------------- reads

export const realnameOf = (h: Harness, target: User) =>
  h.db
    .selectFrom('realname')
    .selectAll()
    .where('app_id', '=', target.appId)
    .where('user_id', '=', target.id)
    .executeTakeFirst();

/** The plaintext behind a stored realname ciphertext. */
export function decrypted(h: Harness, value: Uint8Array | null, context: string): string | null {
  return value === null ? null : h.fields.decrypt(Buffer.from(value).toString('utf8'), context);
}

export const accountsOf = (h: Harness, target: User) =>
  h.db
    .selectFrom('payout_accounts')
    .selectAll()
    .where('app_id', '=', target.appId)
    .where('user_id', '=', target.id)
    .orderBy('id')
    .execute();

export const eventsOf = (h: Harness, appId: string) =>
  h.db
    .selectFrom('event_log')
    .selectAll()
    .where('app_id', '=', appId)
    .where('name', '=', EVENT)
    .orderBy('id')
    .execute();

export const audits = (h: Harness, appId: string) =>
  h.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('action', '=', ACTION)
    .orderBy('id')
    .execute();
export type AuditRow = Awaited<ReturnType<typeof audits>>[number];

/** The audit rows added after `before`. */
export function added(before: readonly AuditRow[], after: readonly AuditRow[]): AuditRow[] {
  return after.filter((entry) => !before.some((old) => old.id === entry.id));
}

/** A row as text (bigint ids and byte strings included), for containment checks. */
export function rowText(entry: object): string {
  return JSON.stringify(entry, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/** Everything a correction may write (or a refusal must leave alone) in the app, audits aside. */
export async function snapshot(h: Harness, appId: string) {
  return {
    users: await h.db
      .selectFrom('users')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    realname: await h.db
      .selectFrom('realname')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    payoutAccounts: await h.db
      .selectFrom('payout_accounts')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    withdrawals: await h.db
      .selectFrom('withdrawals')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    events: await h.db
      .selectFrom('event_log')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    riskHits: await h.db
      .selectFrom('risk_hits')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}

/** The prior identity inserts PostgreSQL accepted. */
export const priorWritten = (s: Setup) => s.prior.filter((entry) => entry.done);

/**
 * The column values of one observed INSERT … (columns) VALUES (…) into the isolated store: a
 * bound parameter by its placeholder, anything else as its SQL text.
 */
export function priorValues(entry: PriorInsert): Record<string, unknown> {
  const match =
    /insert\s+into\s+(?:app\.)?realname_prior_identities\s*\(([^)]*)\)\s*values\s*\((.*)\)/is.exec(
      entry.sql,
    );
  expect(match, `一行 INSERT … (列) VALUES (…)：${entry.sql}`).not.toBeNull();
  const columns = match![1]!.split(',').map((column) => column.trim());
  const values = match![2]!.split(',').map((value) => value.trim());
  expect(values).toHaveLength(columns.length);
  return Object.fromEntries(
    columns.map((column, i) => {
      const placeholder = /^\$(\d+)(?:::[a-z ]+)?$/i.exec(values[i]!);
      return [
        column,
        placeholder === null ? values[i] : entry.parameters[Number(placeholder[1]) - 1],
      ];
    }),
  );
}

/** A bytea parameter as the text FieldCrypto wrote (Buffer.from(ciphertext, 'utf8')). */
export function cipherText(value: unknown): string {
  expect(value instanceof Uint8Array, '密文参数必须是字节串').toBe(true);
  return Buffer.from(value as Uint8Array).toString('utf8');
}

/** An instant parameter (Date or ISO text) in milliseconds. */
export function instant(value: unknown): number {
  expect(value instanceof Date || typeof value === 'string', '时间参数').toBe(true);
  return new Date(value as Date | string).getTime();
}

/** True once some session of the test database waits for a lock (polled, about 10 s at most). */
export async function someoneWaitsForALock(h: Harness): Promise<boolean> {
  for (let i = 0; i < 400; i += 1) {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(h.db);
    if ((rows[0]?.n ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** No name or ID number in plaintext in any log line of the test or in the responses. */
export function noPlaintext(s: Setup, secrets: readonly string[], responses: readonly Response[]) {
  expect(s.lines.length, '日志捕获器必须启用').toBeGreaterThan(0);
  const text = [...s.lines, ...responses.map((response) => JSON.stringify(response.json()))].join(
    '\n',
  );
  for (const secret of secrets) expect(text).not.toContain(secret);
}

/** Names and ID numbers of the identities involved: never in plaintext outside the ciphertexts. */
export const plaintexts = (...who: readonly Identity[]) =>
  who.flatMap((person) => [person.name, person.idNo]);
