// B1-03ze rule-test kit: the admin appeal console writes (CT-24r adminClaimAppeal,
// adminResolveAppeal, adminRegisterAppeal; BR-ID-36, BR-ID-31). Real admin entry, admin sessions,
// totp step-up, database and event bus; no replacement routes. Built on the B1-03zd read kit
// (seeds and GET /admin/v1/appeals/{appeal_id}).
//
// The columns this task's migration adds to app.appeals (source, registrant, claimant, claim time)
// are never read or written here: they are observed only through the detail answer (task brief
// 9.4). Existing columns (status, handler_id, closed_at, prev_risk_state, row_version …) are read
// straight from the table. Every execution belongs to the isolated container runner.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable } from 'kysely';
import { expect } from 'vitest';
import {
  signedIn,
  totp,
  type Account,
  type Fixture,
  type Harness,
  type Response,
} from '../../admin/auth/kit.ts';
import { ok, STEP, type Grant } from '../../admin/step-up/kit.ts';
import {
  DAY,
  LIST,
  PERMISSION,
  accountAppeal,
  admin,
  at,
  blocked,
  blockedAppeal,
  detail,
  grant,
  mask,
  member,
  order,
  orderAppeal,
  phoneNumber,
  rule,
  setup as readSetup,
  validate,
  type AppealRow,
  type Blocked,
  type Detail,
  type Member,
  type Order,
} from '../admin-appeals-read/kit.ts';

export {
  DAY,
  HOUR,
  LIST,
  PERMISSION,
  accountAppeal,
  at,
  blocked,
  blockedAppeal,
  iso,
  instants,
  mask,
  member,
  orderAppeal,
  phoneNumber,
} from '../admin-appeals-read/kit.ts';
export type { AppealRow, Blocked, Detail, Member, Order } from '../admin-appeals-read/kit.ts';

export const CLAIM = '/admin/v1/appeals/{appeal_id}/claim';
export const RESOLVE = '/admin/v1/appeals/{appeal_id}/resolve';
export const DENIED = { reason: 'admin_permission_denied' };
export const STEP_UP = { tier: 'totp' };
export const CONFLICT = { resource: 'appeal' };
export const UNKNOWN = { fields: ['appeal_id'] };
/** The internal note of a resolution: audit log only (no column, never in an answer). */
export const NOTE = '内部说明-核实后结案-不对用户展示';
/** The registration note of a console registration: audit log only. */
export const REASON = '本人经企业微信联系客服，核对信息一致-登记原因';
export const WRITE_ACTIONS = ['appeal_claim', 'appeal_resolve', 'appeal_register'] as const;
export const EXTRA = ['risk.ban', 'risk.freeze', 'risk.blocklist'] as const;

export type Decision = 'upheld' | 'revoked';
export type Kind = 'banned' | 'frozen' | 'blocklist' | 'rule' | 'order' | 'register';

const HTTP: Readonly<Record<number, number>> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20902: 409,
  30418: 422,
  50001: 500,
};

/** The three write routes, as registered on an entry. */
export function mountedWrites(f: Fixture) {
  const server = f.app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(options: { method: 'POST'; url: string }): boolean;
  };
  return [LIST, `${LIST}/:appeal_id/claim`, `${LIST}/:appeal_id/resolve`].map((url) =>
    server.hasRoute({ method: 'POST', url }),
  );
}

export const resolution = (decision: Decision, version: number, note: string = NOTE) => ({
  decision,
  note,
  expected_row_version: version,
});

/** POST helpers of one admin session (and that session's totp step-up). */
export function writers(f: Fixture, a: Account, adminToken: string) {
  const auth = { authorization: `Bearer ${adminToken}` };
  const send = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    f.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', ...auth, ...headers },
      payload: JSON.stringify(body),
    });
  const one = (id: string, action: 'claim' | 'resolve') =>
    `${LIST}/${encodeURIComponent(id)}/${action}`;
  return {
    /** A fresh totp step-up token of this session (the clock moves on 30 s so codes never repeat). */
    issue: async () => {
      f.clock.advanceMs(30_000);
      const granted = await ok<Grant>(
        await f.post('/step-up', { tier: 'totp', code: totp(a.secret, f.clock) }, auth),
        STEP,
      );
      return granted.step_up_token;
    },
    claim: (id: string, body: unknown, headers: Record<string, string> = {}) =>
      send(one(id, 'claim'), body, headers),
    resolve: (
      id: string,
      body: unknown,
      token: string | null = null,
      headers: Record<string, string> = {},
    ) =>
      send(one(id, 'resolve'), body, {
        ...(token === null ? {} : { 'x-step-up-token': token }),
        ...headers,
      }),
    register: (body: unknown, headers: Record<string, string> = {}) => send(LIST, body, headers),
  };
}

