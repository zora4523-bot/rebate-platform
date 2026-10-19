import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql, type Insertable } from 'kysely';
import type { DB } from '@couli/db';
import { expect, vi } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  apiRequire,
  fixture,
  grant,
  seed,
  signedIn,
  type Harness,
  type Response,
} from './harness.ts';

// specs/link-patterns.yaml 当前为空：仅替换只读数据来源为明确的演示表，业务校验保持真实。
vi.mock('../../../../apps/api/src/modules/platform/specs/link-patterns.ts', () => ({
  getLinkPatterns: () => ({
    version: 'f1_02w_demo',
    rules: [
      {
        platform: 'demo',
        category: 'union_host',
        hosts: ['union.example.test'],
        path_patterns: [],
      },
    ],
  }),
}));
const faults = vi.hoisted(() => ({ auditApps: new Set<string>() }));
vi.mock('../../../../apps/api/src/modules/admin/infra/audit-writer.ts', async (original) => {
  const actual =
    await original<typeof import('../../../../apps/api/src/modules/admin/infra/audit-writer.ts')>();
  return {
    ...actual,
    createAuditWriter: (deps: Parameters<typeof actual.createAuditWriter>[0]) => {
      const writer = actual.createAuditWriter(deps);
      return {
        append: async (input: Parameters<typeof writer.append>[0]) => {
          await writer.append(input);
          if (faults.auditApps.has(input.appId) && input.action.startsWith('article_')) {
            throw new Error('synthetic article audit failure');
          }
        },
      };
    },
  };
});
export function failAudit(appId: string) {
  faults.auditApps.add(appId);
}

export type Article = Schema<'AdminArticle'>;
export type ArticleList = Schema<'AdminArticleList'>;
export const BASE = '/admin/v1/articles';
export const ROUTES = {
  list: { method: 'GET', path: BASE, id: 'adminListArticles' },
  detail: { method: 'GET', path: `${BASE}/{article_id}`, id: 'adminGetArticle' },
  create: { method: 'POST', path: BASE, id: 'adminCreateArticle' },
  save: { method: 'PUT', path: `${BASE}/{article_id}/draft`, id: 'adminSaveArticleDraft' },
  publish: { method: 'POST', path: `${BASE}/{article_id}/publish`, id: 'adminPublishArticle' },
  offline: { method: 'POST', path: `${BASE}/{article_id}/offline`, id: 'adminOfflineArticle' },
} as const;
export type Operation = keyof typeof ROUTES;
export type Write = 'create' | 'save' | 'publish' | 'offline';
const ACTIONS = {
  create: 'article_create',
  save: 'article_draft_save',
  publish: 'article_publish',
  offline: 'article_offline',
} as const;

