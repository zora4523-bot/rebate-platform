// B1-10m rule-test kit (claude-independent, SPEC_REF 9ab94dc0): the five operations mounted on the
// admin entry — adminApproveClaimItem, adminRejectClaimItem, adminHoldOrder, adminUnholdOrder,
// adminReassignOrder — over the real settlement and risk ports. The use cases have their own rule
// tests (claims-review, admin-assign, admin-hold); here only the mount and the wiring.
// Real pieces: createHttpApp('admin') (admin token, session and permission checks, the step-up gate
// over Redis, contract validation, the started JOB_QUEUE), every port app.module injects,
// PostgreSQL as couli_app.
// Synthetic: orders, claims, members, union accounts, promotion slots and clicks seeded as the sync
// and the link flow would have left them, admin accounts with their sessions and totp step-up
// tokens issued the way the login and POST /admin/v1/auth/step-up issue them, and a one-shot fault
// in the entry's database handle (the audit insert of one action). No real user or merchant data.
// Missing pieces fail as assertions: an unregistered admin route answers 404.
// Plain SQL always names the schema. Only the container runner executes the integration tests.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Insertable, type KyselyPlugin } from 'kysely';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import { REDIS, type RedisHandle } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  NOW,
  apiRequire,
  fixture,
  type Harness,
  type Request,
  type Response,
} from '../../admin/auth/kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';

export { NOW };
export const IP = '127.0.0.1';
export const DENIED = { reason: 'admin_permission_denied' };
export const STEP_UP_REQUIRED = { tier: 'totp' };
export const REASON = '证据核实一致，已人工确认';
export const NOTE = '用户反映订单异常，先暂停核实';
export const ADMIN_NAME = '测试运营';
export const PAID_AT = '2026-10-05T16:30:00.000Z';
export const RECEIVED_AT = '2026-10-07T02:00:00.000Z';
const CREATED = '2026-10-08T02:00:00.000Z';
/** Inside BR-ATTR-13 ③'s window before PAID_AT (the orders' attr_at). */
const CLICKED_AT = '2026-10-05T10:00:00.000Z';

export const itemPath = (claimId: string, itemId: string, action: 'approve' | 'reject') =>
  `/admin/v1/claims/${claimId}/items/${itemId}/${action}`;
export const orderPath = (orderId: string, action: 'hold' | 'unhold' | 'reassign') =>
  `/admin/v1/orders/${orderId}/${action}`;

// ---------------------------------------------------------------------------------------------
// The contract.

export interface ContractOperation {
  operationId: string;
  'x-auth'?: string;
  'x-implementation'?: string;
  'x-error-codes'?: number[];
}
interface Document {
  paths: Record<string, Record<string, ContractOperation>>;
  components: { schemas: Record<string, JsonSchema> };
}
let document: Promise<Document> | undefined;

export function contract(): Promise<Document> {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<Document>;
  };
  document ??= parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  return document;
}

export async function validate(response: Response, name: string): Promise<void> {
  const check = createValidatorCompiler()({
    schema: (await contract()).components.schemas[name]!,
    httpPart: 'body',
  });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}

/** HTTP 200, code 0, the contract's envelope; the data. */
export async function accepted<T = Record<string, unknown>>(
  response: Response,
  schema: string,
): Promise<T> {
  expect(response.statusCode, `HTTP status of a request answered with ${schema}`).toBe(200);
  expect(response.json().code).toBe(0);
  await validate(response, schema);
  return response.json<{ data: T }>().data;
}

const HTTP_STATUS: Readonly<Record<number, number>> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20902: 409,
  50001: 500,
};

export async function refused(response: Response, code: number, data?: object): Promise<void> {
  expect(response.statusCode, `HTTP status of a refusal with ${code}`).toBe(HTTP_STATUS[code]);
  expect(response.json().code).toBe(code);
  if (data !== undefined) expect(response.json().data).toEqual(data);
  if (code !== 50001) await validate(response, 'ErrorEnvelope');
}

// ---------------------------------------------------------------------------------------------
// A one-shot fault in the entry's database handle: the audit insert of one action.

export interface Fault {
  /** One-shot: set it, the next audit insert of this action fails and it goes back to null. */
  action: string | null;
  tripped: number;
}

function serialized(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ) ?? ''
  );
}

function rawText(node: Record<string, unknown>): string {
  const fragments = node['sqlFragments'];
  return Array.isArray(fragments) ? fragments.join(' ') : '';
}

