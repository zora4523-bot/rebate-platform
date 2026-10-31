// B1-10m rule-test kit (claude-independent, SPEC_REF 9ab94dc0): the eight operations mounted on the
// admin entry — adminApproveClaimItem, adminRejectClaimItem, adminHoldOrder, adminUnholdOrder,
// adminReassignOrder, adminCreateRightsImport, adminListRightsImports, adminGetRightsImport — over
// the real settlement and risk ports. The use cases have their own rule tests (claims-review,
// admin-assign, admin-hold, rights-import-task, rights-port); here only the mount and the wiring.
// Real pieces: createHttpApp('admin') (admin token, session and permission checks, the step-up gate
// over Redis, contract validation, multipart, the started JOB_QUEUE with its sends recorded and
// passed on), every port app.module injects, PostgreSQL as couli_app; for the import rows the
// worker's real AppModule assembly and its registered order-sync handler.
// Synthetic: orders, claims, members and union accounts seeded as the sync would have left them,
// admin accounts with their sessions and totp step-up tokens issued the way the login and POST
// /admin/v1/auth/step-up issue them, a one-shot fault in the entry's database handle (the audit
// insert of one action) and, in imports.int.test.ts, the column templates (K-3: no real template
// exists yet) and one memory store shared by the two entries of this process (production's is
// one private bucket). No real user or merchant data.
// Missing pieces fail as assertions: an unregistered admin route answers 404.
// Plain SQL always names the schema. Only the container runner executes the integration tests.
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Insertable, type KyselyPlugin } from 'kysely';
import { expect, vi } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { MemoryImportStore } from '../../../../apps/api/src/modules/platform/import-store/index.ts';
import {
  JOB_QUEUE,
  REDIS,
  type JobPayload,
  type JobQueue,
  type ReceivedJob,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  NOW,
  apiRequire,
  fixture,
  type Harness,
  type HttpApp,
  type Request,
  type Response,
} from '../../admin/auth/kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { MULTIPART, form, multipart, sheet, type Part } from '../rights-import-task/kit.ts';

export { NOW };
export const IMPORTS = '/admin/v1/rights-imports';
export const IP = '127.0.0.1';
export const DENIED = { reason: 'admin_permission_denied' };
export const STEP_UP_REQUIRED = { tier: 'totp' };
export const REASON = '证据核实一致，已人工确认';
export const NOTE = '用户反映订单异常，先暂停核实';
export const ADMIN_NAME = '测试运营';
export const PAID_AT = '2026-10-05T16:30:00.000Z';
export const RECEIVED_AT = '2026-10-07T02:00:00.000Z';
const CREATED = '2026-10-08T02:00:00.000Z';

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

/** One send of the entry's JOB_QUEUE (recorded, then passed on to the real queue). */
export interface Sent {
  readonly queue: string;
  readonly name: string;
  readonly payload: JobPayload;
}

interface RawApp {
  inject(request: Omit<Request, 'payload'> & { payload?: string | Buffer }): Promise<Response>;
}

