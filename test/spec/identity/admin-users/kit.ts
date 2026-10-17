// F1-07b fixtures: real database, FieldCrypto and admin sessions (container runner only).
// Users, risk rows and union bindings are written straight into app.* so the reads under test
// see exactly the stored values; every expected value is derived from what was seeded here.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { grant, seed } from '../../admin/accounts/kit.ts';
import {
  fixture,
  signedIn,
  type Harness,
  type HttpApp,
  type Response,
} from '../../admin/auth/kit.ts';
import { DETAIL, LIST, LOOKUP, validate, type Path } from './schema.ts';

export const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
/** Registration instants are spread around this base (before the fixture clock). */
export const BASE = Date.parse('2026-09-01T00:00:00.000Z');
export const at = (minutes: number) => new Date(BASE + minutes * 60_000);

export type ListItem = Schema<'AdminUserListItem'>;
export type Detail = Schema<'AdminUserDetail'>;
export type Risk = Schema<'AdminUserRiskState'>;
export type Binding = Schema<'AdminUserUnionBinding'>;
export type Page = Schema<'AdminUserPage'>;

export const NO_RISK: Risk = {
  state: 'normal',
  reason_category: null,
  reason: null,
  frozen_until: null,
  changed_by: null,
  changed_at: null,
  row_version: null,
};

export function mounted(app: HttpApp): boolean[] {
  const server = app.getHttpAdapter().getInstance();
  return [LIST, LOOKUP, DETAIL.replace('{user_id}', ':user_id')].map((url) =>
    server.hasRoute({ method: 'GET', url }),
  );
}

export async function setup(h: Harness) {
  const f = await fixture(h);
  // Every integration case is red before the routes exist, negative cases included.
  expect(mounted(f.app), 'admin 入口必须挂载三条用户查询路由').toEqual([true, true, true]);
  const appId = `f1-07b-${randomUUID()}`;
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  f.overrides.logger.info({ event: 'admin_users_test_capture_ready' }, 'capture ready');
  return { ...f, appId, actor, token: session.admin_token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

/** A non-super admin of the same app holding exactly `permissions`. */
export async function member(h: Harness, f: Setup, permissions: readonly string[]) {
  const who = await seed(h, f.appId);
  if (permissions.length !== 0) await grant(h, who, f.actor, permissions);
  const session = await signedIn(f, who);
  return session.admin_token;
}

/** Query string with every value percent-encoded ('+' → %2B, space → %20). */
export function url(path: string, query: Record<string, string | number> = {}): string {
  const parts = Object.entries(query).map(
    ([key, value]) => `${key}=${encodeURIComponent(String(value))}`,
  );
  return parts.length === 0 ? path : `${path}?${parts.join('&')}`;
}
export const detailUrl = (id: string) => DETAIL.replace('{user_id}', encodeURIComponent(id));

export function get(
  f: Pick<Setup, 'app' | 'token'>,
  target: string,
  options: { token?: string | null; headers?: Record<string, string> } = {},
) {
  const token = options.token === undefined ? f.token : options.token;
  return f.app.inject({
    method: 'GET',
    url: target,
    headers: {
      'x-trace-id': TRACE,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...options.headers,
    },
    remoteAddress: '127.0.0.1',
  });
}

export async function ok<T>(response: Response, path: Path): Promise<T> {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, msg: '', trace_id: TRACE });
  await validate(response, path);
  return response.json<{ data: T }>().data;
}

/** Error envelope: code, HTTP status, and (when given) the exact `data` of the contract. */
export async function rejected(response: Response, path: Path, code: number, data?: object) {
  expect(response.statusCode).toBe(code === 10001 ? 401 : code === 10403 ? 403 : 400);
  expect(response.json()).toMatchObject({ code, trace_id: TRACE });
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response, path);
}

