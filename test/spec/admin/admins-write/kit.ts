import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { detail, page, seed, type Seed } from '../accounts/kit.ts';
import {
  factory,
  fixture,
  READ,
  signedIn,
  SUPER,
  totp,
  type Account as LoginAccount,
  type Fixture,
  type Harness,
  type HttpApp,
  type Response,
} from '../auth/kit.ts';
import { text, validate } from '../exports/kit.ts';
import { error as stepError, ok as stepOk, STEP, type Grant } from '../step-up/kit.ts';

export { harness } from '../exports/kit.ts';
export { text } from '../exports/kit.ts';
export type Account = Schema<'AdminAccount'>;
export type Created = Schema<'AdminCreatedAccount'>;
export type SeedOptions = NonNullable<Parameters<typeof seed>[2]>;

export const PATHS = {
  create: SUPER,
  regenerate: `${SUPER}/{admin_id}/initial-password`,
  disable: `${SUPER}/{admin_id}/disable`,
  enable: `${SUPER}/{admin_id}/enable`,
  reset: `${SUPER}/{admin_id}/totp/reset`,
  rename: `${SUPER}/{admin_id}/display-name`,
} as const;
export type Operation = keyof typeof PATHS;
export const OPERATION_IDS: Record<Operation, string> = {
  create: 'adminCreateAdmin',
  regenerate: 'adminRegenerateAdminInitialPassword',
  disable: 'adminDisableAdmin',
  enable: 'adminEnableAdmin',
  reset: 'adminResetAdminTotp',
  rename: 'adminUpdateAdminDisplayName',
};
export const METHODS: Record<Operation, 'post' | 'put'> = {
  create: 'post',
  regenerate: 'post',
  disable: 'post',
  enable: 'post',
  reset: 'post',
  rename: 'put',
};
/** Operations with a totp-tier step-up (contract); rename has none. */
export const STEP_UP_OPERATIONS = ['create', 'regenerate', 'disable', 'enable', 'reset'] as const;
/** Operations on /admin/v1/admins/{admin_id}/…. */
export const TARGET_OPERATIONS = ['regenerate', 'disable', 'enable', 'reset', 'rename'] as const;
/** A body each operation accepts (create gets a fresh username per call). */
export function bodyOf(operation: Operation): object | undefined {
  if (operation === 'create') {
    return { username: `w-${randomUUID()}`, display_name: '新建测试账号' };
  }
  if (operation === 'disable' || operation === 'reset') return { reason: '已当面核对本人身份' };
  if (operation === 'rename') return { display_name: '改名测试账号' };
  return undefined;
}

const STATUS: Record<number, number> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20902: 409,
  50001: 500,
};

