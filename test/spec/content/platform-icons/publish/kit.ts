import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { Schema } from '../../../../../packages/contracts-ts/src/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../../apps/api/src/modules/platform/validation/index.ts';
import { apiRequire, type Harness, type HttpApp, type Response } from '../../../admin/auth/kit.ts';
import { LIST, setup as readSetup, type Key, type Setup } from '../read/kit.ts';

export { setup as readSetup, version, icon, history, list, BASE } from '../read/kit.ts';
export type { Key, Setup, Icon, Version } from '../read/kit.ts';
export const SOURCE = 'https://source.example.invalid/brand/jd';
export const DATE = '2026-10-01';
export const REGISTERED = { source_url: SOURCE, downloaded_on: DATE };
export const OPERATIONS = ['source', 'publish', 'restore'] as const;
export type Operation = (typeof OPERATIONS)[number];
export const ROUTES = {
  source: { method: 'PATCH', path: `${LIST}/{key}/versions/{version}` },
  publish: { method: 'POST', path: `${LIST}/{key}/publish` },
  restore: { method: 'POST', path: `${LIST}/{key}/restore-builtin` },
} as const;

// The existing auth kit types only GET/POST; Fastify itself also supports PATCH.
interface WriteApp {
  inject(input: {
    method: 'PATCH' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload: string;
    remoteAddress: string;
  }): Promise<Response>;
}
export function hasRoute(app: HttpApp, operation: Operation): boolean {
  const server = app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  const route = ROUTES[operation];
  return server.hasRoute({ method: route.method, url: route.path.replace(/\{(\w+)\}/g, ':$1') });
}

export async function setup(h: Harness): Promise<Setup> {
  const f = await readSetup(h);
  // Missing business routes must fail even negative auth/validation tests: never a false green
  // obtained from a global hook or a 404. No test-only route registration.
  for (const op of OPERATIONS) expect(hasRoute(f.app, op), ROUTES[op].path).toBe(true);
  return f;
}

export function write(
  f: Pick<Setup, 'app' | 'token'>,
  operation: Operation,
  body: Record<string, unknown>,
  key = 'jd',
  version = 1,
  token: string | null = f.token,
) {
  const route = ROUTES[operation];
  return (f.app as unknown as WriteApp).inject({
    method: route.method,
    url: route.path.replace('{key}', key).replace('{version}', String(version)),
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    payload: JSON.stringify(body),
    remoteAddress: '127.0.0.1',
  });
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
          Record<
            string,
            {
              responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
            }
          >
        >;
      }>;
    };
    const doc = await parser.dereference(
      fileURLToPath(new URL('../../../../../contracts/openapi.yaml', import.meta.url)),
      { resolve: { external: false } },
    );
    const compile = createValidatorCompiler();
    const result = new Map<string, Validator>();
    for (const op of OPERATIONS) {
      const { method, path } = ROUTES[op];
      for (const status of ['200', '4XX', '5XX']) {
        result.set(
          `${op}:${status}`,
          compile({
            schema:
              doc.paths[path]![method.toLowerCase()]!.responses[status]!.content[
                'application/json'
              ]!.schema,
            httpPart: 'body',
          }),
        );
      }
    }
    return result;
  })();
  return validators;
}
export async function validate(response: Response, op: Operation) {
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const check = (await responseValidators()).get(`${op}:${status}`)!;
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}
export async function success<T = Schema<'AdminPlatformIcon'>>(
  response: Response,
  op: Operation,
): Promise<T> {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response, op);
  return response.json<{ data: T }>().data;
}
export async function rejected(response: Response, op: Operation, code: number, data?: object) {
  expect(response.statusCode).toBe(
    code === 10001 ? 401 : code === 10403 ? 403 : code === 20902 ? 409 : 400,
  );
  expect(response.json()).toMatchObject({ code });
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response, op);
}
export const conflict = (response: Response, op: Operation) =>
  rejected(response, op, 20902, { resource: 'platform_icon' });

export async function snapshot(h: Harness, appId: string) {
  return {
    icons: await h.db
      .selectFrom('platform_icons')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('key')
      .execute(),
    versions: await h.db
      .selectFrom('platform_icon_versions')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('key')
      .orderBy('version')
      .execute(),
    uploads: await h.db
      .selectFrom('platform_icon_uploads')
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
  };
}
export const mark = (h: Harness, appId: string, key: Key = 'jd') =>
  h.db
    .selectFrom('platform_icons')
    .selectAll()
    .where('app_id', '=', appId)
    .where('key', '=', key)
    .executeTakeFirstOrThrow();
export const saved = (h: Harness, appId: string, key: Key = 'jd', number = 1) =>
  h.db
    .selectFrom('platform_icon_versions')
    .selectAll()
    .where('app_id', '=', appId)
    .where('key', '=', key)
    .where('version', '=', number)
    .executeTakeFirstOrThrow();

export async function auditDelta(
  h: Harness,
  f: Setup,
  before: Awaited<ReturnType<typeof snapshot>>,
  action: string,
) {
  const after = await snapshot(h, f.appId);
  const ids = new Set(before.audits.map((row) => row.id));
  const added = after.audits.filter((row) => !ids.has(row.id));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ app_id: f.appId, admin_id: f.actor.id, action });
  expect(added[0]!.at.toISOString()).toBe(f.clock.now().toISOString());
  return added[0]!;
}

export async function transitionAudit(
  h: Harness,
  f: Setup,
  before: Awaited<ReturnType<typeof snapshot>>,
  action: string,
  from: number | null,
  to: number | null,
) {
  const audit = await auditDelta(h, f, before, action);
  // The decision requires these facts, not a particular before/after split.
  const facts = { ...(audit.before as object | null), ...(audit.after as object | null) };
  expect(facts).toMatchObject({ key: 'jd', from_version: from, to_version: to });
  expect(JSON.stringify(facts)).not.toMatch(/data:image|<svg|base64|"file"|"content"/i);
}
