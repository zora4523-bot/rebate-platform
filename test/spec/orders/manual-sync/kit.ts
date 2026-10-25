// B1-09i: the console's manual order sync through the real admin entry (credentials, operation
// guard, route validation, repositories; the sends of the entry's JOB_QUEUE are recorded).
// Every scenario owns its app_id; couli_app has no DELETE, nothing is cleaned up. Only the
// container runner executes the integration tests that import this file.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import type { Insertable } from 'kysely';
import { expect, vi } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  JOB_QUEUE,
  type JobPayload,
  type JobQueue,
  type ReceivedJob,
  type SendOptions,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  account,
  apiRequire,
  fixture,
  NOW,
  signedIn,
  type Fixture,
  type Harness,
  type Response,
} from '../../admin/auth/kit.ts';

export { NOW };
export const PATH = '/admin/v1/order-syncs';
export const LIMITS = `${PATH}/limits`;
export const MIN = 60_000;
export const DAY = 86_400_000;
/** Pinduoduo's window cap (02 §7.1 table: 30 minutes). */
export const PDD_CAP = 30 * MIN;
export const NOW_MS = Date.parse(NOW);
export const iso = (ms: number) => new Date(ms).toISOString();
export const DENIED = { reason: 'admin_permission_denied' };

export type Created = Schema<'AdminOrderSyncCreated'>;
export type Page = Schema<'AdminOrderSyncPage'>;
export type Limits = Schema<'AdminOrderSyncLimits'>;

/** One send the admin entry made, with the id the real queue answered. */
export interface Sent {
  readonly queue: string;
  readonly name: string;
  readonly payload: JobPayload;
  readonly options: SendOptions;
  readonly id: string | null;
}

/** POST and GET /admin/v1/order-syncs, GET /limits registered on this entry. */
export function mounted(f: Fixture) {
  const server = f.app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(options: { method: string; url: string }): boolean;
  };
  return [
    server.hasRoute({ method: 'POST', url: PATH }),
    server.hasRoute({ method: 'GET', url: PATH }),
    server.hasRoute({ method: 'GET', url: LIMITS }),
  ];
}

