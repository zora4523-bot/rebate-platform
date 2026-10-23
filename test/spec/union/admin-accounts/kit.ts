// B1-22d / BR-ID-24 ③, SPEC_REF 48e55e6. Real admin HTTP (Fastify inject) + business-role PG;
// only the container runner executes the *.int.test.ts files. Nothing of the service or of the
// authorization is mocked: the OAuth exchange is the admin entry's local/test fake, whose code
// convention is fixed in apps/api/src/modules/union/infra/fake-site-oauth.ts (`fake-site:ok:<label>`,
// `fake-site:days:<n>:<label>`, anything else fails; auth_url carries the state as `state`).
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Insertable } from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { encodeAlertPhones } from '../../../../apps/api/src/modules/union/auth-expiry/service.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  account,
  apiRequire,
  fixture,
  signedIn,
  totp,
  type Fixture,
  type Harness,
  type Response,
} from '../../admin/auth/kit.ts';
import { ok, STEP, type Grant } from '../../admin/step-up/kit.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const BASE = '/admin/v1/union-accounts';
export const CALLBACK = `${BASE}/oauth/callback`;
export const PERMISSION = 'union.account_auth';
export const DAY_MS = 86_400_000;
/** BR-ID-24 细则: state single use, valid 10 minutes. */
export const SESSION_TTL_MS = 10 * 60_000;
/** BR-ID-24 细则: no expiry from the union → authorization time + 90 days, estimated. */
export const OAUTH_ESTIMATE_DAYS = 90;
/** D10-196: manual Key validity from the platform registry; documented 365 days (CAP-JD-12). */
export const KEY_VALIDITY_DAYS = 365;
export const REASON = '到期前提前续期';
export const ACCESS_CONTEXT = 'union_credentials.access';
export const REFRESH_CONTEXT = 'union_credentials.refresh';
export const PHONE = '13800138000';
export const ACTIONS = {
  start: 'union_account_reauthorize_start',
  renewed: 'union_account_reauthorize',
  credential: 'union_account_credential',
} as const;

/** Fastify route templates of the five operations (admin entry only). */
export const ROUTES = [
  ['GET', BASE],
  ['POST', `${BASE}/:union_account_id/reauthorize`],
  ['GET', `${BASE}/:union_account_id/reauthorize/:session_id`],
  ['POST', CALLBACK],
  ['PUT', `${BASE}/:union_account_id/credential`],
] as const;

export type Op = 'list' | 'start' | 'result' | 'callback' | 'credential';
const OPERATIONS: Readonly<Record<Op, readonly [string, string]>> = {
  list: ['/admin/v1/union-accounts', 'get'],
  start: ['/admin/v1/union-accounts/{union_account_id}/reauthorize', 'post'],
  result: ['/admin/v1/union-accounts/{union_account_id}/reauthorize/{session_id}', 'get'],
  callback: ['/admin/v1/union-accounts/oauth/callback', 'post'],
  credential: ['/admin/v1/union-accounts/{union_account_id}/credential', 'put'],
};

export type UnionAccount = Schema<'AdminUnionAccount'>;
export type ReauthSession = Schema<'AdminUnionReauthSession'>;
export type ReauthResult = Schema<'AdminUnionReauthResult'>;

export const okCode = (label: string) => `fake-site:ok:${label}`;
export const daysCode = (days: number, label: string) => `fake-site:days:${days}:${label}`;
export const fakeAccess = (label: string) => `fake-site-access:${label}`;
export const fakeRefresh = (label: string) => `fake-site-refresh:${label}`;

interface InjectRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  payload?: string;
}

interface CallOptions {
  /** undefined → a fresh totp step-up token; null → no X-Step-Up-Token header. */
  token?: string | null;
  headers?: Record<string, string>;
}

function injector(f: Fixture) {
  return (input: InjectRequest) =>
    (f.app as unknown as { inject(request: InjectRequest): Promise<Response> }).inject(input);
}

