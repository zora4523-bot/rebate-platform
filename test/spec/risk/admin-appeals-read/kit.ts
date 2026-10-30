// B1-03zd rule-test kit: the admin appeal console reads (CT-24r; BR-ID-36, BR-ID-33). Real admin
// entry, admin sessions, database and FieldCrypto; no replacement routes. Appeals and 44001 hit
// rows are seeded straight into app.appeals / app.risk_hits in the shape the risk writers use
// (appeals.ts, blocklist.ts: rule BLACKLIST_<DIMENSION> for a blocklist entry, SMS_BLOCKED_PREFIX
// and DEVICE_REGISTER_LIMIT for other refusals; related phone as its users.phone blind index and
// 3 + 4 mask). Every execution belongs to the isolated container runner.
import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import type { Insertable, Selectable } from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  NOW,
  account,
  apiRequire,
  fixture,
  signedIn,
  type Account,
  type Fixture,
  type Harness,
  type Response,
} from '../../admin/auth/kit.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

export const LIST = '/admin/v1/appeals';
export const ONE = '/admin/v1/appeals/{appeal_id}';
export const BLOCKED = '/admin/v1/blocked-requests';
export const PERMISSION = 'risk.appeal';
export const DENIED = { reason: 'admin_permission_denied' };
export const LOOKUP_FIELDS = { fields: ['phone', 'user_id', 'blocked_request_id'] };
export const PHONE_INVALID = { fields: ['phone'], reason: 'phone_invalid' };
export const PHONE_CONTEXT = 'users.phone';
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export type RiskStateName = 'normal' | 'frozen' | 'appealing' | 'banned';
export type RequestType = 'register' | 'withdraw' | 'phone_change' | 'payout_account';
export type AppealRow = Selectable<DB['appeals']>;
export type ListItem = Schema<'AdminAppealListItem'>;
export type Detail = Schema<'AdminAppealDetail'>;
export type BlockedItem = Schema<'AdminBlockedRequest'>;

/** BR-ID-33 3 + 4 mask, computed here independently of the server. */
export const mask = (phone: string) => `${phone.slice(0, 3)}****${phone.slice(-4)}`;
/** One instant as an ISO string, whatever offset the server wrote it with. */
export const iso = (value: string | Date) => new Date(value).toISOString();
/** The fixture clock's start plus an offset. */
export const at = (offsetMs: number) => new Date(Date.parse(NOW) + offsetMs);
/** A synthetic mainland mobile number (^1[3-9]\d{9}$), only in memory. */
export const phoneNumber = () =>
  `1${3 + randomInt(7)}${String(randomInt(1_000_000_000)).padStart(9, '0')}`;
const token = () => randomUUID().replaceAll('-', '').toUpperCase();

/** The three read routes, as registered on an entry. */
export function mounted(f: Fixture) {
  const server = f.app.getHttpAdapter().getInstance();
  return [LIST, `${LIST}/:appeal_id`, BLOCKED].map((url) =>
    server.hasRoute({ method: 'GET', url }),
  );
}

/** An admin account of `appId` whose TOTP secret is sealed under that app's context. */
export async function admin(
  h: Harness,
  appId: string,
  patch: Partial<Insertable<DB['admin_users']>> = {},
) {
  const a = await account(h, { app_id: appId, ...patch });
  await h.db
    .updateTable('admin_users')
    .set({
      totp_secret_cipher: Buffer.from(
        h.fields.encrypt(a.secret, `admin_users.totp_secret:${appId}:${a.id}`),
      ),
    })
    .where('id', '=', a.id)
    .execute();
  return a;
}

export async function grant(
  h: Harness,
  f: Fixture,
  appId: string,
  a: Account,
  keys: readonly string[],
) {
  for (const key of keys) {
    await h.db
      .insertInto('admin_permissions')
      .values({
        app_id: appId,
        admin_id: a.id,
        permission_key: key,
        granted_by: a.id,
        granted_at: f.clock.now(),
      })
      .execute();
  }
}

