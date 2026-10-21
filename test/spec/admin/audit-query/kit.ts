import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Insertable } from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { seed, grant } from '../accounts/kit.ts';
import { apiRequire, fixture, signedIn, type Harness, type Response } from '../auth/kit.ts';

export { seed, grant, signedIn };
export const LIST = '/admin/v1/audit-logs';
export const DETAIL = `${LIST}/{id}`;
// Seeded history is separate from the real login audit rows at the harness's fixed clock.
export const FROM = '2026-10-08T00:00:00.000Z';
export const TO = '2026-10-09T00:00:00.000Z';
export type Item = Schema<'AdminAuditLogListItem'>;
export type Page = Schema<'AdminAuditLogPage'>;
export type Detail = Schema<'AdminAuditLog'>;
export type Query = Record<string, string | number>;

export async function setup(h: Harness) {
  const appId = `b1-34a-${randomUUID()}`;
  const f = await fixture(h);
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  return { ...f, actor, appId, token: session.admin_token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;
type Reader = Pick<Setup, 'read' | 'token'>;

export async function append(
  h: Harness,
  actor: { id: string; appId: string },
  patch: Partial<Insertable<DB['audit_logs']>> = {},
) {
  return h.db
    .insertInto('audit_logs')
    .values({
      app_id: actor.appId,
      admin_id: actor.id,
      action: 'admin.login',
      target: `admin_users:${actor.id}`,
      ip: '192.0.2.23',
      at: FROM,
      ...patch,
      // pg treats JS arrays as PG arrays; stringify every non-null JSON value explicitly.
      before:
        patch.before == null
          ? null
          : sql<DB['audit_logs']['before']>`${JSON.stringify(patch.before)}::jsonb`,
      after:
        patch.after == null
          ? null
          : sql<DB['audit_logs']['after']>`${JSON.stringify(patch.after)}::jsonb`,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function url(query: Query = {}): string {
  return `${LIST}?${new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  )}`;
}

type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let validators: Promise<Map<string, Validator>> | undefined;
function responseValidators() {
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
    const checks = new Map<string, Validator>();
    for (const path of [LIST, DETAIL]) {
      for (const status of ['200', '4XX']) {
        const schema = doc.paths[path]!.get.responses[status]!.content['application/json']!.schema;
        checks.set(`${path}:${status}`, compile({ schema, httpPart: 'body' }));
      }
    }
    return checks;
  })();
  return validators;
}

export async function validate(response: Response, detail = false) {
  const check = (await responseValidators()).get(
    `${detail ? DETAIL : LIST}:${response.statusCode < 400 ? '200' : '4XX'}`,
  )!;
  expect(check(response.json())).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}

/** Default history window excludes login setup; unfiltered calls pass an explicit query. */
export async function page(f: Reader, query: Query = { from: FROM, to: TO }): Promise<Page> {
  const response = await f.read(f.token, url(query));
  // Missing routes fail an assertion before dereferencing the envelope or its items.
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: { items: expect.any(Array) } });
  await validate(response);
  return response.json<{ data: Page }>().data;
}

export async function detail(f: Reader, id: string): Promise<Detail> {
  const response = await f.read(f.token, `${LIST}/${encodeURIComponent(id)}`);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: { id } });
  await validate(response, true);
  return response.json<{ data: Detail }>().data;
}

export async function rejected(response: Response, fields: string[], isDetail = false) {
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: 20001 });
  expect(response.json<{ data: object }>().data).toEqual({ fields });
  await validate(response, isDetail);
}

export function expectItems(result: Page, targets: (string | null)[]) {
  expect(result.total).toBe(targets.length);
  expect(result.items.map((item) => item.target_id)).toEqual(targets);
}
