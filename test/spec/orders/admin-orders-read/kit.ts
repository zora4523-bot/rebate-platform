import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import type { Insertable } from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  account,
  apiRequire,
  fixture,
  signedIn,
  type Fixture,
  type Harness,
  type Response,
} from '../../admin/auth/kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

export const PATH = '/admin/v1/orders';
export const PAID_AT = '2026-10-06T02:58:40.000Z';
export const SPLIT_AT = '2026-10-06T03:00:00.000Z';
/** Audit action of a manual hold (POST /admin/v1/orders/{order_id}/hold; B1-09l). */
export const HOLD = 'order_hold';
export const UNHOLD = 'order_unhold';
export const NO_HOLD = {
  last_hold_by: null,
  last_hold_by_name: null,
  last_hold_note: null,
  last_hold_at: null,
};
export const UNATTRIBUTED = {
  user_id: null,
  user_basis: null,
  buy_type: null,
  scene_basis: null,
  rebate_status: 'UNATTRIBUTED',
} satisfies Partial<Insertable<DB['orders']>>;
export const ids = (page: Schema<'AdminOrderPage'>) => page.items.map((r) => r.order_id);
export const token = () => randomUUID().replaceAll('-', '').toUpperCase();

/** Both reads registered on this entry. */
export function mounted(f: Fixture) {
  const server = f.app.getHttpAdapter().getInstance();
  return [PATH, `${PATH}/:order_id`].map((url) => server.hasRoute({ method: 'GET', url }));
}

