// B1-22g / BR-ID-24 ② and 细则「后台联盟账号列表」「后台告警手机号与重新授权会话」(D10-152 ④,
// D10-176), BR-ID-33 (encrypted, masked), BR-ID-05 细则「手机号规范化」, SPEC_REF 3a301d1.
// Real admin HTTP (Fastify inject) + business-role PG; only the container runner executes the
// *.int.test.ts files. Nothing of the use case, the guard or content's write port is mocked.
import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  decodeAlertPhones,
  encodeAlertPhones,
} from '../../../../apps/api/src/modules/union/auth-expiry/service.ts';
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
export const BASE = '/admin/v1/union-accounts/alert-phones';
export const PERMISSION = 'union.account_auth';
/** The configuration key holding the whole encrypted group (04 §10.1, D10-152 ④). */
export const KEY = 'union.auth_alert_phones';
/** BR-ID-24 细则: at most 10 alert phones. */
export const MAX_PHONES = 10;
export const ACTIONS = {
  add: 'union_alert_phone_add',
  remove: 'union_alert_phone_remove',
} as const;

/** Fastify route templates of the three operations (admin entry only). */
export const ROUTES = [
  ['GET', BASE],
  ['POST', BASE],
  ['DELETE', BASE],
] as const;

export type Op = 'list' | 'add' | 'remove';
const OPERATIONS: Readonly<Record<Op, readonly [string, string]>> = {
  list: [BASE, 'get'],
  add: [BASE, 'post'],
  remove: [BASE, 'delete'],
};

export type AlertPhones = Schema<'AdminUnionAlertPhones'>;
export type AlertPhone = Schema<'AdminUnionAlertPhone'>;

/** BR-ID-33 display mask of an 11-digit number: the first 3 and the last 4 digits. */
export const masked = (phone: string) => `${phone.slice(0, 3)}****${phone.slice(7)}`;

/** A random mainland mobile number (^1[3-9][0-9]{9}$). */
export function mobile(): string {
  let rest = '';
  for (let i = 0; i < 9; i++) rest += String(randomInt(10));
  return `1${String(randomInt(3, 10))}${rest}`;
}

/** `count` random mainland numbers with pairwise distinct masks (so idOf finds each by mask). */
export function mobiles(count: number): string[] {
  const byMask = new Map<string, string>();
  while (byMask.size < count) {
    const phone = mobile();
    if (!byMask.has(masked(phone))) byMask.set(masked(phone), phone);
  }
  return [...byMask.values()];
}

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

/** The query string of a DELETE (values as given; an absent key is simply not sent). */
export function query(values: Record<string, string | number>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) params.append(key, String(value));
  const text = params.toString();
  return text.length === 0 ? '' : `?${text}`;
}

/**
 * One signed-in console account of `appId` (admin-accounts kit: its own admin_token, totp
 * step-up, permission grants) with the three alert phone operations on top.
 */
export async function signIn(
  h: Harness,
  f: Fixture,
  appId: string,
  options: { grants?: readonly string[]; isSuper?: boolean } = {},
) {
  const admin = await signInAccount(h, f, appId, options);
  const inject = injector(f);
  const stepUp = async (call: CallOptions) => {
    const token = call.token === undefined ? await admin.issue() : call.token;
    return { ...(token === null ? {} : { 'x-step-up-token': token }), ...call.headers };
  };
  return {
    ...admin,
    listPhones: (headers: Record<string, string> = {}) =>
      inject({ method: 'GET', url: BASE, headers: { ...admin.auth, ...headers } }),
    add: async (body: unknown, options: CallOptions = {}) =>
      inject({
        method: 'POST',
        url: BASE,
        headers: {
          ...admin.auth,
          'content-type': 'application/json',
          ...(await stepUp(options)),
        },
        payload: JSON.stringify(body),
      }),
    remove: async (values: Record<string, string | number>, options: CallOptions = {}) =>
      inject({
        method: 'DELETE',
        url: `${BASE}${query(values)}`,
        headers: { ...admin.auth, ...(await stepUp(options)) },
      }),
  };
}
export type Admin = Awaited<ReturnType<typeof signIn>>;

/** A fresh app with one console account on the admin entry; the three routes must be mounted. */
export async function setup(
  h: Harness,
  options: { grants?: readonly string[]; isSuper?: boolean } = {},
) {
  const appId = `admin_union_alert_phones_${randomUUID().replaceAll('-', '')}`;
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
export type Where = Pick<Scenario, 'h' | 'f' | 'appId'>;

/** union.auth_alert_phones as union stores it (one encrypted group, BR-ID-33) at `version`. */
export async function seedPhones(s: Where, phones: readonly string[], version = 1) {
  const json = sql<never>`${JSON.stringify(encodeAlertPhones(s.h.fields, phones))}::jsonb`;
  await s.h.db
    .insertInto('config_items')
    .values({ app_id: s.appId, key: KEY, value: json, version, updated_by: 'B1-22g-fixture' })
    .onConflict((oc) => oc.columns(['app_id', 'key']).doUpdateSet({ value: json, version }))
    .execute();
}

export function configRow(s: Where) {
  return s.h.db
    .selectFrom('config_items')
    .selectAll()
    .where('app_id', '=', s.appId)
    .where('key', '=', KEY)
    .executeTakeFirst();
}

export function history(s: Where) {
  return s.h.db
    .selectFrom('config_item_versions')
    .selectAll()
    .where('app_id', '=', s.appId)
    .where('key', '=', KEY)
    .orderBy('version')
    .execute();
}

/** The stored group decrypted with the same FieldCrypto; null when the item was never written. */
export async function stored(s: Where): Promise<string[] | null> {
  const row = await configRow(s);
  if (row === undefined) return null;
  return decodeAlertPhones(s.h.fields, row.value);
}

/** Every alert phone audit row of the app. */
export function audits(s: Where) {
  return s.h.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', s.appId)
    .where('action', 'like', 'union_alert_phone%')
    .orderBy('id')
    .execute();
}

export async function snapshot(s: Where) {
  return { config: await configRow(s), history: await history(s), audits: await audits(s) };
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

export async function accepted(response: Response, op: Op): Promise<AlertPhones> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json().code).toBe(0);
  await validate(response, op);
  return response.json<{ data: AlertPhones }>().data;
}

const HTTP: Readonly<Record<number, number>> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20902: 409,
};

export async function rejected(response: Response, op: Op, code: number, data?: object) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(HTTP[code] ?? 500);
  expect(response.json().code).toBe(code);
  if (data === undefined) expect(response.json()).not.toHaveProperty('data');
  else expect(response.json().data).toEqual(data);
  await validate(response, op);
}

/** GET …/alert-phones, answered 200 and contract-valid. */
export async function phonesOf(admin: Pick<Admin, 'listPhones'>): Promise<AlertPhones> {
  return accepted(await admin.listPhones(), 'list');
}

/** The masked numbers of a list, sorted (the contract fixes no order). */
export const maskedOf = (list: AlertPhones) => list.items.map((item) => item.phone_masked).sort();

/** The phone_id of `phone` in `list` (by its mask, the numbers of a test have distinct masks). */
export function idOf(list: AlertPhones, phone: string): string {
  const found = list.items.filter((item) => item.phone_masked === masked(phone));
  expect(found, `${masked(phone)} listed once`).toHaveLength(1);
  return found[0]!.phone_id;
}

export function ms(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return (typeof value === 'string' ? new Date(value) : value).getTime();
}

/** JSON text of anything read back (bigint ids as decimal strings). */
export function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}
