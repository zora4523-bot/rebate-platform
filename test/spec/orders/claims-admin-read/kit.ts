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
  type Harness,
  type Response,
} from '../../admin/auth/kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

export const PATH = '/admin/v1/claims';
export const PAID = '2026-10-06';
export const CREATED = '2026-10-08T02:00:00.000Z';
export const ZERO = {
  submitted: 0,
  auto_matched: 0,
  manual_review: 0,
  approved: 0,
  rejected: 0,
  cancelled: 0,
};
export const ids = (page: Schema<'AdminClaimPage'>) => page.items.map((r) => r.claim_id);

// Real admin entry, credentials, operation guard and repositories; no replacement HTTP routes.
export async function setup(
  h: Harness,
  options: { grants?: readonly string[]; isSuper?: boolean; appId?: string } = {},
) {
  const appId = options.appId ?? `claims_${randomUUID().replaceAll('-', '')}`;
  const f = await fixture(h);
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
  for (const key of options.grants ?? ['order.claim']) {
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
  const get = (query: Record<string, string> = {}, claimId?: string, headers = {}) =>
    f.read(
      session.admin_token,
      `${PATH}${claimId === undefined ? '' : `/${claimId}`}?${new URLSearchParams(query)}`,
      headers,
    );
  const snapshot = async () => ({
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
    orders: await h.db
      .selectFrom('orders')
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

export async function log(s: Scenario, patch: Partial<Insertable<DB['link_logs']>> = {}) {
  return s.h.db
    .insertInto('link_logs')
    .values({
      app_id: s.appId,
      user_id: s.userId,
      platform: 'jd',
      event: 'open',
      result_code: 0,
      scene: 'detail',
      product_key: 'jd:fixture',
      created_at: '2026-10-05T01:00:00.000Z',
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function claim(s: Scenario, patch: Partial<Insertable<DB['claims']>> = {}) {
  return s.h.db
    .insertInto('claims')
    .values({
      id: randomUUID(),
      app_id: s.appId,
      user_id: s.userId,
      platform: 'jd',
      order_no: `parent-${randomUUID()}`,
      order_no_type: 'parent',
      paid_date: PAID,
      status: 'manual_review',
      evidence_level: 'none',
      created_at: CREATED,
      updated_at: CREATED,
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
export type Claim = Awaited<ReturnType<typeof claim>>;

export async function seed(s: Scenario, patch: Partial<Insertable<DB['claims']>> = {}) {
  const c = await claim(s, patch);
  const evidence = c.evidence_level;
  const links =
    evidence === 'strong' || evidence === 'weak'
      ? [(await log(s, { user_id: c.user_id, platform: c.platform })).id]
      : [];
  const decision = ['approved', 'rejected', 'cancelled'].includes(c.status) ? c.status : null;
  await item(s, c, {
    evidence,
    evidence_link_log_ids: evidence === null ? null : links,
    decision,
    decided_at: decision === null ? null : CREATED,
    reject_reason: decision === 'rejected' ? 'NO_EVIDENCE' : null,
  });
  return c;
}

export async function item(
  s: Scenario,
  c: Claim,
  patch: Partial<Insertable<DB['claim_items']>> = {},
  orderPatch: Partial<Insertable<DB['orders']>> = {},
) {
  const order = {
    order_id: randomUUID(),
    app_id: c.app_id,
    platform: c.platform,
    sub_order_id: `child-${randomUUID()}`,
    parent_order_id: c.order_no,
    raw_item_id: 'fixture',
    product_key: 'jd:fixture',
    platform_status: 'PAID',
    paid_at: '2026-10-05T16:30:00.000Z',
    attr_at: '2026-10-05T16:30:00.000Z',
    ...orderPatch,
  } satisfies Insertable<DB['orders']>;
  await s.h.db
    .insertInto('order_keys')
    .values({
      order_id: order.order_id,
      app_id: order.app_id,
      platform: order.platform,
      sub_order_id: order.sub_order_id,
      attr_at: order.attr_at,
    })
    .execute();
  await s.h.db.insertInto('orders').values(order).execute();
  return s.h.db
    .insertInto('claim_items')
    .values({
      id: randomUUID(),
      app_id: c.app_id,
      claim_id: c.id,
      applicant_user_id: c.user_id,
      platform: c.platform,
      sub_order_id: order.sub_order_id,
      order_id: order.order_id,
      evidence: 'none',
      evidence_link_log_ids: [],
      updated_at: CREATED,
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
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
export async function page(response: Response): Promise<Schema<'AdminClaimPage'>> {
  expect(response.statusCode).toBe(200);
  expect(response.json().code).toBe(0);
  expect(response.headers['cache-control']).toContain('no-store');
  await validate(response, 'AdminClaimPageResponse');
  return response.json<{ data: Schema<'AdminClaimPage'> }>().data;
}
export async function detail(response: Response): Promise<Schema<'AdminClaimDetail'>> {
  expect(response.statusCode).toBe(200);
  expect(response.json().code).toBe(0);
  expect(response.headers['cache-control']).toContain('no-store');
  await validate(response, 'AdminClaimDetailResponse');
  return response.json<{ data: Schema<'AdminClaimDetail'> }>().data;
}
export async function rejected(response: Response, code: number, data?: object) {
  expect(response.statusCode).toBe(code === 20001 ? 400 : code === 10001 ? 401 : 403);
  expect(response.json().code).toBe(code);
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response, 'ErrorEnvelope');
}