function audited(node: Record<string, unknown>, action: string): boolean {
  const into =
    node['kind'] === 'InsertQueryNode'
      ? serialized(node['into']).includes('"audit_logs"')
      : node['kind'] === 'RawNode' &&
        /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?audit_logs\b/i.test(rawText(node));
  return into && serialized(node).includes(JSON.stringify(action));
}

function faultPlugin(fault: Fault): KyselyPlugin {
  return {
    transformQuery({ node }) {
      const { action } = fault;
      if (action !== null && audited(node as unknown as Record<string, unknown>, action)) {
        fault.action = null;
        fault.tripped += 1;
        throw new Error(`synthetic failure at the ${action} audit`);
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export interface Caller {
  readonly id: string;
  readonly token: string;
  readonly sessionId: string;
}

export interface Send {
  /** The caller: the scenario's account by default; null sends no admin token. */
  readonly caller?: Caller | null;
  /** X-Step-Up-Token; none by default. */
  readonly stepUp?: string;
}

/** Real admin entry on the harness's database through the fault plugin; its own app_id. */
export async function setup(
  h: Harness,
  options: { grants?: readonly string[]; isSuper?: boolean } = {},
) {
  // At most 32 characters (contracts' AppId).
  const appId = `am_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const fault: Fault = { action: null, tripped: 0 };
  const f = await fixture({ ...h, db: h.db.withPlugin(faultPlugin(fault)) });
  const redis = f.app.get<RedisHandle>(REDIS);
  const tokenKey = Buffer.from(h.env['ADMIN_TOKEN_SIGNING_KEY']!, 'base64url');

  const caller = async (
    grants: readonly string[],
    who: { readonly isSuper?: boolean } = {},
  ): Promise<Caller> => {
    const id = randomUUID();
    const now = f.clock.now();
    await h.db
      .insertInto('admin_users')
      .values({
        id,
        app_id: appId,
        login_name: `mount_${id}`,
        password_hash: 'unused-test-login',
        is_super: who.isSuper === true,
        status: 'active',
        display_name: ADMIN_NAME,
        password_must_change: false,
        totp_bound_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    if (grants.length > 0) {
      await h.db
        .insertInto('admin_permissions')
        .values(
          grants.map((permission_key) => ({
            app_id: appId,
            admin_id: id,
            permission_key,
            granted_by: id,
            granted_at: now,
          })),
        )
        .execute();
    }
    const { token, claims } = await createAdminTokens({ key: tokenKey, clock: f.clock }).issue({
      adminId: id,
      appId,
    });
    await createAdminSessions({ redis: redis.namespace('admin-auth'), clock: f.clock }).create(
      claims.sessionId,
      {
        adminId: id,
        appId,
        expiresAtMs: claims.expiresAt * 1000,
        lastSeenMs: now.getTime(),
      },
    );
    return { id, token, sessionId: claims.sessionId };
  };
  /** A totp-tier step-up token of the caller's account and admin session. */
  const stepUp = async (who: Caller): Promise<string> => {
    const grant = await createAdminStepUpTokens({
      clock: f.clock,
      redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
    }).issue({ appId, adminId: who.id, sessionId: who.sessionId, tier: 'totp' });
    return grant.step_up_token;
  };

  const admin = await caller(options.grants ?? [], { isSuper: options.isSuper === true });
  const userId = await seedUser(h.db, appId);

  const post = (url: string, body: unknown, options: Send = {}): Promise<Response> => {
    const who = options.caller === undefined ? admin : options.caller;
    return f.app.inject({
      method: 'POST',
      url,
      remoteAddress: IP,
      headers: {
        'content-type': 'application/json',
        ...(who === null ? {} : { authorization: `Bearer ${who.token}` }),
        ...(options.stepUp === undefined ? {} : { 'x-step-up-token': options.stepUp }),
      },
      payload: JSON.stringify(body),
    } satisfies Request);
  };

  /** The event names of the app's event_log, in insertion order. */
  const events = async (): Promise<string[]> => {
    const result = await sql<{ name: string }>`
      SELECT name FROM app.event_log WHERE app_id = ${appId} ORDER BY id`.execute(h.db);
    return result.rows.map((row) => row.name);
  };
  const state = async () => ({
    orders: await h.db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('order_id')
      .execute(),
    history: await h.db
      .selectFrom('order_status_history')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    assignments: await h.db
      .selectFrom('order_assignments')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    claims: await h.db
      .selectFrom('claims')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    items: await h.db
      .selectFrom('claim_items')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    audits: await h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    pending: await h.db
      .selectFrom('order_sync_pending')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    events: await events(),
  });

  return { h, f, appId, fault, admin, userId, caller, stepUp, post, state, events };
}
export type Scenario = Awaited<ReturnType<typeof setup>>;

// ---------------------------------------------------------------------------------------------
// Seeds, as the sync and the submission would have left them.

const unique = () => randomUUID().replaceAll('-', '').toUpperCase();

/** One sub-order (order_keys + orders); unattributed unless patched. */
export async function seedOrder(s: Scenario, patch: Partial<Insertable<DB['orders']>> = {}) {
  const values = {
    order_id: randomUUID(),
    app_id: s.appId,
    platform: 'jd',
    sub_order_id: `SUB-${unique()}`,
    parent_order_id: `PARENT-${unique()}`,
    raw_item_id: 'item-fixture',
    product_key: 'jd:fixture',
    buy_type: 'self',
    platform_status: 'PAID',
    rebate_status: 'UNATTRIBUTED',
    est_commission_fen: 1200n,
    paid_at: PAID_AT,
    attr_at: PAID_AT,
    ...patch,
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
  return s.h.db.insertInto('orders').values(values).returningAll().executeTakeFirstOrThrow();
}
export type Order = Awaited<ReturnType<typeof seedOrder>>;

/** A sub-order attributed to the scenario's user, ESTIMATED unless patched. */
export function attributedOrder(s: Scenario, patch: Partial<Insertable<DB['orders']>> = {}) {
  return seedOrder(s, {
    user_id: s.userId,
    user_basis: 'param',
    scene_basis: 'param',
    rebate_status: 'ESTIMATED',
    ...patch,
  });
}

/** One order as it is now. */
export function orderNow(s: Scenario, orderId: string) {
  return s.h.db
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', s.appId)
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();
}

/** A manual-review claim of the scenario's user with one pending child order of `order`. */
export async function seedClaim(s: Scenario, order: Order) {
  const claim = await s.h.db
    .insertInto('claims')
    .values({
      id: randomUUID(),
      app_id: s.appId,
      user_id: s.userId,
      platform: order.platform,
      order_no: order.parent_order_id!,
      order_no_type: 'parent',
      paid_date: '2026-10-06',
      status: 'manual_review',
      evidence_level: 'none',
      created_at: CREATED,
      updated_at: CREATED,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const item = await s.h.db
    .insertInto('claim_items')
    .values({
      id: randomUUID(),
      app_id: s.appId,
      claim_id: claim.id,
      applicant_user_id: s.userId,
      platform: order.platform,
      sub_order_id: order.sub_order_id,
      order_id: order.order_id,
      evidence: 'none',
      evidence_link_log_ids: [],
      updated_at: CREATED,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { claim, item };
}

/** A user_risk_state row (BR-ID-31); frozen carries a future frozen_until. */
export async function seedRiskState(s: Scenario, userId: string, state: 'banned' | 'frozen') {
  await s.h.db
    .insertInto('user_risk_state')
    .values({
      user_id: userId,
      app_id: s.appId,
      state,
      reason: null,
      reason_category: 'other',
      frozen_until: state === 'frozen' ? '2028-02-01T00:00:00.000Z' : null,
      changed_by: 'synthetic-admin',
      changed_at: s.f.clock.now(),
    })
    .execute();
}

/** An open deletion request still in its cooling window; users.status stays as it is (BR-ID-27). */
export async function seedCoolingDeletion(s: Scenario, userId: string) {
  await s.h.db
    .insertInto('deletion_requests')
    .values({
      id: randomUUID(),
      app_id: s.appId,
      user_id: userId,
      status: 'cooling',
      apply_at: CREATED,
      cooling_until: '2026-10-23T02:00:00.000Z',
      balance_snapshot_fen: 0n,
    })
    .execute();
}

/** A union account of the scenario's app. */
async function seedUnionAccount(s: Scenario, platform: string): Promise<string> {
  const id = randomUUID();
  await s.h.db
    .insertInto('union_accounts')
    .values({
      id,
      app_id: s.appId,
      platform,
      account_name: `synthetic-${id}`,
      status: 'active',
      auth_status: 'active',
    })
    .execute();
  return id;
}

/** An active promotion slot of the scene on its own union account; the slot's pid. */
export async function seedPid(s: Scenario, platform: string, scene: string): Promise<string> {
  const id = randomUUID();
  const pid = `synthetic-pid-${id}`;
  const now = s.f.clock.now();
  await s.h.db
    .insertInto('union_pids')
    .values({
      id,
      app_id: s.appId,
      platform,
      union_account_id: await seedUnionAccount(s, platform),
      site_id: platform === 'taobao' ? `synthetic-site-${id}` : null,
      pid,
      pid_scene: scene,
      status: 'active',
      hjy_ignore_confirmed_at: now,
      hjy_ignore_evidence_path: 'synthetic/evidence',
      created_at: now,
      updated_at: now,
    })
    .execute();
  return pid;
}

/** A link of `order`'s product and the user's successful open of it (BR-ATTR-14); its link_id. */
export async function seedClick(
  s: Scenario,
  order: Order,
  userId: string,
  scene: string,
): Promise<string> {
  const linkId = randomUUID();
  await s.h.db
    .insertInto('links')
    .values({
      link_id: linkId,
      app_id: s.appId,
      user_id: userId,
      platform: order.platform,
      product_key: order.product_key,
      scene: 'search',
      pid_scene: scene,
      expire_at: CREATED,
      created_at: CLICKED_AT,
      updated_at: CLICKED_AT,
    })
    .execute();
  await s.h.db
    .insertInto('link_logs')
    .values({
      app_id: s.appId,
      link_id: linkId,
      event: 'open',
      user_id: userId,
      platform: order.platform,
      product_key: order.product_key,
      scene: 'search',
      pid_scene: scene,
      result_code: 0,
      created_at: CLICKED_AT,
    })
    .execute();
  return linkId;
}

/** The commission snapshot of one order: its commission_splits and commission_split_totals rows. */
export async function snapshotOf(s: Scenario, orderId: string) {
  const splits = await s.h.db
    .selectFrom('commission_splits')
    .selectAll()
    .where('app_id', '=', s.appId)
    .where('order_id', '=', orderId)
    .execute();
  const totals = await s.h.db
    .selectFrom('commission_split_totals')
    .selectAll()
    .where('app_id', '=', s.appId)
    .where('order_id', '=', orderId)
    .execute();
  return { splits, totals };
}

// ---------------------------------------------------------------------------------------------
// One valid request of each operation.

export type Action = 'approve' | 'reject' | 'hold' | 'unhold' | 'reassign';

export const ACTIONS: readonly Action[] = ['approve', 'reject', 'hold', 'unhold', 'reassign'];

/** contracts/openapi.yaml, specs/permissions.yaml: what each action needs, and no more. */
export const GRANTS: Readonly<Record<Action, readonly string[]>> = {
  approve: ['order.claim'],
  reject: ['order.claim'],
  hold: ['order.hold'],
  unhold: ['order.hold'],
  reassign: ['order.assign'],
};

export const NEEDS_STEP_UP: ReadonlySet<Action> = new Set<Action>(['reassign']);

/** The success envelope of each action. */
export const ANSWER: Readonly<Record<Action, string>> = {
  approve: 'AdminClaimDetailResponse',
  reject: 'AdminClaimDetailResponse',
  hold: 'AdminOrderDetailResponse',
  unhold: 'AdminOrderDetailResponse',
  reassign: 'AdminOrderDetailResponse',
};

/** The rows one action needs, and its request. */
export async function arrange(
  s: Scenario,
  action: Action,
): Promise<(options?: Send) => Promise<Response>> {
  switch (action) {
    case 'approve':
    case 'reject': {
      const verb = action;
      const { claim, item } = await seedClaim(s, await seedOrder(s));
      const base = { expected_row_version: item.row_version, reason: REASON };
      const body = verb === 'approve' ? base : { ...base, reject_reason: 'NO_EVIDENCE' };
      return (options) => s.post(itemPath(claim.id, item.id, verb), body, options);
    }
    case 'hold':
    case 'unhold': {
      const verb = action;
      const held: Partial<Insertable<DB['orders']>> =
        verb === 'unhold' ? { hold: true, hold_reason: 'CS' } : {};
      const order = await attributedOrder(s, held);
      const body = { reason_code: 'CS', note: NOTE, expected_row_version: order.row_version };
      return (options) => s.post(orderPath(order.order_id, verb), body, options);
    }
    case 'reassign': {
      const order = await seedOrder(s);
      const body = {
        user_id: s.userId,
        expected_user_id: null,
        expected_locked: order.locked,
        reason: REASON,
      };
      return (options) => s.post(orderPath(order.order_id, 'reassign'), body, options);
    }
  }
}

/** The options of a request the action accepts from the scenario's own account. */
export async function allowed(s: Scenario, action: Action): Promise<Send> {
  return NEEDS_STEP_UP.has(action) ? { stepUp: await s.stepUp(s.admin) } : {};
}