export async function setup(
  h: Harness,
  options: { grants?: readonly string[]; isSuper?: boolean } = {},
) {
  const appId = `appeals_${randomUUID().replaceAll('-', '')}`;
  const f = await fixture(h);
  expect(
    mounted(f),
    'GET /admin/v1/appeals, /admin/v1/appeals/{appeal_id} and /admin/v1/blocked-requests on the admin entry',
  ).toEqual([true, true, true]);
  const a = await admin(h, appId, { is_super: options.isSuper ?? false });
  await grant(h, f, appId, a, options.grants ?? [PERMISSION]);
  const session = await signedIn(f, a);
  const get = (path: string, query: Record<string, string>, headers: Record<string, string>) => {
    const search = new URLSearchParams(query).toString();
    return f.read(session.admin_token, search === '' ? path : `${path}?${search}`, headers);
  };
  return {
    h,
    f,
    a,
    appId,
    token: session.admin_token,
    list: (query: Record<string, string> = {}, headers: Record<string, string> = {}) =>
      get(LIST, query, headers),
    detail: (id: string, headers: Record<string, string> = {}) =>
      get(`${LIST}/${encodeURIComponent(id)}`, {}, headers),
    lookup: (query: Record<string, string> = {}, headers: Record<string, string> = {}) =>
      get(BLOCKED, query, headers),
  };
}
export type Scenario = Awaited<ReturnType<typeof setup>>;

export interface Member {
  readonly id: string;
  readonly phone: string | null;
  readonly masked: string | null;
  readonly hmac: string | null;
}

/** A user of the scenario's app, with a bound phone unless phone is null, and a risk state row. */
export async function member(
  s: Scenario,
  options: { phone?: string | null; state?: RiskStateName | null } = {},
): Promise<Member> {
  const id = randomUUID();
  const phone = options.phone === undefined ? phoneNumber() : options.phone;
  const hmac = phone === null ? null : s.h.fields.blindIndex(phone, PHONE_CONTEXT);
  await s.h.db
    .insertInto('users')
    .values({
      id,
      app_id: s.appId,
      nickname: '测试用户',
      avatar: 'https://example.invalid/avatar.png',
      phone_cipher: phone === null ? null : Buffer.from(s.h.fields.encrypt(phone, PHONE_CONTEXT)),
      phone_hmac: hmac,
      invite_code: `i-${id}`,
      attr_code: `a-${id}`,
      level: 'L1',
      register_method: 'sms',
      registered_channel: 'test',
    })
    .execute();
  const state = options.state === undefined ? 'normal' : options.state;
  if (state !== null) await riskState(s, id, state);
  return { id, phone, masked: phone === null ? null : mask(phone), hmac };
}

export async function riskState(s: Scenario, userId: string, state: RiskStateName) {
  await s.h.db
    .insertInto('user_risk_state')
    .values({
      app_id: s.appId,
      user_id: userId,
      state,
      reason: '风控处置',
      reason_category: state === 'normal' ? null : 'other',
      frozen_until: state === 'frozen' ? '2090-01-01T00:00:00Z' : null,
      changed_by: 'fixture',
      changed_at: s.f.clock.now(),
      row_version: 3,
    })
    .execute();
}

/** A sub-order of the user whose rebate risk control voided (the target of an order appeal). */
export async function order(s: Scenario, user: Member) {
  const values = {
    order_id: randomUUID(),
    app_id: s.appId,
    platform: 'jd',
    sub_order_id: `SUB-${token()}`,
    parent_order_id: `PARENT-${token()}`,
    raw_item_id: 'item-fixture',
    user_id: user.id,
    user_basis: 'param',
    buy_type: 'self',
    scene_basis: 'param',
    platform_status: 'RECEIVED',
    rebate_status: 'VOID',
    paid_at: '2026-10-01T02:00:00.000Z',
    attr_at: '2026-10-01T02:00:00.000Z',
  } satisfies Insertable<DB['orders']>;
  await s.h.db
    .insertInto('order_keys')
    .values({
      order_id: values.order_id,
      app_id: values.app_id,
      platform: values.platform,
      sub_order_id: values.sub_order_id,
      attr_at: values.attr_at,
    })
    .execute();
  await s.h.db.insertInto('orders').values(values).execute();
  return { order_id: values.order_id, sub_order_id: values.sub_order_id };
}
export type Order = Awaited<ReturnType<typeof order>>;