export async function setup(h: Harness) {
  const f = await fixture(h);
  // 先红用断言明确指向未挂载路由；负向用例不能误吃全局错误而绿。
  for (const route of Object.values(ROUTES)) {
    expect(
      f.app
        .getHttpAdapter()
        .getInstance()
        .hasRoute({
          method: route.method,
          url: route.path.replace('{article_id}', ':article_id'),
        }),
      route.id,
    ).toBe(true);
  }
  const appId = `f1_02w_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const owner = await seed(h, appId, true);
  const actor = await seed(h, appId);
  await grant(h, actor, owner, ['content.article']);
  const token = await signedIn(h, f, actor);
  return { ...f, appId, owner, actor, token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;
export async function member(h: Harness, f: Setup, permissions: readonly string[]) {
  const actor = await seed(h, f.appId);
  await grant(h, actor, f.owner, permissions);
  return { actor, token: await signedIn(h, f, actor) };
}
export interface Sent {
  response: Response;
  trace: string;
  op: Operation;
}
export async function send(
  f: Setup,
  op: Operation,
  id = '',
  body?: object,
  options: { token?: string; query?: string; headers?: Record<string, string> } = {},
): Promise<Sent> {
  const route = ROUTES[op];
  const trace = randomUUID();
  const response = await f.app.inject({
    method: route.method,
    url: route.path.replace('{article_id}', encodeURIComponent(id)) + (options.query ?? ''),
    remoteAddress: '127.0.0.1',
    headers: {
      'x-trace-id': trace,
      authorization: `Bearer ${options.token ?? f.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return { response, trace, op };
}

interface ContractOperation {
  operationId: string;
  'x-implementation'?: string;
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
    {
      resolve: { external: false },
    },
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
export async function success<T = Article>(sent: Sent): Promise<T> {
  expect(sent.response.statusCode, JSON.stringify(sent.response.json())).toBe(200);
  expect(sent.response.json()).toMatchObject({ code: 0, trace_id: sent.trace });
  await validate(sent);
  return sent.response.json<{ data: T }>().data;
}
export async function rejected(sent: Sent, code: number, data?: object) {
  expect(sent.response.statusCode, JSON.stringify(sent.response.json())).toBe(
    code === 10403 ? 403 : code === 20902 ? 409 : code === 30701 ? 404 : code >= 50000 ? 500 : 400,
  );
  expect(sent.response.json()).toMatchObject({ code, trace_id: sent.trace });
  if (data !== undefined) expect(sent.response.json().data).toEqual(data);
  await validate(sent);
}
export async function fields(sent: Sent, expected: readonly string[]) {
  await rejected(sent, 20001, { fields: [...expected] });
}
export const conflict = (sent: Sent) => rejected(sent, 20902, { resource: 'article' });
export const detail = (f: Setup, id: string) => send(f, 'detail', id).then(success<Article>);
export const list = (f: Setup, query = '') =>
  send(f, 'list', '', undefined, { query }).then(success<ArticleList>);
let sequence = 0;
export function newId(): string {
  sequence += 1;
  return `0199f102-aaaa-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
}
export function body(text = '使用说明', href?: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text,
            ...(href === undefined ? {} : { marks: [{ type: 'link', attrs: { href } }] }),
          },
        ],
      },
    ],
  });
}
export function draft(extra: object = {}) {
  return { title: '使用帮助', body: body(), ...extra };
}
export async function create(f: Setup, id = newId(), extra: object = {}) {
  f.clock.advanceMs(1000);
  return success(
    await send(f, 'create', id, { article_id: id, category: 'help', ...draft(), ...extra }),
  );
}
export async function save(f: Setup, id: string, revision: number, extra: object = {}) {
  f.clock.advanceMs(1000);
  return success(await send(f, 'save', id, { ...draft(extra), expected_row_version: revision }));
}
export async function publish(
  f: Setup,
  id: string,
  revision: number,
  version: number,
  at?: string,
) {
  f.clock.advanceMs(1000);
  return success(
    await send(f, 'publish', id, {
      version,
      expected_row_version: revision,
      ...(at === undefined ? {} : { published_at: at }),
    }),
  );
}
export async function snapshot(h: Harness, appId: string) {
  return {
    rows: await h.db
      .selectFrom('articles')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
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
export async function audit(h: Harness, f: Setup, before: Snapshot, op: Write, id: string) {
  const after = await snapshot(h, f.appId);
  const added = after.audits.filter((a) => !before.audits.some((b) => b.id === a.id));
  expect(added).toHaveLength(1);
  const row = added[0]!;
  expect(row).toMatchObject({
    action: ACTIONS[op],
    target: id,
    admin_id: f.actor.id,
    app_id: f.appId,
    at: f.clock.now(),
  });
  expect(JSON.stringify([row.before, row.after])).not.toContain('"body"');
  return row;
}
export function instant(value: Date | string | null) {
  return value === null ? null : new Date(value).toISOString();
}
export async function seedArticle(
  h: Harness,
  f: Setup,
  id: string,
  extra: Partial<Insertable<DB['articles']>> = {},
) {
  await h.db
    .insertInto('articles')
    .values({
      id,
      app_id: f.appId,
      category: 'help',
      ...draft(),
      version: 1,
      status: 'draft',
      published_at: null,
      notice_closable: true,
      notice_content_version: 1,
      notice_end_at: null,
      row_version: 0,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
      ...extra,
    })
    .execute();
}
export async function config(h: Harness, f: Setup, key: string, value: unknown) {
  await h.db
    .insertInto('config_items')
    .values({
      app_id: f.appId,
      key,
      value: sql`${JSON.stringify(value)}::jsonb`,
      version: 1,
      row_version: 0,
      updated_by: f.actor.username,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .onConflict((oc) =>
      oc.columns(['app_id', 'key']).doUpdateSet({ value: sql`${JSON.stringify(value)}::jsonb` }),
    )
    .execute();
}