/** One signed-in console account of `appId` on fixture `f` (its own admin_token and step-up). */
export async function signIn(
  h: Harness,
  f: Fixture,
  appId: string,
  options: { grants?: readonly string[]; isSuper?: boolean } = {},
) {
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
  for (const permission of options.grants ?? [PERMISSION]) {
    await h.db
      .insertInto('admin_permissions')
      .values({
        app_id: appId,
        admin_id: a.id,
        permission_key: permission,
        granted_by: a.id,
        granted_at: f.clock.now(),
      })
      .execute();
  }
  const session = await signedIn(f, a);
  const auth = { authorization: `Bearer ${session.admin_token}` };
  const inject = injector(f);
  const issue = async () => {
    f.clock.advanceMs(30_000);
    const grant = await ok<Grant>(
      await f.post('/step-up', { tier: 'totp', code: totp(a.secret, f.clock) }, auth),
      STEP,
    );
    return grant.step_up_token;
  };
  const send = (
    method: InjectRequest['method'],
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ) =>
    inject({
      method,
      url,
      headers: {
        ...auth,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const stepUp = async (call: CallOptions) => {
    const token = call.token === undefined ? await issue() : call.token;
    return { ...(token === null ? {} : { 'x-step-up-token': token }), ...call.headers };
  };
  return {
    a,
    session,
    auth,
    issue,
    list: (headers: Record<string, string> = {}) => send('GET', BASE, undefined, headers),
    start: async (id: string, body: unknown = {}, options: CallOptions = {}) =>
      send('POST', `${BASE}/${id}/reauthorize`, body, await stepUp(options)),
    result: (id: string, sessionId: string, headers: Record<string, string> = {}) =>
      send('GET', `${BASE}/${id}/reauthorize/${sessionId}`, undefined, headers),
    callback: (body: unknown, headers: Record<string, string> = {}) =>
      send('POST', CALLBACK, body, headers),
    put: async (id: string, body: unknown, options: CallOptions = {}) =>
      send('PUT', `${BASE}/${id}/credential`, body, await stepUp(options)),
  };
}
export type Admin = Awaited<ReturnType<typeof signIn>>;

/** A fresh app with one console account on the admin entry; the five routes must be mounted. */
export async function setup(
  h: Harness,
  options: { grants?: readonly string[]; isSuper?: boolean } = {},
) {
  const appId = `admin_union_accounts_${randomUUID().replaceAll('-', '')}`;
  const f = await fixture(h);
  const server = f.app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  for (const [method, url] of ROUTES) {
    expect(server.hasRoute({ method, url }), `${method} ${url} is registered`).toBe(true);
  }
  const admin = await signIn(h, f, appId, options);
  return { h, f, appId, inject: injector(f), ...admin };
}
export type Scenario = Awaited<ReturnType<typeof setup>>;
type Where = Pick<Scenario, 'h' | 'f' | 'appId'>;

export async function seedAccount(
  s: Where,
  patch: Partial<Insertable<DB['union_accounts']>> = {},
) {
  const id = randomUUID();
  return s.h.db
    .insertInto('union_accounts')
    .values({
      id,
      app_id: s.appId,
      platform: 'taobao',
      account_name: `site-${id}`,
      status: 'active',
      sync_start_at: new Date('2026-09-29T00:00:00.000Z'),
      auth_expires_at: new Date('2026-12-30T00:00:00.000Z'),
      auth_expires_estimated: false,
      auth_status: 'active',
      auth_renewed_at: null,
      auth_renewed_by: null,
      alert_stage: 'none',
      last_probe_at: new Date('2026-10-08T01:00:00.000Z'),
      last_probe_ok: true,
      last_probe_error: null,
      row_version: 3,
      created_at: s.f.clock.now(),
      updated_at: s.f.clock.now(),
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
export type AccountRow = Awaited<ReturnType<typeof seedAccount>>;

export async function seedCredential(s: Where, unionAccountId: string, plaintext: string) {
  return s.h.db
    .insertInto('union_credentials')
    .values({
      id: randomUUID(),
      app_id: s.appId,
      union_account_id: unionAccountId,
      access_token_cipher: Buffer.from(s.h.fields.encrypt(plaintext, ACCESS_CONTEXT)),
      refresh_token_cipher: null,
      expires_at: new Date('2026-12-30T00:00:00.000Z'),
      is_current: true,
      created_at: s.f.clock.now(),
      updated_at: s.f.clock.now(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function setConfig(s: Where, key: string, value: unknown) {
  const json = sql<never>`${JSON.stringify(value)}::jsonb`;
  await s.h.db
    .insertInto('config_items')
    .values({ app_id: s.appId, key, value: json, updated_by: 'B1-22d-fixture' })
    .onConflict((oc) => oc.columns(['app_id', 'key']).doUpdateSet({ value: json }))
    .execute();
}

/** attr.jd.user_key_mode (BR-ATTR-06): private_position → jd reauth_mode manual, else none. */
export const setJdMode = (s: Where, mode: string) => setConfig(s, 'attr.jd.user_key_mode', mode);

/** union.auth_alert_phones as the union module stores it (one encrypted group, BR-ID-33). */
export const setPhones = (s: Where, phones: readonly string[]) =>
  setConfig(s, 'union.auth_alert_phones', encodeAlertPhones(s.h.fields, phones));

export function accountRow(s: Where, id: string) {
  return s.h.db
    .selectFrom('union_accounts')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

export function credentials(s: Where, unionAccountId?: string) {
  let query = s.h.db.selectFrom('union_credentials').selectAll().where('app_id', '=', s.appId);
  if (unionAccountId !== undefined) query = query.where('union_account_id', '=', unionAccountId);
  return query.orderBy('created_at').orderBy('id').execute();
}

export function sessions(s: Where) {
  return s.h.db
    .selectFrom('admin_union_auth_sessions')
    .selectAll()
    .where('app_id', '=', s.appId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

export function sessionRow(s: Where, id: string) {
  return s.h.db
    .selectFrom('admin_union_auth_sessions')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

/** Every union audit row of the app (any action starting with `union`). */
export function audits(s: Where) {
  return s.h.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', s.appId)
    .where('action', 'like', 'union%')
    .orderBy('id')
    .execute();
}

export async function snapshot(s: Where) {
  return {
    accounts: await s.h.db
      .selectFrom('union_accounts')
      .selectAll()
      .where('app_id', '=', s.appId)
      .orderBy('id')
      .execute(),
    credentials: await credentials(s),
    sessions: await sessions(s),
    audits: await audits(s),
  };
}

let documents: Promise<Record<string, Record<string, OperationDoc>>> | undefined;
interface OperationDoc {
  responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
}
async function paths() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{ paths: Record<string, Record<string, OperationDoc>> }>;
  };
  documents ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    })
    .then((doc) => doc.paths);
  return documents;
}

/** The response body against the operation's contract response for its status class. */
export async function validate(response: Response, op: Op) {
  const [path, method] = OPERATIONS[op];
  const operation = (await paths())[path]?.[method];
  expect(operation, `${method} ${path} in contracts/openapi.yaml`).toBeDefined();
  const status =
    response.statusCode === 429
      ? '429'
      : response.statusCode < 400
        ? '200'
        : response.statusCode < 500
          ? '4XX'
          : '5XX';
  const schema = operation!.responses[status]?.content['application/json']?.schema;
  expect(schema, `${op} documents ${status}`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}

export async function accepted<T>(response: Response, op: Op): Promise<T> {
  expect(response.statusCode).toBe(200);
  expect(response.json().code).toBe(0);
  await validate(response, op);
  return response.json<{ data: T }>().data;
}

export async function rejected(response: Response, op: Op, code: number, data?: object) {
  expect(response.statusCode).toBe(
    code === 20001 ? 400 : code === 10001 ? 401 : code === 10003 || code === 10403 ? 403 : 500,
  );
  expect(response.json().code).toBe(code);
  if (data === undefined) expect(response.json()).not.toHaveProperty('data');
  else expect(response.json().data).toEqual(data);
  await validate(response, op);
}

export async function listed(admin: Pick<Admin, 'list'>): Promise<UnionAccount[]> {
  const items = (await accepted<{ items: UnionAccount[] }>(await admin.list(), 'list')).items;
  return items;
}

/** Starts a session and reads the state back from auth_url (fake provider convention). */
export async function started(
  admin: Pick<Admin, 'start'>,
  unionAccountId: string,
  body: unknown = {},
) {
  const data = await accepted<ReauthSession>(await admin.start(unionAccountId, body), 'start');
  const state = new URL(data.auth_url).searchParams.get('state');
  expect(state, 'auth_url carries the state').toEqual(expect.any(String));
  return { ...data, state: state! };
}

/** GET …/reauthorize/{session_id}, answered 200 and contract-valid. */
export async function polled(admin: Pick<Admin, 'result'>, id: string, sessionId: string) {
  return accepted<ReauthResult>(await admin.result(id, sessionId), 'result');
}

/** POST …/oauth/callback, answered 200 and contract-valid. */
export async function called(admin: Pick<Admin, 'callback'>, body: unknown) {
  return accepted<ReauthResult>(await admin.callback(body), 'callback');
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function ms(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return (typeof value === 'string' ? new Date(value) : value).getTime();
}

export function later(s: Where, days: number): Date {
  return new Date(s.f.clock.now().getTime() + days * DAY_MS);
}

/** union_credentials ciphers are FieldCrypto text stored as bytea (B1-22c). */
export function decrypt(s: Where, cipher: Buffer | null, context: string): string | null {
  if (cipher === null) return null;
  return s.h.fields.decrypt(Buffer.from(cipher).toString('utf8'), context);
}

export function expectNoSecrets(value: unknown, secrets: readonly string[]) {
  // audit_logs.id is int8 (BigInt in @couli/db); write it as a decimal string to serialize.
  const serialized = JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
    // A bytea/Buffer JSON form must not hide a plaintext from the assertion.
    expect(serialized).not.toContain(JSON.stringify([...Buffer.from(secret)]));
    expect(serialized).not.toContain(Buffer.from(secret).toString('hex'));
  }
}