/** Real admin entry on the harness's database through the fault plugin; its own app_id. */
export async function setup(
  h: Harness,
  options: { grants?: readonly string[]; isSuper?: boolean } = {},
) {
  // At most 32 characters: the import store's key takes contracts' AppId.
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

  const queue = f.app.get<JobQueue>(JOB_QUEUE);
  const sent: Sent[] = [];
  const send = queue.send.bind(queue);
  vi.spyOn(queue, 'send').mockImplementation(async (name, job, payload, sendOptions) => {
    const id = await send(name, job, payload, sendOptions);
    sent.push({ queue: name, name: job, payload: structuredClone(payload) });
    return id;
  });

  const raw = f.app as unknown as RawApp;
  const call = (
    method: 'GET' | 'POST',
    url: string,
    payload: string | Buffer | undefined,
    headers: Record<string, string>,
    options: Send,
  ): Promise<Response> => {
    const who = options.caller === undefined ? admin : options.caller;
    return raw.inject({
      method,
      url,
      remoteAddress: IP,
      headers: {
        ...(who === null ? {} : { authorization: `Bearer ${who.token}` }),
        ...(options.stepUp === undefined ? {} : { 'x-step-up-token': options.stepUp }),
        ...headers,
      },
      ...(payload === undefined ? {} : { payload }),
    });
  };
  const post = (url: string, body: unknown, options: Send = {}) =>
    call('POST', url, JSON.stringify(body), { 'content-type': 'application/json' }, options);
  const get = (url: string, options: Send = {}) => call('GET', url, undefined, {}, options);
  const upload = (parts: readonly Part[], options: Send = {}) =>
    call('POST', IMPORTS, multipart(parts), { 'content-type': MULTIPART }, options);

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
    imports: await h.db
      .selectFrom('rights_imports')
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
    sends: sent.length,
  });
  /** The event names of the app's event_log, in insertion order. */
  const events = async (): Promise<string[]> => {
    const result = await sql<{ name: string }>`
      SELECT name FROM app.event_log WHERE app_id = ${appId} ORDER BY id`.execute(h.db);
    return result.rows.map((row) => row.name);
  };
  /** The one rights_import job of a task. */
  const importJob = (importId: string): Sent => {
    const jobs = sent.filter(
      (job) =>
        job.queue === 'order-sync' &&
        job.name === 'rights_import' &&
        job.payload['import_id'] === importId,
    );
    expect(jobs, `one rights_import job of ${importId}`).toHaveLength(1);
    return jobs[0]!;
  };

  return {
    h,
    f,
    appId,
    fault,
    admin,
    userId,
    sent,
    caller,
    stepUp,
    post,
    get,
    upload,
    state,
    events,
    importJob,
  };
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

/** A union account of the scenario's app. */
export async function seedUnionAccount(s: Scenario, platform = 'taobao'): Promise<string> {
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

/** A finished import task written directly (for the detail route). */
export async function seedImport(s: Scenario): Promise<string> {
  const id = randomUUID();
  const now = s.f.clock.now();
  await s.h.db
    .insertInto('rights_imports')
    .values({
      id,
      app_id: s.appId,
      kind: 'rights',
      platform: 'jd',
      union_account_id: null,
      time_basis: null,
      from: null,
      to: null,
      file_path: `${s.appId}/${id}.xlsx`,
      status: 'done',
      total_rows: 0,
      succeeded_rows: 0,
      failed_rows: 0,
      skipped_rows: 0,
      duplicate_rows: 0,
      created_by: s.admin.id,
      created_at: now,
      finished_at: now,
    })
    .execute();
  return id;
}

// ---------------------------------------------------------------------------------------------
// One valid request of each operation (the channel import is a second case of the same route).

export type Action =
  'approve' | 'reject' | 'hold' | 'unhold' | 'reassign' | 'rights' | 'channel' | 'list' | 'detail';

export const ACTIONS: readonly Action[] = [
  'approve',
  'reject',
  'hold',
  'unhold',
  'reassign',
  'rights',
  'channel',
  'list',
  'detail',
];

/** contracts/openapi.yaml, specs/permissions.yaml: what each action needs, and no more. */
export const GRANTS: Readonly<Record<Action, readonly string[]>> = {
  approve: ['order.claim'],
  reject: ['order.claim'],
  hold: ['order.hold'],
  unhold: ['order.hold'],
  reassign: ['order.assign'],
  rights: ['order.claim'],
  channel: ['order.claim', 'risk.blocklist'],
  list: ['order.claim'],
  detail: ['order.claim'],
};

export const NEEDS_STEP_UP: ReadonlySet<Action> = new Set<Action>(['reassign', 'channel']);

/** The success envelope of each action. */
export const ANSWER: Readonly<Record<Action, string>> = {
  approve: 'AdminClaimDetailResponse',
  reject: 'AdminClaimDetailResponse',
  hold: 'AdminOrderDetailResponse',
  unhold: 'AdminOrderDetailResponse',
  reassign: 'AdminOrderDetailResponse',
  rights: 'AdminRightsImportCreateResponse',
  channel: 'AdminRightsImportCreateResponse',
  list: 'AdminRightsImportPageResponse',
  detail: 'AdminRightsImportDetailResponse',
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
    case 'rights': {
      const parts = form({ kind: 'rights', platform: 'jd' }, sheet(['succeeded']));
      return (options) => s.upload(parts, options);
    }
    case 'channel': {
      const accountId = await seedUnionAccount(s);
      const fields = { kind: 'channel', platform: 'taobao', union_account_id: accountId };
      const parts = form(fields, sheet(['succeeded']));
      return (options) => s.upload(parts, options);
    }
    case 'list':
      return (options) => s.get(`${IMPORTS}?page=1&page_size=20`, options);
    case 'detail': {
      const importId = await seedImport(s);
      return (options) => s.get(`${IMPORTS}/${importId}`, options);
    }
  }
}