interface Injector {
  inject(request: {
    method: 'POST' | 'PUT';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<Response>;
}

export interface Send {
  readonly token: string;
  readonly id?: string;
  readonly body?: object;
  readonly step?: string;
}

/** Raw request to one of the six operations on `app` (no step-up token unless given). */
export function sender(app: HttpApp) {
  // HttpApp's typed inject lists GET / POST / OPTIONS only; Fastify inject also takes PUT.
  const injector = app as unknown as Injector;
  return (operation: Operation, input: Send): Promise<Response> => {
    const headers: Record<string, string> = { authorization: `Bearer ${input.token}` };
    if (input.body !== undefined) headers['content-type'] = 'application/json';
    if (input.step !== undefined) headers['x-step-up-token'] = input.step;
    return injector.inject({
      method: METHODS[operation] === 'put' ? 'PUT' : 'POST',
      url: PATHS[operation].replace('{admin_id}', input.id ?? ''),
      headers,
      remoteAddress: '127.0.0.1',
      ...(input.body === undefined ? {} : { payload: JSON.stringify(input.body) }),
    });
  };
}

export async function ok<T>(response: Response, operation: Operation): Promise<T> {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response, PATHS[operation], METHODS[operation]);
  return response.json<{ data: T }>().data;
}

/** An error envelope of the operation; `data` is compared exactly when given. */
export async function error(
  response: Response,
  operation: Operation,
  code: 10001 | 10003 | 10403 | 20001 | 20902 | 50001,
  data?: object,
) {
  expect(response.statusCode).toBe(STATUS[code]);
  expect(response.json()).toMatchObject({ code });
  if (data !== undefined) expect(response.json<{ data?: unknown }>().data).toEqual(data);
  await validate(response, PATHS[operation], METHODS[operation]);
}

/** Same comparison as the F1-06m reads: any contract-valid timezone spelling of a timestamp. */
export function expectAccount(actual: Account, expected: Account) {
  expect({
    ...actual,
    created_at: new Date(actual.created_at).toISOString(),
    locked_until: actual.locked_until === null ? null : new Date(actual.locked_until).toISOString(),
  }).toEqual(expected);
}

/** Real couli_app rows and Redis; only the container runner executes this fixture. */
export async function setup(h: Harness) {
  const f = await fixture(h);
  // export-worker accepts only [a-z0-9_]{1,32} app ids (B1-34e), so the disable path reaches it.
  const appId = `w_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const actor = await seed(h, appId, { isSuper: true, createdAt: '2026-09-01T00:00:00.000Z' });
  const session = await signedIn(f, actor);
  const token = session.admin_token;
  const send = sender(f.app);

  /** A totp-tier step-up token of `who` (its own TOTP step: the clock moves 30 s first). */
  const issue = async (who: Seed = actor, adminToken = token): Promise<string> => {
    f.clock.advanceMs(30_000);
    const grant = await stepOk<Grant>(
      await f.post(
        '/step-up',
        { tier: 'totp', code: totp(who.secret, f.clock) },
        { authorization: `Bearer ${adminToken}` },
      ),
      STEP,
    );
    return grant.step_up_token;
  };

  /** The operation as the super admin, with a fresh step-up token where the contract needs one. */
  const act = async (operation: Operation, id?: string, body = bodyOf(operation)) => {
    const step = operation === 'rename' ? undefined : await issue();
    return send(operation, {
      token,
      ...(id === undefined ? {} : { id }),
      ...(body === undefined ? {} : { body }),
      ...(step === undefined ? {} : { step }),
    });
  };

  const target = (options: SeedOptions = {}) => seed(h, appId, options);

  /** A new account as created by the console: on its initial password, no authenticator. */
  const onInitialPassword = async () => {
    const a = await seed(h, appId, { bound: false });
    await h.db
      .updateTable('admin_users')
      .set({ password_must_change: true, totp_secret_cipher: null, totp_bound_at: null })
      .where('id', '=', a.id)
      .execute();
    return a;
  };

  /** An ordinary account the operation would succeed on (none for create). */
  const eligible = async (operation: Operation): Promise<Seed | undefined> => {
    if (operation === 'create') return undefined;
    if (operation === 'regenerate') return onInitialPassword();
    if (operation === 'enable') return target({ status: 'disabled' });
    return target();
  };

  const row = (id: string) =>
    h.db.selectFrom('admin_users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  const exportRow = (id: string) =>
    h.db.selectFrom('export_tasks').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  const permissionKeys = async (adminId: string) =>
    (
      await h.db
        .selectFrom('admin_permissions')
        .select('permission_key')
        .where('app_id', '=', appId)
        .where('admin_id', '=', adminId)
        .execute()
    )
      .map((item) => item.permission_key)
      .sort();

  const audits = (action?: string) => {
    let query = h.db.selectFrom('audit_logs').selectAll().where('app_id', '=', appId);
    if (action !== undefined) query = query.where('action', '=', action);
    return query.orderBy('id').execute();
  };

  const exportTask = (createdBy: string, status: string) =>
    h.db
      .insertInto('export_tasks')
      .values({
        id: randomUUID(),
        app_id: appId,
        public_id: `exp_${randomUUID().replaceAll('-', '')}`,
        created_by: createdBy,
        resource: 'users',
        masked: true,
        filters: {},
        filters_summary: '风控状态：全部',
        status,
        progress: null,
        failure_reason: status === 'failed' ? '演示失败' : null,
        file_name: null,
        object_key: null,
        row_count: null,
        generated_at: null,
        expires_at: null,
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

  /** Everything of this app an admin account write may touch. */
  const snapshot = async () => ({
    accounts: await h.db
      .selectFrom('admin_users')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    permissions: await h.db
      .selectFrom('admin_permissions')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    audit: await audits(),
    exports: await h.db
      .selectFrom('export_tasks')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  });

  const reads = { read: f.read, token };
  return {
    ...f,
    appId,
    actor,
    session,
    token,
    send,
    issue,
    act,
    target,
    onInitialPassword,
    eligible,
    row,
    exportRow,
    permissionKeys,
    audits,
    exportTask,
    snapshot,
    detail: (id: string) => detail(reads, id),
    page: (query = '') => page(reads, query),
  };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

/** The admin_token still passes the admin check (GET /admin/v1/me/permissions). */
export async function alive(f: Fixture, adminToken: string) {
  await stepOk(await f.read(adminToken, READ), READ);
}

/** The admin_token no longer passes the admin check: 10001 without data. */
export async function dead(f: Fixture, adminToken: string) {
  await stepError(await f.read(adminToken, READ), READ, 10001);
}

/** Login data for an account whose password is `password`. */
export function credentials(
  id: string,
  username: string,
  password: string,
  secret = '',
): LoginAccount {
  return { id: id as LoginAccount['id'], username, password, secret };
}

/** A login step that must already be void: 10001 data.reason=login_ticket_expired. */
export function ticketGone(response: Response) {
  expect(response.statusCode).toBe(401);
  expect(response.json()).toMatchObject({ code: 10001, data: { reason: 'login_ticket_expired' } });
}

/** Signs `a` in again on a later TOTP step (the clock moves 30 s first). */
export async function signInAgain(f: Fixture, a: Seed) {
  f.clock.advanceMs(30_000);
  return signedIn(f, a);
}

/**
 * A second admin entry over the same database, Redis, keys and Clock whose database handle throws
 * on the first query `fails` matches: tokens of the fixture's app work on it unchanged.
 */
export async function failingApp(
  h: Harness,
  f: Fixture,
  fails: (node: string) => boolean,
): Promise<HttpApp> {
  const db: Kysely<DB> = h.db.withPlugin({
    transformQuery(args) {
      const node = JSON.stringify(args.node, (_key, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value,
      );
      if (fails(node)) throw new Error('injected database failure');
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  const app = await (
    await factory()
  )('admin', {
    ...f.overrides,
    dbHandles: { db, dbRead: null, close: async () => undefined },
  });
  h.apps.push(app);
  await expect(app.init()).resolves.toBeDefined();
  return app;
}

/** No audit row, log line or response other than the one-time answer carries `secret`. */
export function expectAbsent(f: Fixture, auditRows: unknown, secret: string) {
  expect(text(auditRows)).not.toContain(secret);
  expect(f.lines.join('\n')).not.toContain(secret);
}