export async function setup(
  h: Harness,
  options: { grants?: readonly string[]; isSuper?: boolean; displayName?: string } = {},
) {
  const s = await readSetup(h, options);
  expect(
    mountedWrites(s.f),
    'POST /admin/v1/appeals, /admin/v1/appeals/{appeal_id}/claim and /resolve on the admin entry',
  ).toEqual([true, true, true]);
  if (options.displayName !== undefined) {
    await h.db
      .updateTable('admin_users')
      .set({ display_name: options.displayName })
      .where('id', '=', s.a.id)
      .execute();
  }
  return { ...s, ...writers(s.f, s.a, s.token) };
}
export type Scenario = Awaited<ReturnType<typeof setup>>;

/** Another console account of the scenario's app, signed in on the same entry. */
export async function colleague(
  s: Scenario,
  options: { grants?: readonly string[]; displayName?: string } = {},
) {
  const a = await admin(
    s.h,
    s.appId,
    options.displayName === undefined ? {} : { display_name: options.displayName },
  );
  await grant(s.h, s.f, s.appId, a, options.grants ?? [PERMISSION]);
  const session = await signedIn(s.f, a);
  return { a, token: session.admin_token, ...writers(s.f, a, session.admin_token) };
}

/** Grants more permission points to the scenario's own account. */
export const allow = (s: Scenario, keys: readonly string[]) => grant(s.h, s.f, s.appId, s.a, keys);

// ---- seeds ----

/** An appealing risk row as the appeal service leaves it (frozen_until kept for a freeze). */
export async function appealing(
  s: Scenario,
  userId: string,
  prev: 'banned' | 'frozen',
  penaltyStartedAt: Date | null = null,
) {
  await s.h.db
    .insertInto('user_risk_state')
    .values({
      app_id: s.appId,
      user_id: userId,
      state: 'appealing',
      reason: '风控处置',
      reason_category: 'other',
      frozen_until: prev === 'frozen' ? '2090-01-01T00:00:00Z' : null,
      changed_by: 'fixture',
      changed_at: s.f.clock.now(),
      row_version: 3,
      penalty_started_at: penaltyStartedAt,
    })
    .execute();
}

/** A restricted (banned / frozen) or normal risk row, with the penalty's start when given. */
export async function restricted(
  s: Scenario,
  userId: string,
  state: 'banned' | 'frozen' | 'normal',
  penaltyStartedAt: Date | null = null,
) {
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
      changed_at: at(-10 * DAY),
      row_version: 3,
      penalty_started_at: penaltyStartedAt,
    })
    .execute();
}

/**
 * A sub-order whose rebate risk control voided (BR-ATTR-26): rebate_status VOID with reason
 * BLACKLIST, and the void_commission risk hit on the order.
 */
export async function voidedOrder(s: Scenario, user: Member): Promise<Order> {
  const o = await order(s, user);
  await s.h.db
    .updateTable('orders')
    .set({ reason: 'BLACKLIST' })
    .where('app_id', '=', s.appId)
    .where('order_id', '=', o.order_id)
    .execute();
  await s.h.db
    .insertInto('risk_rules')
    .values({
      id: randomUUID(),
      app_id: s.appId,
      rule_id: 'ORDER_BLACKLIST',
      scene: 'fixture',
      conditions: JSON.stringify({}),
      risk_action: 'void_commission',
      status: 'active',
      version: 1,
      created_at: at(-30 * DAY),
      updated_at: at(-30 * DAY),
    })
    .onConflict((oc) => oc.columns(['app_id', 'rule_id']).doNothing())
    .execute();
  await s.h.db
    .insertInto('risk_hits')
    .values({
      app_id: s.appId,
      user_id: user.id,
      rule_id: 'ORDER_BLACKLIST',
      risk_action: 'void_commission',
      dimension: 'fixture',
      value_hmac: s.h.fields.blindIndex(`order-${o.order_id}`, 'fixture.order'),
      ref_type: 'order',
      ref_id: o.order_id,
      created_at: at(-5 * DAY),
    })
    .execute();
  return o;
}