// Values are generated only in the isolated runner, never stored as plaintext fixtures.
export function syntheticPhone(): string {
  return `1${3 + randomInt(7)}${String(randomInt(1_000_000_000)).padStart(9, '0')}`;
}
export const masked = (phone: string | null) =>
  phone === null ? null : `${phone.slice(0, 3)}****${phone.slice(-4)}`;

export interface UserOptions {
  id?: string;
  phone?: string | null;
  createdAt?: Date;
  status?: 'normal' | 'deleted';
  parentId?: string | null;
  level?: 'L1' | 'L2' | 'L3';
  registeredChannel?: string | null;
}

export async function user(h: Harness, appId: string, options: UserOptions = {}) {
  const id = options.id ?? randomUUID();
  const phone = options.phone === undefined ? syntheticPhone() : options.phone;
  const record = {
    id,
    appId,
    phone,
    nickname: `用户${randomBytes(3).toString('hex')}`,
    inviteCode: randomBytes(4).toString('hex').toUpperCase(),
    parentId: options.parentId ?? null,
    level: options.level ?? 'L1',
    registerMethod: phone === null ? 'wechat' : 'phone',
    registeredChannel: options.registeredChannel === undefined ? 'test' : options.registeredChannel,
    createdAt: options.createdAt ?? at(0),
    status: options.status ?? 'normal',
  };
  await h.db
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: record.nickname,
      avatar: 'avatar:default',
      phone_cipher: phone === null ? null : Buffer.from(h.fields.encrypt(phone, 'users.phone')),
      phone_hmac: phone === null ? null : h.fields.blindIndex(phone, 'users.phone'),
      invite_code: record.inviteCode,
      attr_code: `a${randomBytes(6).toString('hex')}`,
      level: record.level,
      status: record.status,
      deleted_reason: record.status === 'deleted' ? 'user_request' : null,
      parent_id: record.parentId,
      parent_bind_source: record.parentId === null ? null : 'invite_code',
      parent_bound_at: record.parentId === null ? null : record.createdAt,
      register_method: record.registerMethod,
      registered_channel: record.registeredChannel,
      created_at: record.createdAt,
      updated_at: record.createdAt,
    })
    .execute();
  return record;
}
export type User = Awaited<ReturnType<typeof user>>;

export async function riskRow(
  h: Harness,
  target: User,
  row: {
    state: Risk['state'];
    reason_category?: Risk['reason_category'];
    reason?: string | null;
    frozen_until?: Date | null;
    changed_by?: string;
    changed_at?: Date;
    row_version?: number;
  },
): Promise<Risk> {
  const changedAt = row.changed_at ?? at(30);
  const changedBy = row.changed_by ?? 'ops-test';
  const value = {
    state: row.state,
    reason_category: row.reason_category ?? (row.state === 'normal' ? null : 'other'),
    reason: row.reason ?? null,
    frozen_until: row.frozen_until ?? null,
    row_version: row.row_version ?? 0,
  };
  await h.db
    .insertInto('user_risk_state')
    .values({
      user_id: target.id,
      app_id: target.appId,
      ...value,
      changed_by: changedBy,
      changed_at: changedAt,
      created_at: changedAt,
      updated_at: changedAt,
    })
    .execute();
  return {
    ...value,
    frozen_until: value.frozen_until === null ? null : value.frozen_until.toISOString(),
    changed_by: changedBy,
    changed_at: changedAt.toISOString(),
  };
}

export interface BindingOptions {
  id?: string;
  status: Binding['status'];
  createdAt: Date;
  rowVersion?: number;
  reason?: string | null;
}