// Real admin entry, credentials, operation guard and repositories; no replacement HTTP routes.
export async function setup(
  h: Harness,
  options: { grants?: readonly string[]; isSuper?: boolean } = {},
) {
  const appId = `orders_${randomUUID().replaceAll('-', '')}`;
  const f = await fixture(h);
  expect(mounted(f), 'GET /admin/v1/orders and /{order_id} on the admin entry').toEqual([
    true,
    true,
  ]);
  const a = await account(h, { app_id: appId, is_super: options.isSuper ?? false });
  await h.db
    .updateTable('admin_users')
    .set({
      totp_secret_cipher: Buffer.from(
        h.fields.encrypt(a.secret, `admin_users.totp_secret:${appId}:${a.id}`),
      ),
    })
    .where('id', '=', a.id)
    .execute();
  for (const key of options.grants ?? ['order.view']) {
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
  const userId = await seedUser(h.db, appId);
  const session = await signedIn(f, a);
  const get = (
    query: Record<string, string> = {},
    orderId?: string,
    headers: Record<string, string> = {},
  ) =>
    f.read(
      session.admin_token,
      `${PATH}${orderId === undefined ? '' : `/${orderId}`}?${new URLSearchParams(query)}`,
      headers,
    );
  const snapshot = async () => ({
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
    pending: await h.db
      .selectFrom('order_sync_pending')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    splits: await h.db
      .selectFrom('commission_splits')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('order_id')
      .execute(),
    audits: await h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  });
  return { h, f, a, appId, userId, get, snapshot };
}
export type Scenario = Awaited<ReturnType<typeof setup>>;

/** One sub-order (order_keys + orders), attributed to the scenario's user unless patched. */
export async function order(s: Scenario, patch: Partial<Insertable<DB['orders']>> = {}) {
  const values = {
    order_id: randomUUID(),
    app_id: s.appId,
    platform: 'jd',
    sub_order_id: `SUB-${token()}`,
    parent_order_id: `PARENT-${token()}`,
    raw_item_id: 'item-fixture',
    user_id: s.userId,
    user_basis: 'param',
    buy_type: 'self',
    scene_basis: 'param',
    platform_status: 'PAID',
    rebate_status: 'ESTIMATED',
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
export type Order = Awaited<ReturnType<typeof order>>;

export async function history(
  s: Scenario,
  orderId: string,
  rows: readonly Omit<Insertable<DB['order_status_history']>, 'app_id' | 'order_id'>[],
) {
  await s.h.db
    .insertInto('order_status_history')
    .values(rows.map((row) => ({ app_id: s.appId, order_id: orderId, ...row })))
    .execute();
}

/** A commission snapshot; beneficiaries are stored as the commission module stores them. */
export async function split(
  s: Scenario,
  orderId: string,
  beneficiaries: readonly Record<string, unknown>[],
  patch: Partial<Insertable<DB['commission_splits']>> = {},
) {
  const ruleVersionId = randomUUID();
  await s.h.db
    .insertInto('commission_rule_versions')
    .values({
      app_id: s.appId,
      rule_version_id: ruleVersionId,
      status: 'published',
      effective_from: '2026-10-01T00:00:00.000Z',
      indirect_enabled: true,
      created_at: '2026-09-30T00:00:00.000Z',
    })
    .execute();
  await s.h.db
    .insertInto('commission_splits')
    .values({
      app_id: s.appId,
      order_id: orderId,
      rule_version_id: ruleVersionId,
      order_type: 'self',
      activity_type: null,
      rebate_mode: null,
      paid_at: PAID_AT,
      paid_at_source: 'platform',
      raw_n_fen: 1000n,
      subsidy_commission_fen: 20n,
      reserve_bp: 1500,
      reserve_fen: 150n,
      tlj_deduct_fen: 30n,
      base_fen: 840n,
      platform_retain_fen: 298n,
      beneficiaries: JSON.stringify(beneficiaries),
      created_at: SPLIT_AT,
      ...patch,
    })
    .execute();
  return ruleVersionId;
}

/** A links row of the scenario's user; orders.link_id must reference one (orders_link_fkey). */
export async function link(s: Scenario) {
  const linkId = randomUUID();
  await s.h.db
    .insertInto('links')
    .values({
      app_id: s.appId,
      link_id: linkId,
      user_id: s.userId,
      platform: 'jd',
      scene: 'detail',
      product_key: 'jd:secret-product',
      expire_at: '2026-11-01T00:00:00.000Z',
      created_at: '2026-10-05T00:00:00.000Z',
      updated_at: '2026-10-05T00:00:00.000Z',
    })
    .execute();
  return linkId;
}

export async function linkLogs(
  s: Scenario,
  linkId: string,
  rows: readonly Partial<Insertable<DB['link_logs']>>[],
) {
  await s.h.db
    .insertInto('link_logs')
    .values(
      rows.map((row) => ({
        app_id: s.appId,
        link_id: linkId,
        event: 'open',
        result_code: 0,
        scene: 'detail',
        user_id: s.userId,
        platform: 'jd',
        product_key: 'jd:secret-product',
        shop_id: 'secret-shop',
        pid: 'secret-link-pid',
        created_at: '2026-10-05T01:00:00.000Z',
        ...row,
      })),
    )
    .execute();
}

/** A BR-FUND-02 pending record of the order's sub-order (UNMAPPED_STATUS, open unless patched). */
export async function pending(
  s: Scenario,
  o: Order,
  patch: Partial<Insertable<DB['order_sync_pending']>> = {},
) {
  await s.h.db
    .insertInto('order_sync_pending')
    .values({
      app_id: s.appId,
      platform: o.platform,
      sub_order_id: o.sub_order_id,
      order_id: o.order_id,
      reason: 'UNMAPPED_STATUS',
      raw_status: 'UNKNOWN_UNION_STATUS',
      detected_at: '2026-10-07T00:00:00.000Z',
      status: 'open',
      ...patch,
    })
    .execute();
}

/**
 * An audit record as the hold / unhold writer stores it: target `orders:<order_id>`, before and
 * after with hold, hold_reason and note.
 */
export async function audit(
  s: Scenario,
  row: {
    adminId: string;
    orderId: string;
    at: string;
    note: string;
    action?: string;
    reason?: 'RISK' | 'CS';
    appId?: string;
  },
) {
  const action = row.action ?? HOLD;
  const held = { hold: true, hold_reason: row.reason ?? 'CS' };
  const free = { hold: false, hold_reason: null };
  await s.h.db
    .insertInto('audit_logs')
    .values({
      app_id: row.appId ?? s.appId,
      admin_id: row.adminId,
      action,
      target: `orders:${row.orderId}`,
      before: JSON.stringify(action === HOLD ? free : held),
      after: JSON.stringify({ ...(action === HOLD ? held : free), note: row.note }),
      at: row.at,
    })
    .execute();
}

interface Operation {
  operationId: string;
  'x-implementation'?: string;
}
interface Document {
  paths: Record<string, { get: Operation }>;
  components: { schemas: Record<string, JsonSchema> };
}
let document: Promise<Document> | undefined;
export function contract() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<Document>;
  };
  document ??= parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    {
      resolve: { external: false },
    },
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
export async function page(response: Response): Promise<Schema<'AdminOrderPage'>> {
  expect(response.statusCode).toBe(200);
  expect(response.json().code).toBe(0);
  expect(response.headers['cache-control']).toContain('no-store');
  await validate(response, 'AdminOrderPageResponse');
  return response.json<{ data: Schema<'AdminOrderPage'> }>().data;
}
export async function detail(response: Response): Promise<Schema<'AdminOrderDetail'>> {
  expect(response.statusCode).toBe(200);
  expect(response.json().code).toBe(0);
  expect(response.headers['cache-control']).toContain('no-store');
  await validate(response, 'AdminOrderDetailResponse');
  return response.json<{ data: Schema<'AdminOrderDetail'> }>().data;
}
export async function rejected(response: Response, code: number, data?: object) {
  expect(response.statusCode).toBe(code === 20001 ? 400 : code === 10001 ? 401 : 403);
  expect(response.json().code).toBe(code);
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response, 'ErrorEnvelope');
}
