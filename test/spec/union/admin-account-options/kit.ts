// B1-22o / CT-24s adminListUnionAccountOptions (D10-243), BR-ATTR-02 细则「后台登记与启停」,
// 04 §6.6 / §11.2, SPEC_REF ec81e62. Real admin HTTP (Fastify inject) + business-role PG; only
// the container runner executes the *.int.test.ts files. Nothing of the use case or of the guard
// is mocked: accounts are seeded straight into union_accounts, console accounts and their
// permission grants come from the admin-accounts kit (B1-22d).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import type { Insertable } from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  apiRequire,
  fixture,
  type Fixture,
  type Harness,
  type Response,
} from '../../admin/auth/kit.ts';
import { signIn as signInAccount } from '../admin-accounts/kit.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const PATH = '/admin/v1/union/account-options';
export const OPERATION_ID = 'adminListUnionAccountOptions';
/** Either point is enough (contract, 04 §11.2). */
export const PID = 'union.pid';
export const ACCOUNT_AUTH = 'union.account_auth';
/** The only keys of one option (AdminUnionAccountOption, additionalProperties false). */
export const OPTION_KEYS = ['account_name', 'platform', 'union_account_id'] as const;
/** contracts PlatformCode in its declared order. */
export const PLATFORM_ENUM = [
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
] as const;

export type Option = Schema<'AdminUnionAccountOption'>;

interface InjectRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  payload?: string;
}

export function injector(f: Fixture) {
  return (input: InjectRequest) =>
    (f.app as unknown as { inject(request: InjectRequest): Promise<Response> }).inject(input);
}

/** `?platform=…` when given (the value is sent as is, URL-encoded). */
export function url(platform?: string): string {
  if (platform === undefined) return PATH;
  return `${PATH}?${new URLSearchParams({ platform }).toString()}`;
}

/** One signed-in console account of `appId` with the options read on top. */
export async function signIn(
  h: Harness,
  f: Fixture,
  appId: string,
  options: { grants?: readonly string[]; isSuper?: boolean } = {},
) {
  const admin = await signInAccount(h, f, appId, options);
  const inject = injector(f);
  return {
    ...admin,
    /** GET …/account-options; no X-Step-Up-Token unless given in `headers`. */
    options: (platform?: string, headers: Record<string, string> = {}) =>
      inject({ method: 'GET', url: url(platform), headers: { ...admin.auth, ...headers } }),
  };
}
export type Admin = Awaited<ReturnType<typeof signIn>>;

/** A fresh app with one console account on the admin entry; the route must be mounted. */
export async function setup(
  h: Harness,
  options: { grants?: readonly string[]; isSuper?: boolean } = {},
) {
  const appId = `admin_union_account_options_${randomUUID().replaceAll('-', '')}`;
  const f = await fixture(h);
  const server = f.app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  expect(server.hasRoute({ method: 'GET', url: PATH }), `GET ${PATH} is registered`).toBe(true);
  const admin = await signIn(h, f, appId, {
    grants: options.grants ?? [PID],
    isSuper: options.isSuper ?? false,
  });
  return { h, f, appId, inject: injector(f), ...admin };
}
export type Scenario = Awaited<ReturnType<typeof setup>>;
export type Where = Pick<Scenario, 'h' | 'f' | 'appId'>;