/** An active phone blocklist entry of the app for `phone` (users.phone blind index). */
export async function phoneEntry(s: Scenario, phone: string) {
  const id = randomUUID();
  await s.h.db
    .insertInto('blocklist')
    .values({
      id,
      app_id: s.appId,
      dimension: 'phone',
      value_hmac: s.h.fields.blindIndex(phone, 'users.phone'),
      value: null,
      violation_type: 'fraud_invite',
      reason: 'fixture blocklist reason',
      expire_at: '2090-01-01T00:00:00Z',
      status: 'active',
      created_by: 'fixture',
      created_at: at(-30 * DAY),
      updated_at: at(-30 * DAY),
    })
    .execute();
  return id;
}

/**
 * A request blocked by the phone blocklist: its one hit row carries the entry's own value_hmac
 * (the users.phone blind index), as blocklist.ts writes it (dimension phone, rule BLACKLIST_PHONE).
 */
export async function blocklisted(
  s: Scenario,
  options: { request_type: 'register' | 'phone_change'; user?: Member | null },
): Promise<{ b: Blocked; entry: string; phone: string }> {
  const register = options.request_type === 'register';
  const user = register ? null : (options.user ?? null);
  if (!register && user === null) throw new Error('kit: a phone_change request needs a user');
  const phone = phoneNumber();
  const entry = await phoneEntry(s, phone);
  const hmac = s.h.fields.blindIndex(phone, 'users.phone');
  const id = randomUUID();
  const blockedAt = at(-2 * DAY);
  await rule(s, 'BLACKLIST_PHONE');
  await s.h.db
    .insertInto('risk_hits')
    .values({
      app_id: s.appId,
      user_id: user?.id ?? null,
      rule_id: 'BLACKLIST_PHONE',
      risk_action: 'block',
      dimension: 'phone',
      value_hmac: hmac,
      ref_type: 'blocked_request',
      ref_id: id,
      request_type: options.request_type,
      related_phone_hmac: hmac,
      related_phone_masked: mask(phone),
      amount_fen: null,
      created_at: blockedAt,
    })
    .execute();
  const b: Blocked = {
    id,
    request_type: options.request_type,
    user_id: user?.id ?? null,
    phone,
    masked: mask(phone),
    phone_hmac: hmac,
    amount_fen: null,
    blocked_at: blockedAt,
    secrets: [phone, hmac],
  };
  return { b, entry, phone };
}

export interface Seeded {
  readonly row: AppealRow;
  readonly user: Member | null;
  readonly blocked: Blocked | null;
  readonly order: Order | null;
}

/** A processing (unless patched) appeal of one kind, with what it is about. */
export async function seed(
  s: Scenario,
  kind: Kind,
  patch: Partial<Insertable<DB['appeals']>> = {},
): Promise<Seeded> {
  switch (kind) {
    case 'banned':
    case 'frozen': {
      const user = await member(s, { state: null });
      await appealing(s, user.id, kind);
      return { row: await accountAppeal(s, user, kind, patch), user, blocked: null, order: null };
    }
    case 'blocklist': {
      const user = await member(s);
      const b = await blocked(s, {
        request_type: 'phone_change',
        user,
        phone: phoneNumber(),
        rules: [{ rule_id: 'BLACKLIST_PHONE', dimension: 'phone' }],
        blocked_at: at(-2 * DAY),
      });
      return { row: await blockedAppeal(s, b, patch), user, blocked: b, order: null };
    }
    case 'rule': {
      const user = await member(s);
      const b = await blocked(s, {
        request_type: 'withdraw',
        user,
        rules: [{ rule_id: 'WITHDRAW_VELOCITY', dimension: 'alipay' }],
        blocked_at: at(-2 * DAY),
      });
      return { row: await blockedAppeal(s, b, patch), user, blocked: b, order: null };
    }
    case 'register': {
      const b = await blocked(s, {
        request_type: 'register',
        rules: [{ rule_id: 'DEVICE_REGISTER_LIMIT', dimension: 'device' }],
        blocked_at: at(-2 * DAY),
      });
      return { row: await blockedAppeal(s, b, patch), user: null, blocked: b, order: null };
    }
    case 'order': {
      const user = await member(s);
      const o = await voidedOrder(s, user);
      return { row: await orderAppeal(s, user, o, patch), user, blocked: null, order: o };
    }
  }
}

/** The extra permission point revoking each kind needs (null: risk.appeal alone, no step-up). */
export const extraFor = (kind: Kind) =>
  kind === 'banned'
    ? 'risk.ban'
    : kind === 'frozen'
      ? 'risk.freeze'
      : kind === 'blocklist'
        ? 'risk.blocklist'
        : null;

