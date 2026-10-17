// F1-09d §9: HTTP observations, real app-scoped rows, independent rollout oracle.
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { headers, type Harness, type HttpApp, type Response } from '../config/kit.ts';

export { appId, harness, registerDevice, session } from '../config/kit.ts';
export type { Harness } from '../config/kit.ts';
export type Section = Record<string, unknown>;
export const FULL = [{ id: 'full', type: 'banner', items: [{ title: '全量内容' }] }];
export const GRAY = [{ id: 'gray', type: 'banner', items: [{ title: '灰度内容' }] }];

// Admin row exists only to satisfy the FK; no admin authentication in these fixtures.
export async function seedPage(
  h: Harness,
  id: string,
  options: {
    key?: string;
    current?: number | null;
    gray?: number | null;
    percent?: number;
    versions?: {
      number: number;
      status?: 'draft' | 'published' | 'rolled_back';
      sections: Section[];
    }[];
  } = {},
) {
  const actor = randomUUID();
  const key = options.key ?? 'home';
  await h.db
    .withSchema('app')
    .insertInto('admin_users')
    .values({
      id: actor,
      app_id: id,
      login_name: `pages-${actor}`,
      password_hash: 'fixture-unused',
      is_super: false,
      status: 'active',
      created_at: h.deps.clock.now(),
      updated_at: h.deps.clock.now(),
    })
    .execute();
  for (const version of options.versions ?? [
    { number: 1, status: 'published' as const, sections: FULL },
  ]) {
    const status = version.status ?? 'published';
    await h.db
      .withSchema('app')
      .insertInto('page_versions')
      .values({
        app_id: id,
        page_key: key,
        version: version.number,
        sections: sql`${JSON.stringify(version.sections)}::jsonb`,
        status,
        publish_at: status === 'draft' ? null : h.deps.clock.now(),
        publisher: status === 'draft' ? null : actor,
        created_by_admin_id: actor,
        created_at: h.deps.clock.now(),
      })
      .execute();
  }
  await h.db
    .withSchema('app')
    .insertInto('pages')
    .values({
      app_id: id,
      page_key: key,
      current_version: options.current === undefined ? 1 : options.current,
      gray_version: options.gray ?? null,
      gray_percent: options.percent ?? 0,
      updated_by_admin_id: actor,
      created_at: h.deps.clock.now(),
      updated_at: h.deps.clock.now(),
    })
    .execute();
}

export function read(app: HttpApp, id: string, key = 'home', extra: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url: `/v1/pages/${encodeURIComponent(key)}`,
    headers: { ...headers(id), ...extra },
  });
}

const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
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
            get: {
              responses: Record<
                string,
                {
                  content: Record<string, { schema: JsonSchema }>;
                }
              >;
            };
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
    for (const path of ['/v1/pages/{page_key}', '/v1/app-versions/check']) {
      for (const status of ['200', '4XX', '5XX']) {
        result.set(
          `${path}:${status}`,
          compile({
            schema: doc.paths[path]!.get.responses[status]!.content['application/json']!.schema,
            httpPart: 'body',
          }),
        );
      }
    }
    return result;
  })();
  return validators;
}
export async function validate(response: Response, path = '/v1/pages/{page_key}') {
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const check = (await responseValidators()).get(`${path}:${status}`)!;
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}
export async function success(
  app: HttpApp,
  id: string,
  key = 'home',
  extra: Record<string, string> = {},
) {
  const response = await read(app, id, key, extra);
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: expect.any(Object) });
  await validate(response);
  return response.json<{ data: Schema<'Page'> }>().data;
}
export async function rejected(response: Response, code: 30701 | 20001 | 10405 | 50001) {
  expect(response.statusCode).toBe(
    code === 30701 ? 404 : code === 20001 ? 400 : code === 10405 ? 403 : 500,
  );
  expect(response.json()).toMatchObject({ code });
  if (code === 20001) expect(response.json()).toMatchObject({ data: { fields: ['page_key'] } });
  await validate(response);
}

// Bigint parses the first eight bytes without rounding or calling production selection code.
export function bucket(id: string, device: string): number {
  const hex = createHash('sha256').update(`${id}:${device}`).digest('hex');
  return Number(BigInt(`0x${hex.slice(0, 16)}`) % 10_000n);
}
export function deviceAt(id: string, target: number): string {
  for (let i = 0; i < 1_000_000; i += 1) {
    const device = `019a0000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
    if (bucket(id, device) === target) return device;
  }
  throw new Error('F1-09d fixture: requested bucket not found');
}
