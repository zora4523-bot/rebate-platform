import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { expect } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  apiRequire,
  base32,
  fixture,
  NOW,
  signedIn,
  SUPER,
  type Harness,
  type Response,
} from '../auth/kit.ts';

export { SUPER } from '../auth/kit.ts';
export type View = Schema<'AdminAccount'>;
export type Page = Schema<'AdminAccountPage'>;
const DETAIL = `${SUPER}/{admin_id}`;
export const CREATED = '2026-10-01T00:00:00.000Z';

/** Real couli_app rows; only the container runner executes this fixture. */
export async function seed(
  h: Harness,
  appId: string,
  options: {
    id?: ReturnType<typeof randomUUID>;
    isSuper?: boolean;
    status?: View['status'];
    bound?: boolean;
    phone?: string;
    lockedUntil?: string | null;
    createdAt?: string;
  } = {},
) {
  const id = options.id ?? randomUUID();
  const username = `accounts-${id}`;
  const secret = base32(randomBytes(20));
  const phone = options.phone ?? null;
  // Same field envelope/AAD convention as F1-06b/c's admin TOTP encryption.
  const phoneContext = `admin_users.verify_phone:${appId}:${id}`;
  const expected: View = {
    admin_id: id,
    username,
    is_super: options.isSuper ?? false,
    status: options.status ?? 'active',
    totp_bound: options.bound ?? true,
    verify_phone_masked: phone === null ? null : `${phone.slice(0, 3)}****${phone.slice(-4)}`,
    locked_until: options.lockedUntil ?? null,
    permissions: [],
    created_at: options.createdAt ?? CREATED,
  };
  await h.db
    .insertInto('admin_users')
    .values({
      id,
      app_id: appId,
      login_name: username,
      password_hash: h.passwordHash,
      is_super: expected.is_super,
      status: expected.status,
      password_must_change: false,
      totp_secret_cipher: Buffer.from(
        h.fields.encrypt(secret, `admin_users.totp_secret:${appId}:${id}`),
      ),
      totp_bound_at: expected.totp_bound ? NOW : null,
      verify_phone_cipher:
        phone === null ? null : Buffer.from(h.fields.encrypt(phone, phoneContext)),
      verify_phone_hmac: phone === null ? null : h.fields.blindIndex(phone, phoneContext),
      verify_phone_set_at: phone === null ? null : NOW,
      locked_until: expected.locked_until,
      created_at: expected.created_at,
      updated_at: CREATED,
    })
    .execute();
  return { id, username, secret, password: h.password, appId, expected };
}
export type Seed = Awaited<ReturnType<typeof seed>>;

export async function setup(h: Harness) {
  const appId = `f1-06m-${randomUUID()}`;
  const f = await fixture(h, { probes: true });
  const actor = await seed(h, appId, { isSuper: true, createdAt: '2026-09-01T00:00:00.000Z' });
  const session = await signedIn(f, actor);
  return { ...f, actor, appId, token: session.admin_token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

export async function grant(h: Harness, target: Seed, actor: Seed, keys: readonly string[]) {
  await h.db
    .insertInto('admin_permissions')
    .values(
      keys.map((permission_key) => ({
        app_id: target.appId,
        admin_id: target.id,
        permission_key,
        granted_by: actor.id,
        granted_at: NOW,
        created_at: NOW,
      })),
    )
    .execute();
}

type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let validators: Promise<Map<string, Validator>> | undefined;
async function responseValidators() {
  validators ??= (async () => {
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(
        path: string,
        options: object,
      ): Promise<{
        paths: Record<
          string,
          {
            get: { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> };
          }
        >;
      }>;
    };
    const doc = await parser.dereference(
      fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
      { resolve: { external: false } },
    );
    const compile = createValidatorCompiler();
    const result = new Map<string, Validator>();
    for (const path of [SUPER, DETAIL]) {
      for (const status of ['200', '4XX']) {
        const schema = doc.paths[path]!.get.responses[status]!.content['application/json']!.schema;
        result.set(`${path}:${status}`, compile({ schema, httpPart: 'body' }));
      }
    }
    return result;
  })();
  return validators;
}

export async function validate(response: Response, detail = false) {
  const key = `${detail ? DETAIL : SUPER}:${response.statusCode < 400 ? '200' : '4XX'}`;
  const check = (await responseValidators()).get(key)!;
  expect(check(response.json())).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}

export async function page(f: Pick<Setup, 'read' | 'token'>, query = ''): Promise<Page> {
  const response = await f.read(f.token, `${SUPER}${query}`);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: { items: expect.any(Array) } });
  await validate(response);
  return response.json<{ data: Page }>().data;
}

export async function detail(f: Pick<Setup, 'read' | 'token'>, id: string): Promise<View> {
  const response = await f.read(f.token, `${SUPER}/${id}`);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: { admin_id: id } });
  await validate(response, true);
  return response.json<{ data: View }>().data;
}

export async function rejected(
  response: Response,
  code: 10403 | 20001,
  data: object,
  isDetail = false,
) {
  expect(response.statusCode).toBe(code === 10403 ? 403 : 400);
  expect(response.json()).toMatchObject({ code });
  expect(response.json<{ data: object }>().data).toEqual(data);
  await validate(response, isDetail);
}

export function expectView(actual: View, expected: View) {
  // Accept any contract-valid timezone spelling of the same timestamp.
  expect({
    ...actual,
    created_at: new Date(actual.created_at).toISOString(),
    locked_until: actual.locked_until === null ? null : new Date(actual.locked_until).toISOString(),
  }).toEqual(expected);
}

export async function expectBoth(f: Setup, target: Seed, expected = target.expected) {
  const result = await page(f);
  const listed = result.items.find((item) => item.admin_id === target.id);
  expect(listed).toBeDefined();
  expectView(listed!, expected);
  expectView(await detail(f, target.id), expected);
}

export function expectNoSensitive(value: unknown, forbiddenValues: readonly string[]) {
  const text = JSON.stringify(value);
  for (const secret of forbiddenValues) expect(text).not.toContain(secret);
  function checkKeys(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) checkKeys(item);
    } else if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        expect(key).not.toMatch(/password|hash|secret/i);
        checkKeys(child);
      }
    }
  }
  checkKeys(value);
}