/** One union_accounts row of the app (every column given, so nothing depends on defaults). */
export async function seedAccount(s: Where, patch: Partial<Insertable<DB['union_accounts']>> = {}) {
  const id = randomUUID();
  return s.h.db
    .insertInto('union_accounts')
    .values({
      id,
      app_id: s.appId,
      platform: 'taobao',
      account_name: `site${id.replaceAll('-', '')}`,
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
      row_version: 0,
      created_at: s.f.clock.now(),
      updated_at: s.f.clock.now(),
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
export type AccountRow = Awaited<ReturnType<typeof seedAccount>>;

/** A current station-owner credential of the account (FieldCrypto text stored as bytea). */
export async function seedCredential(s: Where, unionAccountId: string, plaintext: string) {
  return s.h.db
    .insertInto('union_credentials')
    .values({
      id: randomUUID(),
      app_id: s.appId,
      union_account_id: unionAccountId,
      access_token_cipher: Buffer.from(s.h.fields.encrypt(plaintext, 'union_credentials.access')),
      refresh_token_cipher: null,
      expires_at: new Date('2026-12-30T00:00:00.000Z'),
      is_current: true,
      created_at: s.f.clock.now(),
      updated_at: s.f.clock.now(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** What a read must leave untouched: the app's accounts, credentials and every audit row. */
export async function snapshot(s: Where) {
  return {
    accounts: await s.h.db
      .selectFrom('union_accounts')
      .selectAll()
      .where('app_id', '=', s.appId)
      .orderBy('id')
      .execute(),
    credentials: await s.h.db
      .selectFrom('union_credentials')
      .selectAll()
      .where('app_id', '=', s.appId)
      .orderBy('id')
      .execute(),
    audits: await s.h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', s.appId)
      .orderBy('id')
      .execute(),
  };
}

/** The option a stored row must become: its id, platform and account_name, nothing else. */
export const optionOf = (row: Pick<AccountRow, 'id' | 'platform' | 'account_name'>): Option => ({
  union_account_id: row.id,
  platform: row.platform as Option['platform'],
  account_name: row.account_name,
});

/** Code-point comparison (uuid text order = PG uuid order; ASCII names compare the same). */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The contract order (platform, then account_name, then union_account_id). "By platform" is
 * accepted as the stored code's text order or PlatformCode's declared order (as the B1-22d list
 * test accepts either); within a platform the order is fixed. Callers use lowercase ASCII names.
 */
export function expectedOrders(rows: readonly AccountRow[]): Option[][] {
  const within = (a: AccountRow, b: AccountRow) =>
    byText(a.account_name, b.account_name) || byText(a.id, b.id);
  const rank = (platform: string) => (PLATFORM_ENUM as readonly string[]).indexOf(platform);
  const text = [...rows].sort((a, b) => byText(a.platform, b.platform) || within(a, b));
  const declared = [...rows].sort((a, b) => rank(a.platform) - rank(b.platform) || within(a, b));
  return [text.map(optionOf), declared.map(optionOf)];
}

let documents: Promise<Record<string, Record<string, OperationDoc>>> | undefined;
export interface OperationDoc {
  operationId: string;
  'x-implementation'?: string;
  'x-auth': string;
  'x-error-codes': number[];
  parameters: { name: string; in: string; required?: boolean }[];
  responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
}
export async function paths() {
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
export async function validate(response: Response) {
  const operation = (await paths())[PATH]?.['get'];
  expect(operation, `get ${PATH} in contracts/openapi.yaml`).toBeDefined();
  const status =
    response.statusCode === 429
      ? '429'
      : response.statusCode < 400
        ? '200'
        : response.statusCode < 500
          ? '4XX'
          : '5XX';
  const schema = operation!.responses[status]?.content['application/json']?.schema;
  expect(schema, `account-options documents ${status}`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}

/** 200 with code 0, contract-valid; the items. */
export async function accepted(response: Response): Promise<Option[]> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json().code).toBe(0);
  await validate(response);
  const data = response.json<{ data: { items: Option[] } }>().data;
  expect(Object.keys(data)).toEqual(['items']);
  for (const item of data.items) expect(Object.keys(item).sort()).toEqual([...OPTION_KEYS]);
  return data.items;
}

const HTTP: Readonly<Record<number, number>> = { 10001: 401, 10403: 403, 20001: 400 };

export async function rejected(response: Response, code: number, data?: object) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(HTTP[code] ?? 500);
  expect(response.json().code).toBe(code);
  if (data === undefined) expect(response.json()).not.toHaveProperty('data');
  else expect(response.json().data).toEqual(data);
  await validate(response);
}

/** GET …/account-options answered 200 and contract-valid. */
export async function optionsOf(admin: Pick<Admin, 'options'>, platform?: string) {
  return accepted(await admin.options(platform));
}

/** JSON text of anything read back (bigint ids as decimal strings). */
export function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}