/** Registers a rule code as the risk writers do (conditions carry a secret that must never leak). */
export async function rule(s: Scenario, ruleId: string, appId = s.appId) {
  await s.h.db
    .insertInto('risk_rules')
    .values({
      id: randomUUID(),
      app_id: appId,
      rule_id: ruleId,
      scene: 'fixture',
      conditions: JSON.stringify({ secret_threshold: `cond-secret-${ruleId}` }),
      risk_action: 'block',
      status: 'active',
      version: 1,
      created_at: at(-30 * DAY),
      updated_at: at(-30 * DAY),
    })
    .onConflict((oc) => oc.columns(['app_id', 'rule_id']).doNothing())
    .execute();
}

/** A risk_hits row that is not a blocked request (order, withdrawal, invite …). */
export async function hit(
  s: Scenario,
  row: {
    user_id: string | null;
    rule_id: string;
    ref_type: 'order' | 'withdrawal' | 'invite_relation' | 'invite_reward';
    ref_id: string;
    created_at: Date;
    risk_action?: 'pass' | 'manual_review' | 'block' | 'void_commission';
  },
) {
  await rule(s, row.rule_id);
  const valueHmac = s.h.fields.blindIndex(`hit-secret-${randomUUID()}`, 'fixture.hit');
  await s.h.db
    .insertInto('risk_hits')
    .values({
      app_id: s.appId,
      user_id: row.user_id,
      rule_id: row.rule_id,
      risk_action: row.risk_action ?? 'manual_review',
      dimension: 'fixture',
      value_hmac: valueHmac,
      ref_type: row.ref_type,
      ref_id: row.ref_id,
      created_at: row.created_at,
    })
    .execute();
  return { ...row, risk_action: row.risk_action ?? 'manual_review', value_hmac: valueHmac };
}

export interface Blocked {
  readonly id: string;
  readonly request_type: RequestType;
  readonly user_id: string | null;
  readonly phone: string | null;
  readonly masked: string | null;
  readonly phone_hmac: string | null;
  readonly amount_fen: number | null;
  readonly blocked_at: Date;
  /** The hit values (plaintext, in memory only) and their HMACs: none may be returned. */
  readonly secrets: readonly string[];
}

/**
 * One request blocked with 44001: one risk_hits row per rule (ref_type blocked_request, one shared
 * ref_id = the blocked request id), as blocklist.ts writeHits stores them.
 */
export async function blocked(
  s: Scenario,
  options: {
    request_type: RequestType;
    user?: Member | null;
    /** The related phone; defaults to the user's phone, or a fresh number for register. */
    phone?: string | null;
    rules?: readonly { rule_id: string; dimension: string }[];
    amount_fen?: number;
    blocked_at: Date;
  },
): Promise<Blocked> {
  const register = options.request_type === 'register';
  const user = register ? null : (options.user ?? null);
  if (!register && user === null)
    throw new Error('kit: a non-register blocked request needs a user');
  const phone =
    options.phone !== undefined ? options.phone : register ? phoneNumber() : (user?.phone ?? null);
  const phoneHmac = phone === null ? null : s.h.fields.blindIndex(phone, PHONE_CONTEXT);
  const amount = options.request_type === 'withdraw' ? (options.amount_fen ?? 5000) : null;
  const rules = options.rules ?? [{ rule_id: 'BLACKLIST_PHONE', dimension: 'phone' }];
  const id = randomUUID();
  const secrets: string[] = [];
  for (const r of rules) await rule(s, r.rule_id);
  await s.h.db
    .insertInto('risk_hits')
    .values(
      rules.map((r) => {
        const value = `blocked-secret-${randomUUID()}`;
        const valueHmac = s.h.fields.blindIndex(value, `fixture.${r.dimension}`);
        secrets.push(value, valueHmac);
        return {
          app_id: s.appId,
          user_id: user?.id ?? null,
          rule_id: r.rule_id,
          risk_action: 'block',
          dimension: r.dimension,
          value_hmac: valueHmac,
          ref_type: 'blocked_request',
          ref_id: id,
          request_type: options.request_type,
          related_phone_hmac: phoneHmac,
          related_phone_masked: phone === null ? null : mask(phone),
          amount_fen: amount === null ? null : BigInt(amount),
          created_at: options.blocked_at,
        };
      }),
    )
    .execute();
  if (phoneHmac !== null) secrets.push(phoneHmac);
  return {
    id,
    request_type: options.request_type,
    user_id: user?.id ?? null,
    phone,
    masked: phone === null ? null : mask(phone),
    phone_hmac: phoneHmac,
    amount_fen: amount,
    blocked_at: options.blocked_at,
    secrets,
  };
}

