// F1-09f §9.1–9.3：只经真实 admin 入口验收，不注册测试路由、不替换页面用例。
// 每个用例独立 app_id；couli_app 无 DELETE，不清表。所有连接仅供容器内集成测试。
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { grant, seed } from '../../admin/accounts/kit.ts';
import {
  apiRequire,
  fixture,
  signedIn,
  type Harness,
  type HttpApp,
  type Response,
} from '../../admin/auth/kit.ts';

export type Page = Schema<'AdminPageConfig'>;
export type Version = Schema<'AdminPageConfigVersion'>;
export type PageList = Schema<'AdminPageConfigList'>;
export type VersionList = Schema<'AdminPageConfigVersionList'>;
export const BASE = '/admin/v1/pages';
export const ROUTES = {
  list: { method: 'GET', path: BASE, id: 'adminListPageConfigs' },
  detail: { method: 'GET', path: `${BASE}/{page_key}`, id: 'adminGetPageConfig' },
  versions: {
    method: 'GET',
    path: `${BASE}/{page_key}/versions`,
    id: 'adminListPageConfigVersions',
  },
  version: {
    method: 'GET',
    path: `${BASE}/{page_key}/versions/{version}`,
    id: 'adminGetPageConfigVersion',
  },
  save: { method: 'POST', path: `${BASE}/{page_key}/versions`, id: 'adminCreatePageConfigVersion' },
  publish: { method: 'POST', path: `${BASE}/{page_key}/publish`, id: 'adminPublishPageConfig' },
  gray: { method: 'POST', path: `${BASE}/{page_key}/gray`, id: 'adminUpdatePageConfigGray' },
  rollback: { method: 'POST', path: `${BASE}/{page_key}/rollback`, id: 'adminRollbackPageConfig' },
} as const;
export type Operation = keyof typeof ROUTES;
export const WRITES = ['save', 'publish', 'gray', 'rollback'] as const;
export type Write = (typeof WRITES)[number];
export const ACTIONS = {
  save: 'page_version_create',
  publish: 'page_publish',
  gray: 'page_gray_update',
  rollback: 'page_rollback',
} as const;

