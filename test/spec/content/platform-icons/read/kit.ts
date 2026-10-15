import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { Schema } from '../../../../../packages/contracts-ts/src/index.ts';
import { mediaUrlOf } from '../../../../../apps/api/src/modules/platform/media/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../../apps/api/src/modules/platform/validation/index.ts';
import { seed, type Seed } from '../../../admin/accounts/kit.ts';
import {
  apiRequire,
  fixture,
  signedIn,
  type Harness,
  type Response,
} from '../../../admin/auth/kit.ts';

export const LIST = '/admin/v1/platform-icons';
export const HISTORY = `${LIST}/{key}/versions`;
export const BASE = 'https://icons.example.invalid/media///';
export const SAVED = '2026-10-02T03:04:05.000Z';
export const UPDATED = '2026-10-03T06:07:08.000Z';
// Explicit oracle from contracts/enums/platform.yaml, not the reader's ordering.
export const KEYS = [
  'taobao',
  'tmall',
  'jd',
  'pdd',
  'wechat',
  'wechat_pay',
  'alipay',
  'wecom',
] as const;
export type Key = Schema<'PlatformIconKey'>;
export type Version = Schema<'AdminPlatformIconVersion'>;
export type Icon = Schema<'AdminPlatformIcon'>;
export type Page = Schema<'AdminPlatformIconVersionPage'>;

export async function setup(h: Harness) {
  const f = await fixture(h, { env: { MEDIA_PUBLIC_BASE_URL: BASE } });
  const appId = `f1-06w-${randomUUID()}`;
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  return { ...f, actor, appId, token: session.admin_token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

export function builtin(key: Key): Icon {
  return {
    key,
    current_version: null,
    current: null,
    latest_version: null,
    revision: 0,
    updated_by: null,
    updated_at: null,
  };
}

/** Real couli_app fixtures: upload first to satisfy the saved version's FK. */
export async function version(
  h: Harness,
  actor: Seed,
  key: Key,
  number: number,
  patch: Partial<Omit<Version, 'version' | 'url' | 'publishable'>> = {},
): Promise<Version> {
  const uploadId = randomUUID();
  const values = {
    sha256: createHash('sha256').update(`${actor.appId}:${key}:${number}`).digest('hex'),
    format: 'svg' as const,
    bytes: 1234,
    sanitized: true,
    source_url: null,
    downloaded_on: null,
    ever_published: false,
    revision: 1,
    // Snapshots deliberately differ from the referenced account's live username.
    created_by: 'saved-username',
    created_at: SAVED,
    ...patch,
  };
  await h.db
    .insertInto('platform_icon_uploads')
    .values({
      id: uploadId,
      app_id: actor.appId,
      key,
      sha256: values.sha256,
      format: values.format,
      bytes: values.bytes,
      sanitized: values.sanitized,
      created_by_admin_id: actor.id,
      created_at: values.created_at,
      expires_at: '2026-10-08T00:00:00.000Z',
    })
    .execute();
  await h.db
    .insertInto('platform_icon_versions')
    .values({
      ...values,
      app_id: actor.appId,
      key,
      version: number,
      upload_id: uploadId,
      created_by_admin_id: actor.id,
    })
    .execute();
  return {
    ...values,
    version: number,
    url: mediaUrlOf(BASE, values.sha256, values.format),
    publishable: values.source_url !== null && values.downloaded_on !== null,
  };
}

export async function icon(
  h: Harness,
  actor: Seed,
  key: Key,
  currentVersion: number | null,
  revision = 0,
) {
  await h.db
    .insertInto('platform_icons')
    .values({
      app_id: actor.appId,
      key,
      current_version: currentVersion,
      revision,
      updated_by: 'last-editor-snapshot',
      updated_by_admin_id: actor.id,
      updated_at: UPDATED,
    })
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
      fileURLToPath(new URL('../../../../../contracts/openapi.yaml', import.meta.url)),
      { resolve: { external: false } },
    );
    const compile = createValidatorCompiler();
    const result = new Map<string, Validator>();
    for (const path of [LIST, HISTORY]) {
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

export async function validate(response: Response, path: string) {
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const check = (await responseValidators()).get(`${path}:${status}`)!;
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}

export async function list(f: Pick<Setup, 'read' | 'token'>): Promise<Icon[]> {
  const response = await f.read(f.token, LIST);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: { items: expect.any(Array) } });
  await validate(response, LIST);
  return response.json<{ data: { items: Icon[] } }>().data.items;
}

export async function history(
  f: Pick<Setup, 'read' | 'token'>,
  key: Key,
  query = '',
): Promise<Page> {
  const response = await f.read(f.token, `${LIST}/${key}/versions${query}`);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: { items: expect.any(Array) } });
  await validate(response, HISTORY);
  return response.json<{ data: Page }>().data;
}

export async function rejected(response: Response, path: string, code: number, data?: object) {
  expect(response.statusCode).toBe(
    code === 10001 ? 401 : code === 10403 ? 403 : code === 50001 ? 500 : 400,
  );
  expect(response.json()).toMatchObject({ code });
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response, path);
}

export function normalizedVersion(value: Version): Version {
  return { ...value, created_at: new Date(value.created_at).toISOString() };
}

export function normalizedIcon(value: Icon): Icon {
  return {
    ...value,
    updated_at: value.updated_at === null ? null : new Date(value.updated_at).toISOString(),
    current: value.current === null ? null : normalizedVersion(value.current),
  };
}