export async function setup(
  h: Harness,
  options: { grants?: readonly string[]; isSuper?: boolean; displayName?: string } = {},
) {
  const appId = `msync_${randomUUID().replaceAll('-', '')}`;
  const f = await fixture(h);
  expect(mounted(f), 'POST / GET /admin/v1/order-syncs and GET /limits on the admin entry').toEqual(
    [true, true, true],
  );
  const a = await account(h, {
    app_id: appId,
    is_super: options.isSuper ?? false,
    display_name: options.displayName ?? null,
  });
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
  const session = await signedIn(f, a);
  // Recorded, not inserted: a request that ends releases its jobs' keys in production, which a
  // queue nobody works here never would; the window jobs are handed to the worker by hand.
  const queue = f.app.get<JobQueue>(JOB_QUEUE);
  const sent: Sent[] = [];
  vi.spyOn(queue, 'send').mockImplementation(async (name, job, payload, sendOptions) => {
    const id = randomUUID();
    sent.push({ queue: name, name: job, payload, options: sendOptions, id });
    return id;
  });
  const request = (
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    f.app.inject({
      method,
      url,
      remoteAddress: '127.0.0.1',
      headers: {
        authorization: `Bearer ${session.admin_token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    request('POST', PATH, body, headers);
  const list = (query: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    request('GET', `${PATH}?${new URLSearchParams(query)}`, undefined, headers);
  const limits = (headers: Record<string, string> = {}) =>
    request('GET', LIMITS, undefined, headers);
  const rows = () =>
    h.db
      .selectFrom('order_sync_requests')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  const cursors = () =>
    h.db.selectFrom('sync_cursors').selectAll().where('app_id', '=', appId).orderBy('id').execute();
  const audits = () =>
    h.db.selectFrom('audit_logs').selectAll().where('app_id', '=', appId).orderBy('id').execute();
  /** The sends to the order-sync queue so far. */
  const jobs = () => sent.filter((s) => s.queue === 'order-sync');
  return { h, f, a, appId, session, sent, jobs, post, list, limits, rows, cursors, audits };
}
export type Scenario = Awaited<ReturnType<typeof setup>>;

/** A union account of the scenario's app (site authorization active unless patched). */
export async function unionAccount(
  s: Scenario,
  platform: 'taobao' | 'jd' | 'pdd' = 'pdd',
  patch: Partial<Insertable<DB['union_accounts']>> = {},
) {
  const row = {
    id: randomUUID(),
    app_id: s.appId,
    platform,
    account_name: 'synthetic',
    status: 'pending',
    auth_status: 'active',
    sync_start_at: '2026-09-01T00:00:00.000Z',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...patch,
  } satisfies Insertable<DB['union_accounts']>;
  await s.h.db.insertInto('union_accounts').values(row).execute();
  return row;
}

/** The increment cursor of the account's stream (platform, account, 'increment', '-'). */
export async function cursor(s: Scenario, acc: { id: string; platform: string }, at: string) {
  await s.h.db
    .insertInto('sync_cursors')
    .values({
      app_id: s.appId,
      platform: acc.platform,
      union_account_id: acc.id,
      query_kind: 'increment',
      scene: '-',
      cursor_at: at,
      updated_at: at,
    })
    .execute();
}

/** A request row as the orders writer stores it, for the read side. */
export async function seedRequest(
  s: Scenario,
  patch: Partial<Insertable<DB['order_sync_requests']>> = {},
) {
  return s.h.db
    .insertInto('order_sync_requests')
    .values({
      id: randomUUID(),
      app_id: s.appId,
      platform: 'pdd',
      mode: 'window',
      from: iso(NOW_MS - 5 * DAY),
      to: iso(NOW_MS - 4 * DAY),
      status_filter: null,
      order_nos: null,
      filter_digest: randomUUID().replaceAll('-', '').repeat(2),
      status: 'done',
      requested_by: s.a.id,
      fetched_count: 0,
      stored_count: 0,
      error: null,
      created_at: iso(NOW_MS - DAY),
      finished_at: iso(NOW_MS - DAY + MIN),
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** A payload string field; anything else is an assertion failure. */
export function text(payload: JobPayload, key: string): string {
  const value = payload[key];
  expect(typeof value, `payload.${key}`).toBe('string');
  return value as string;
}

/** The window jobs sorted by start, with their bounds as epoch ms. */
export function windows(sent: readonly Sent[]) {
  return sent
    .map((s) => ({
      sent: s,
      start: Date.parse(text(s.payload, 'window_start')),
      end: Date.parse(text(s.payload, 'window_end')),
    }))
    .sort((x, y) => x.start - y.start);
}

/** 02 §7.1: `platform:account:kind:scene:manual:<filter digest>:window_start`. */
export function manualKey(payload: JobPayload, digest: string) {
  return [
    text(payload, 'platform'),
    text(payload, 'union_account_id'),
    text(payload, 'query_kind'),
    text(payload, 'scene'),
    'manual',
    digest,
    text(payload, 'window_start'),
  ].join(':');
}

/** What the worker's order-sync handler receives for a send. */
export function received(s: Sent, attempt = 1): ReceivedJob {
  return { id: s.id ?? randomUUID(), queue: s.queue, name: s.name, payload: s.payload, attempt };
}

const OPERATIONS = {
  create: [PATH, 'post'],
  list: [PATH, 'get'],
  limits: [LIMITS, 'get'],
} as const;
export type Operation = keyof typeof OPERATIONS;

interface ContractOperation {
  responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
}
let document: Promise<{ paths: Record<string, Record<string, ContractOperation>> }> | undefined;
function contract() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(path: string, options: object): NonNullable<typeof document>;
  };
  document ??= parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  return document;
}
async function validate(response: Response, op: Operation) {
  const [path, method] = OPERATIONS[op];
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contract()).paths[path]![method]!.responses[status]!.content[
    'application/json'
  ]!.schema;
  const check = createValidatorCompiler()({ schema, httpPart: 'body' });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}

export async function ok<T>(response: Response, op: Operation): Promise<T> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response, op);
  return response.json<{ data: T }>().data;
}

export async function rejected(response: Response, op: Operation, code: number, data?: object) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(
    code === 20001 ? 400 : code === 10001 ? 401 : code === 10403 ? 403 : code === 30156 ? 422 : 500,
  );
  expect(response.json()).toMatchObject({ code });
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response, op);
}

/** 20001 naming exactly these fields (any order). */
export async function fields(response: Response, op: Operation, expected: readonly string[]) {
  await rejected(response, op, 20001);
  const data = response.json<{ data: { fields: string[] } }>().data;
  expect(Object.keys(data)).toEqual(['fields']);
  expect([...data.fields].sort()).toEqual([...expected].sort());
}

/** 20001 naming at least one field, every one of them out of `allowed`. */
export async function someFields(response: Response, op: Operation, allowed: readonly string[]) {
  await rejected(response, op, 20001);
  const data = response.json<{ data: { fields: string[] } }>().data;
  expect(data.fields.length).toBeGreaterThan(0);
  for (const field of data.fields) expect(allowed).toContain(field);
}