/** One union_bindings row (with its own union account); returns the contract view of it. */
export async function binding(
  h: Harness,
  target: User,
  platform: Binding['platform'],
  options: BindingOptions,
): Promise<Binding> {
  const accountId = randomUUID();
  await h.db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: target.appId,
      platform,
      account_name: `synthetic-${platform}-${accountId.slice(0, 8)}`,
      status: 'active',
      auth_status: 'active',
      created_at: options.createdAt,
      updated_at: options.createdAt,
    })
    .execute();
  const released = options.status === 'released';
  const bound = options.status !== 'pending_auth' && options.status !== 'unbound';
  const view: Binding = {
    platform,
    status: options.status,
    blocked_reason: options.status === 'blocked' ? 'admin_disable' : null,
    bound_at: bound ? options.createdAt.toISOString() : null,
    released_at: released ? new Date(options.createdAt.getTime() + 3_600_000).toISOString() : null,
    cooldown_until: released
      ? new Date(options.createdAt.getTime() + 30 * 86_400_000).toISOString()
      : null,
    reason: options.reason ?? null,
    row_version: options.rowVersion ?? 0,
  };
  await h.db
    .insertInto('union_bindings')
    .values({
      id: options.id ?? randomUUID(),
      app_id: target.appId,
      user_id: target.id,
      platform,
      union_account_id: accountId,
      relation_id: bound ? `rel-${randomBytes(6).toString('hex')}` : null,
      special_id: bound ? `sp-${randomBytes(6).toString('hex')}` : null,
      status: view.status,
      blocked_reason: view.blocked_reason,
      bound_at: view.bound_at,
      released_at: view.released_at,
      cooldown_until: view.cooldown_until,
      reason: view.reason,
      row_version: view.row_version,
      created_at: options.createdAt,
      updated_at: options.createdAt,
    })
    .execute();
  return view;
}

export function listItem(target: User, riskState: Risk['state'] = 'normal'): ListItem {
  return {
    user_id: target.id,
    nickname: target.nickname,
    phone_masked: masked(target.phone),
    level: target.level,
    risk_state: riskState,
    created_at: target.createdAt.toISOString(),
  };
}

export function detail(target: User, risk: Risk = NO_RISK, bindings: Binding[] = []): Detail {
  return normalDetail({
    user_id: target.id,
    nickname: target.nickname,
    phone_masked: masked(target.phone),
    invite_code: target.inviteCode,
    inviter_user_id: target.parentId,
    level: target.level,
    register_method: target.registerMethod,
    registered_channel: target.registeredChannel,
    created_at: target.createdAt.toISOString(),
    risk,
    union_bindings: bindings,
  });
}

const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString());

/** Any contract-valid timezone spelling of the same instant compares equal. */
export function normalItem(item: ListItem): ListItem {
  return { ...item, created_at: iso(item.created_at)! };
}

/** Timestamps to UTC ISO; union_bindings sorted by platform (the contract fixes no order). */
export function normalDetail(value: Detail): Detail {
  return {
    ...value,
    created_at: iso(value.created_at)!,
    risk: {
      ...value.risk,
      frozen_until: iso(value.risk.frozen_until),
      changed_at: iso(value.risk.changed_at),
    },
    union_bindings: value.union_bindings
      .map((b) => ({
        ...b,
        bound_at: iso(b.bound_at),
        released_at: iso(b.released_at),
        cooldown_until: iso(b.cooldown_until),
      }))
      .sort((a, b) => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0)),
  };
}

/** Newest registration first; the same instant ordered by id descending (ruling §9.2 #3). */
export function newestFirst(users: readonly User[]): User[] {
  return [...users].sort((a, b) => {
    const t = b.createdAt.getTime() - a.createdAt.getTime();
    if (t !== 0) return t;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/** No full number in the response body or in any log line of the request. */
export function noPlaintext(f: Setup, users: readonly User[], response?: Response) {
  expect(f.lines.length, '日志捕获器必须启用').toBeGreaterThan(0);
  const logs = f.lines.join('\n');
  const body = response === undefined ? '' : JSON.stringify(response.json());
  for (const target of users) {
    if (target.phone === null) continue;
    expect(logs).not.toContain(target.phone);
    expect(body).not.toContain(target.phone);
  }
  expect(body).not.toMatch(/"(?:phone|phone_cipher|phone_hmac|relation_id|special_id)"\s*:/);
}