type AppealSeed = Pick<Insertable<DB['appeals']>, 'target_type' | 'target_id'> &
  Partial<Insertable<DB['appeals']>>;

/**
 * An appeal row as risk's appeal service stores it. Closed rows get a handler (the resolver) and
 * a closed_at unless given; created_at defaults to one day before the fixture clock and
 * deadline_at to three days after created_at.
 */
export async function appeal(s: Scenario, seed: AppealSeed): Promise<AppealRow> {
  const created = seed.created_at === undefined ? at(-DAY) : new Date(seed.created_at);
  const status = seed.status ?? 'processing';
  const closed = status !== 'processing';
  return s.h.db
    .insertInto('appeals')
    .values({
      id: randomUUID(),
      app_id: s.appId,
      user_id: null,
      request_type: null,
      related_phone_hmac: null,
      prev_risk_state: null,
      content: `申诉陈述-${randomUUID()}`,
      deadline_at: new Date(created.getTime() + 3 * DAY),
      handler_id: closed ? s.a.id : null,
      closed_at: closed ? new Date(created.getTime() + HOUR) : null,
      row_version: closed ? 1 : 0,
      updated_at: created,
      ...seed,
      status,
      created_at: created,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function accountAppeal(
  s: Scenario,
  user: Member,
  prev: 'banned' | 'frozen',
  patch: Partial<Insertable<DB['appeals']>> = {},
) {
  return appeal(s, {
    target_type: 'account',
    target_id: user.id,
    user_id: user.id,
    prev_risk_state: prev,
    ...patch,
  });
}

export function orderAppeal(
  s: Scenario,
  user: Member,
  o: Order,
  patch: Partial<Insertable<DB['appeals']>> = {},
) {
  return appeal(s, {
    target_type: 'order',
    target_id: o.order_id,
    user_id: user.id,
    ...patch,
  });
}

export function blockedAppeal(
  s: Scenario,
  b: Blocked,
  patch: Partial<Insertable<DB['appeals']>> = {},
) {
  return appeal(s, {
    target_type: 'blocked_request',
    target_id: b.id,
    request_type: b.request_type,
    user_id: b.user_id,
    related_phone_hmac: b.phone_hmac,
    ...patch,
  });
}

/** Everything a read must leave as it was. */
export async function snapshot(s: Scenario) {
  const db = s.h.db;
  return {
    appeals: await db
      .selectFrom('appeals')
      .selectAll()
      .where('app_id', '=', s.appId)
      .orderBy('id')
      .execute(),
    risk: await db
      .selectFrom('user_risk_state')
      .selectAll()
      .where('app_id', '=', s.appId)
      .orderBy('user_id')
      .execute(),
    hits: await db
      .selectFrom('risk_hits')
      .selectAll()
      .where('app_id', '=', s.appId)
      .orderBy('id')
      .execute(),
    rules: await db
      .selectFrom('risk_rules')
      .selectAll()
      .where('app_id', '=', s.appId)
      .orderBy('rule_id')
      .execute(),
    orders: await db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', s.appId)
      .orderBy('order_id')
      .execute(),
    audits: await audits(s),
  };
}

export const audits = (s: Scenario) =>
  s.h.db.selectFrom('audit_logs').selectAll().where('app_id', '=', s.appId).orderBy('id').execute();

// ---- contract checks ----

interface Operation {
  operationId: string;
  'x-auth'?: string;
  'x-implementation'?: string;
}
interface Document {
  paths: Record<string, { get?: Operation; post?: Operation }>;
  components: { schemas: Record<string, JsonSchema> };
}
let document: Promise<Document> | undefined;
export function contract() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<Document>;
  };
  document ??= parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  return document;
}
export async function validate(response: Response, name: string) {
  const check = createValidatorCompiler()({
    schema: (await contract()).components.schemas[name]!,
    httpPart: 'body',
  });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}

export async function page(response: Response): Promise<Schema<'AdminAppealPage'>> {
  expect(response.statusCode).toBe(200);
  expect(response.json().code).toBe(0);
  await validate(response, 'AdminAppealPageResponse');
  return response.json<{ data: Schema<'AdminAppealPage'> }>().data;
}
export async function detail(response: Response): Promise<Detail> {
  expect(response.statusCode).toBe(200);
  expect(response.json().code).toBe(0);
  await validate(response, 'AdminAppealResponse');
  return response.json<{ data: Detail }>().data;
}
export async function found(response: Response): Promise<Schema<'AdminBlockedRequestPage'>> {
  expect(response.statusCode).toBe(200);
  expect(response.json().code).toBe(0);
  await validate(response, 'AdminBlockedRequestPageResponse');
  return response.json<{ data: Schema<'AdminBlockedRequestPage'> }>().data;
}
export async function rejected(response: Response, code: number, data?: object) {
  expect(response.statusCode).toBe(code === 20001 ? 400 : code === 10001 ? 401 : 403);
  expect(response.json().code).toBe(code);
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response, 'ErrorEnvelope');
}