/** The options of a request the action accepts from the scenario's own account. */
export async function allowed(s: Scenario, action: Action): Promise<Send> {
  return NEEDS_STEP_UP.has(action) ? { stepUp: await s.stepUp(s.admin) } : {};
}

// ---------------------------------------------------------------------------------------------
// The worker's real assembly, for the rights_import job the admin entry sent.

type Handle = (job: ReceivedJob) => Promise<void>;

interface Context {
  close(): Promise<void>;
}

/**
 * The worker entry's AppModule on the harness's database and keyring, with an in-memory queue
 * runtime (never polled; `run` hands a recorded send to the handler the worker registered).
 */
export async function worker(h: Harness) {
  // URL imports keep decorated HTTP controllers out of the spec project's TS compilation.
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: object): unknown } };
  const { PlatformModule } = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as { PlatformModule: { forRoot(options: object): { providers?: unknown[] } } };
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: { createApplicationContext(module: unknown, options: object): Promise<Context> };
  };
  const queue = {
    send: vi.fn(async () => 'fixture'),
    register: vi.fn<(name: string, handler: Handle) => void>(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const original = PlatformModule.forRoot.bind(PlatformModule);
  const spy = vi.spyOn(PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = original(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === JOB_QUEUE
          ? { provide: JOB_QUEUE, useValue: queue }
          : provider,
      ),
    };
  });
  try {
    const context = await NestFactory.createApplicationContext(
      AppModule.forEntry({
        entry: 'worker',
        config: loadConfig(h.env),
        clock: new FixedClock(NOW),
        logger: memoryLogger().logger,
        dbHandles: { db: h.db, dbRead: null, close: async () => undefined },
      }),
      { logger: false, abortOnError: false },
    );
    h.apps.push(context as unknown as HttpApp);
  } finally {
    spy.mockRestore();
  }
  const handle = queue.register.mock.calls.find(([name]) => name === 'order-sync')?.[1];
  expect(typeof handle, 'order-sync handler registered by the worker').toBe('function');
  return {
    run: (send: Sent) =>
      handle!(
        Object.freeze({
          id: randomUUID(),
          queue: send.queue,
          name: send.name,
          payload: structuredClone(send.payload),
          attempt: 1,
        }),
      ),
  };
}

/**
 * Both entries' memory stores read and write one set of files: each entry of this process builds
 * its own stand-in (production's two processes share one private bucket).
 */
export function shareImportStore(): void {
  const files = new Map<string, Uint8Array>();
  vi.spyOn(MemoryImportStore.prototype, 'put').mockImplementation(async (input) => {
    files.set(input.key, new Uint8Array(input.bytes));
  });
  vi.spyOn(MemoryImportStore.prototype, 'get').mockImplementation(async (key) => {
    const stored = files.get(key);
    return stored === undefined ? null : new Uint8Array(stored);
  });
}