/** A union binding of a user (fields as the linking module stores them). */
export async function binding(
  s: Scenario,
  userId: string,
  patch: Partial<Insertable<DB['union_bindings']>> = {},
) {
  const platform = patch.platform ?? 'taobao';
  const accountId = randomUUID();
  await s.h.db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: s.appId,
      platform,
      account_name: 'synthetic-account',
      status: 'active',
      auth_status: 'active',
    })
    .execute();
  return s.h.db
    .insertInto('union_bindings')
    .values({
      id: randomUUID(),
      app_id: s.appId,
      user_id: userId,
      platform,
      union_account_id: accountId,
      relation_id: platform === 'taobao' ? randomUUID().replaceAll('-', '') : null,
      status: 'active',
      blocked_reason: null,
      reason: null,
      row_version: 7,
      bound_at: new Date('2026-10-01T00:00:00Z'),
      released_at: null,
      cooldown_until: null,
      created_at: s.f.clock.now(),
      updated_at: s.f.clock.now(),
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

// ---- observations ----

export const appealRow = (s: Scenario, id: string) =>
  s.h.db.selectFrom('appeals').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

export const riskRow = (s: Scenario, userId: string) =>
  s.h.db
    .selectFrom('user_risk_state')
    .selectAll()
    .where('app_id', '=', s.appId)
    .where('user_id', '=', userId)
    .executeTakeFirst();

/** The app's audit records of the three writes (the sign-in's admin.login is left out). */
export const writeAudits = (s: Scenario) =>
  s.h.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', s.appId)
    .where('action', 'in', [...WRITE_ACTIONS])
    .orderBy('id')
    .execute();

export const auditsOf = async (s: Scenario, action: (typeof WRITE_ACTIONS)[number]) =>
  (await writeAudits(s)).filter((row) => row.action === action);

/** Every audit record of the app, whatever its action (sign-in and step-up included). */
export const appAudits = (s: Scenario) =>
  s.h.db.selectFrom('audit_logs').selectAll().where('app_id', '=', s.appId).orderBy('id').execute();

/** JSON text of a value that may hold BigInt (audit_logs.id comes back as BigInt). */
export const text = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

export interface ResolvedEventRow {
  readonly app_id: string;
  readonly event_id: string;
  readonly data: Record<string, unknown>;
}

/** The app's appeal.resolved events as the event bus logged them ({v, data}). */
export async function resolvedEvents(s: Scenario): Promise<ResolvedEventRow[]> {
  const rows = await s.h.db
    .selectFrom('event_log')
    .select(['app_id', 'event_id', 'payload'])
    .where('app_id', '=', s.appId)
    .where('name', '=', 'appeal.resolved')
    .orderBy('id')
    .execute();
  return rows.map((row) => ({
    app_id: row.app_id,
    event_id: row.event_id,
    data: (row.payload as unknown as { data: Record<string, unknown> }).data,
  }));
}

/** Everything a refused write must leave as it was. */
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
    audits: await writeAudits(s),
    events: await db
      .selectFrom('event_log')
      .selectAll()
      .where('app_id', '=', s.appId)
      .orderBy('id')
      .execute(),
    bindings: await db
      .selectFrom('union_bindings')
      .selectAll()
      .where('app_id', '=', s.appId)
      .orderBy('id')
      .execute(),
    blocklist: await db
      .selectFrom('blocklist')
      .selectAll()
      .where('app_id', '=', s.appId)
      .orderBy('id')
      .execute(),
    orders: await db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', s.appId)
      .orderBy('order_id')
      .execute(),
  };
}

// ---- answers ----

/** A 200 answer carrying the appeal as GET /admin/v1/appeals/{appeal_id} returns it. */
export async function appealOf(response: Response): Promise<Detail> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  return detail(response);
}

/** A refusal: HTTP status of contracts/error-codes.yaml, code, data when given, envelope schema. */
export async function refused(response: Response, code: number, data?: object) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(HTTP[code]);
  expect(response.json().code).toBe(code);
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response, 'ErrorEnvelope');
}

/** No full phone number, phone HMAC or hit value of `secrets` anywhere in `value`. */
export function noPersonalData(value: unknown, secrets: readonly (string | null)[]) {
  const serialized = text(value);
  for (const secret of secrets) {
    if (secret !== null) expect(serialized.includes(secret), `leaked ${secret}`).toBe(false);
  }
}