export const ids = (p: { items: readonly { appeal_id: string }[] }) =>
  p.items.map((i) => i.appeal_id);
export const blockedIds = (p: { items: readonly { blocked_request_id: string }[] }) =>
  p.items.map((i) => i.blocked_request_id);

const TIME_KEYS = ['created_at', 'deadline_at', 'claimed_at', 'closed_at', 'blocked_at'] as const;
/** A response object with its instants rewritten as ISO strings (offsets differ, instants not). */
export function instants<T>(value: T): T {
  const copy = { ...(value as unknown as Record<string, unknown>) };
  for (const key of TIME_KEYS) {
    const v = copy[key];
    if (typeof v === 'string') copy[key] = iso(v);
  }
  return copy as unknown as T;
}

/** The list row an appeal seeded with `row` must produce. */
export function listRow(
  row: AppealRow,
  expected: {
    user: Member | null;
    target_no: string;
    handler_name: string | null;
  },
): ListItem {
  return {
    appeal_id: row.id,
    user:
      expected.user === null
        ? null
        : { user_id: expected.user.id, phone_masked: expected.user.masked },
    target_type: row.target_type as ListItem['target_type'],
    target_id: row.target_id,
    target_no: expected.target_no,
    request_type: row.request_type as ListItem['request_type'],
    prev_risk_state: row.prev_risk_state as ListItem['prev_risk_state'],
    created_at: row.created_at.toISOString(),
    deadline_at: row.deadline_at.toISOString(),
    status: row.status as ListItem['status'],
    handler_id: row.handler_id,
    handler_name: expected.handler_name,
  };
}

/** Nothing of a hit value, its HMAC, the rule's conditions or a full phone number in `value`. */
export function noSecrets(value: unknown, secrets: readonly (string | null)[]) {
  const text = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret !== null) expect(text.includes(secret), `leaked ${secret}`).toBe(false);
  }
  expect(text).not.toContain('cond-secret-');
  expect(text).not.toMatch(
    /"(?:value_hmac|value|dimension|conditions|phone|phone_hmac|related_phone_hmac)"\s*:/,
  );
}