export async function setup(h: Harness) {
  const f = await fixture(h);
  const server = f.app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  // 未实现时每个用例都由断言变红，包括负向用例，不能误吃全局 404 / 校验错误。
  for (const route of Object.values(ROUTES)) {
    expect(
      server.hasRoute({ method: route.method, url: route.path.replace(/\{(\w+)\}/g, ':$1') }),
      route.id,
    ).toBe(true);
  }
  const appId = `f1_09f_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const owner = await seed(h, appId, { isSuper: true });
  const actor = await seed(h, appId);
  await grant(h, actor, owner, ['content.page']);
  const session = await signedIn(f, actor);
  return { ...f, appId, actor, owner, token: session.admin_token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

export async function member(h: Harness, f: Setup, permissions: readonly string[]) {
  const account = await seed(h, f.appId);
  if (permissions.length > 0) await grant(h, account, f.owner, permissions);
  const session = await signedIn(f, account);
  return { account, token: session.admin_token };
}

interface InjectApp {
  inject(input: {
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<Response>;
}
export interface Sent {
  response: Response;
  trace: string;
  op: Operation;
}
export async function send(
  f: Pick<Setup, 'app' | 'token'>,
  op: Operation,
  key = 'home',
  body?: Record<string, unknown>,
  options: {
    version?: number;
    query?: string;
    token?: string | null;
    headers?: Record<string, string>;
  } = {},
): Promise<Sent> {
  const route = ROUTES[op];
  const token = options.token === undefined ? f.token : options.token;
  const trace = randomUUID();
  const response = await (f.app as unknown as InjectApp).inject({
    method: route.method,
    url:
      route.path
        .replace('{page_key}', encodeURIComponent(key))
        .replace('{version}', String(options.version ?? 1)) + (options.query ?? ''),
    headers: {
      'x-trace-id': trace,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    remoteAddress: '127.0.0.1',
  });
  return { response, trace, op };
}

interface ContractOperation {
  operationId: string;
  parameters?: { name: string }[];
  responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
}
export async function contract() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{
      paths: Record<string, Record<string, ContractOperation>>;
    }>;
  };
  return parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
}
type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let validators: Promise<Map<string, Validator>> | undefined;
async function validate(sent: Sent) {
  validators ??= (async () => {
    const doc = await contract();
    const compile = createValidatorCompiler();
    const result = new Map<string, Validator>();
    for (const [op, route] of Object.entries(ROUTES)) {
      for (const status of ['200', '4XX', '5XX']) {
        result.set(
          `${op}:${status}`,
          compile({
            schema:
              doc.paths[route.path]![route.method.toLowerCase()]!.responses[status]!.content[
                'application/json'
              ]!.schema,
            httpPart: 'body',
          }),
        );
      }
    }
    return result;
  })();
  const status =
    sent.response.statusCode < 400 ? '200' : sent.response.statusCode < 500 ? '4XX' : '5XX';
  const check = (await validators).get(`${sent.op}:${status}`)!;
  expect(check(sent.response.json()), JSON.stringify(check.errors)).toBe(true);
}
export async function success<T = Page>(sent: Sent): Promise<T> {
  expect(sent.response.statusCode, JSON.stringify(sent.response.json())).toBe(200);
  expect(sent.response.json()).toMatchObject({ code: 0, trace_id: sent.trace });
  await validate(sent);
  return sent.response.json<{ data: T }>().data;
}
export async function rejected(sent: Sent, code: number, data?: object) {
  expect(sent.response.statusCode, JSON.stringify(sent.response.json())).toBe(
    code === 10001
      ? 401
      : code === 10403
        ? 403
        : code === 20902
          ? 409
          : code === 30701
            ? 404
            : code >= 50000
              ? 500
              : 400,
  );
  expect(sent.response.json()).toMatchObject({ code, trace_id: sent.trace });
  if (data !== undefined) expect(sent.response.json().data).toEqual(data);
  await validate(sent);
}
export async function fields(sent: Sent, required: readonly string[], exact = true) {
  await rejected(sent, 20001);
  const data = sent.response.json<{ data: { fields: string[] } }>().data;
  expect(Object.keys(data)).toEqual(['fields']);
  expect(data.fields.length).toBeGreaterThan(0);
  expect(data.fields).toEqual(expect.arrayContaining([...required]));
  expect(new Set(data.fields).size).toBe(data.fields.length);
  expect(data.fields.every((p) => /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(p))).toBe(true);
  if (exact) expect([...data.fields].sort()).toEqual([...required].sort());
}
export const conflict = (sent: Sent) => rejected(sent, 20902, { resource: 'page' });
export const detail = (f: Setup, key = 'home') => send(f, 'detail', key).then(success<Page>);
export const version = (f: Setup, key = 'home', number = 1) =>
  send(f, 'version', key, undefined, { version: number }).then(success<Version>);

export function sections(id = 'banner_a', action: object = { route: 'Help' }) {
  return [{ id, type: 'banner', version: 1, data_source: { kind: 'static', items: [{ action }] } }];
}
export async function save(f: Setup, key: string, revision: number, value: object[] = sections()) {
  f.clock.advanceMs(1000);
  return success<Version>(
    await send(f, 'save', key, { sections: value, expected_revision: revision }),
  );
}
export async function publish(
  f: Setup,
  key: string,
  revision: number,
  number: number,
  percent = 100,
) {
  f.clock.advanceMs(1000);
  return success(
    await send(f, 'publish', key, {
      version: number,
      gray_percent: percent,
      expected_revision: revision,
    }),
  );
}
export async function snapshot(h: Harness, appId: string) {
  return {
    pages: await h.db
      .selectFrom('pages')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('page_key')
      .execute(),
    versions: await h.db
      .selectFrom('page_versions')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('page_key')
      .orderBy('version')
      .execute(),
    audits: await h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}
export type Snapshot = Awaited<ReturnType<typeof snapshot>>;
export async function audit(
  h: Harness,
  f: Setup,
  before: Snapshot,
  op: Write,
  key: string,
  number: number,
) {
  const after = await snapshot(h, f.appId);
  const ids = new Set(before.audits.map((a) => a.id));
  const added = after.audits.filter((a) => !ids.has(a.id));
  expect(added).toHaveLength(1);
  const row = added[0]!;
  expect(row).toMatchObject({
    action: ACTIONS[op],
    admin_id: f.actor.id,
    app_id: f.appId,
    at: f.clock.now(),
  });
  const prior = before.pages.find((p) => p.page_key === key);
  const next = after.pages.find((p) => p.page_key === key)!;
  expect(row.before).toMatchObject({
    page_key: key,
    revision: prior?.revision ?? 0,
    current_version: prior?.current_version ?? null,
    gray_version: prior?.gray_version ?? null,
    gray_percent: prior?.gray_percent ?? 0,
  });
  expect(row.after).toMatchObject({
    page_key: key,
    version: number,
    revision: next.revision,
    current_version: next.current_version,
    gray_version: next.gray_version,
    gray_percent: next.gray_percent,
  });
  expect(JSON.stringify([row.before, row.after])).not.toContain('"sections"');
  expect(next).toMatchObject({
    revision: (prior?.revision ?? 0) + 1,
    updated_by_admin_id: f.actor.id,
    updated_at: f.clock.now(),
  });
}

// 绕过保存入口种坏草稿，证明发布确实重新校验；只用 INSERT，不改不可变内容。
export async function seedDraft(h: Harness, f: Setup, key: string, value: object[]) {
  await h.db
    .insertInto('page_versions')
    .values({
      app_id: f.appId,
      page_key: key,
      version: 1,
      sections: sql`${JSON.stringify(value)}::jsonb`,
      status: 'draft',
      created_by_admin_id: f.actor.id,
      created_at: f.clock.now(),
    })
    .execute();
  await h.db
    .insertInto('pages')
    .values({
      app_id: f.appId,
      page_key: key,
      revision: 1,
      updated_by_admin_id: f.actor.id,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .execute();
}
export type { Harness, HttpApp, Response };
