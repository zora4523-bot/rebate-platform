// F1-02zzp §9.3：只从真实 HTTP、版本行和审计观察行为；不替换 content 业务逻辑。
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { DB } from '@couli/db';
import { sql, type Insertable } from 'kysely';
import { expect } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { doc, paragraph, text } from './faq-body.ts';
import {
  apiRequire,
  fixture,
  grant,
  seed,
  signedIn,
  totp,
  type Harness,
  type HttpApp,
  type Response,
} from './faq-harness.ts';

export type Category = Schema<'ArticleCategory'>;
export type AdminArticle = Schema<'AdminArticle'>;
export type Page = Schema<'ArticleListData'>;
export const ROUTES = {
  publicList: ['GET', '/v1/articles'],
  publicDetail: ['GET', '/v1/articles/{article_id}'],
  list: ['GET', '/admin/v1/articles'],
  detail: ['GET', '/admin/v1/articles/{article_id}'],
  create: ['POST', '/admin/v1/articles'],
  save: ['PUT', '/admin/v1/articles/{article_id}/draft'],
  publish: ['POST', '/admin/v1/articles/{article_id}/publish'],
  offline: ['POST', '/admin/v1/articles/{article_id}/offline'],
  agreement: ['POST', '/admin/v1/agreements/{type}/versions'],
} as const;
type Operation = keyof typeof ROUTES;
let sequence = 0;
export function newId(): string {
  sequence += 1;
  return `0199f102-dddd-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
}
export function newAppId(): string {
  sequence += 1;
  return `f102zzp_${sequence}`;
}
export function body(value = '使用说明'): string {
  return doc(paragraph(text(value)));
}
export function draft(extra: object = {}) {
  return { title: '使用帮助', body: body(), ...extra };
}
/** 列表项、详情、版本都按普通对象读字段，避免联合类型挡住「键不存在」的断言。 */
export function field(row: object, key: string): unknown {
  return (row as Record<string, unknown>)[key];
}
export async function setup(h: Harness) {
  const f = await fixture(h);
  const appId = newAppId();
  const owner = await seed(h, appId, true);
  const actor = await seed(h, appId);
  await grant(h, actor, owner, ['content.article', 'content.agreement']);
  const token = await signedIn(h, f, actor);
  return { ...f, appId, actor, token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;
export interface Sent {
  response: Response;
  op: Operation;
}

export async function send(
  f: Setup,
  op: Operation,
  id = '',
  payload?: object,
  options: { query?: string; step?: string } = {},
): Promise<Sent> {
  const [method, path] = ROUTES[op];
  return {
    op,
    response: await f.app.inject({
      method,
      url:
        path.replace('{article_id}', encodeURIComponent(id)).replace('{type}', id) +
        (options.query ?? ''),
      remoteAddress: '127.0.0.1',
      headers: {
        authorization: `Bearer ${f.token}`,
        'x-trace-id': randomUUID(),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.step === undefined ? {} : { 'x-step-up-token': options.step }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    }),
  };
}
export async function get(
  app: HttpApp,
  appId: string,
  url: string,
  op: 'publicList' | 'publicDetail',
): Promise<Sent> {
  return {
    op,
    response: await app.inject({
      method: 'GET',
      url,
      remoteAddress: '127.0.0.1',
      headers: { 'x-app-id': appId, 'x-platform': 'ios', 'x-app-version': '2.0.0' },
    }),
  };
}
type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let validators: Promise<Map<string, Validator>> | undefined;
/** 响应过契约（含 summary 1–80 字、faq_rank 1–999、additionalProperties=false）。 */
export async function validate(sent: Sent) {
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
            { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> }
          >
        >;
      }>;
    };
    const document = await parser.dereference(
      fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
      { resolve: { external: false } },
    );
    const compile = createValidatorCompiler();
    const checks = new Map<string, Validator>();
    for (const [op, [method, path]] of Object.entries(ROUTES)) {
      for (const status of ['200', '4XX', '5XX']) {
        checks.set(
          `${op}:${status}`,
          compile({
            schema:
              document.paths[path]![method.toLowerCase()]!.responses[status]!.content[
                'application/json'
              ]!.schema,
            httpPart: 'body',
          }),
        );
      }
    }
    return checks;
  })();
  const status =
    sent.response.statusCode < 400 ? '200' : sent.response.statusCode < 500 ? '4XX' : '5XX';
  const check = (await validators).get(`${sent.op}:${status}`)!;
  expect(check(sent.response.json()), JSON.stringify(check.errors)).toBe(true);
}
export async function success<T = AdminArticle>(sent: Sent): Promise<T> {
  expect(sent.response.statusCode).toBe(200);
  expect(sent.response.json()).toMatchObject({ code: 0 });
  await validate(sent);
  return sent.response.json<{ data: T }>().data;
}
export async function invalid(sent: Sent, fields?: string[]) {
  expect(sent.response.statusCode).toBe(400);
  expect(sent.response.json()).toMatchObject({ code: 20001 });
  if (fields !== undefined) expect(sent.response.json().data).toEqual({ fields });
  await validate(sent);
}
export interface ListOptions {
  category?: Category;
  help_section?: string;
  faq?: boolean;
  limit?: number;
  cursor?: string;
}
export function listUrl(options: ListOptions = {}): string {
  const params = new URLSearchParams({
    category: 'help',
    ...Object.fromEntries(Object.entries(options).map(([k, v]) => [k, String(v)])),
  });
  return `/v1/articles?${params}`;
}
export async function list(app: HttpApp, appId: string, options: ListOptions = {}): Promise<Page> {
  return success<Page>(await get(app, appId, listUrl(options), 'publicList'));
}
/** 跟着 next_cursor 读完所有页。 */
export async function listAll(
  app: HttpApp,
  appId: string,
  options: Omit<ListOptions, 'cursor'> = {},
): Promise<Page['items']> {
  const items: Page['items'] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
    const next = cursor === undefined ? {} : { cursor };
    const page = await list(app, appId, { ...options, ...next });
    items.push(...page.items);
    if (page.next_cursor === null) return items;
    cursor = page.next_cursor;
  }
  throw new Error('listAll: too many pages');
}
export async function publicDetail(app: HttpApp, appId: string, id: string, version?: number) {
  return success<Schema<'Article'>>(
    await get(
      app,
      appId,
      `/v1/articles/${id}${version === undefined ? '' : `?version=${version}`}`,
      'publicDetail',
    ),
  );
}
export async function adminList(f: Setup) {
  return success<Schema<'AdminArticleList'>>(await send(f, 'list'));
}
export async function seedArticle(
  h: Harness,
  appId: string,
  patch: Partial<Insertable<DB['articles']>> = {},
) {
  const id = patch.id ?? newId();
  await h.db
    .insertInto('articles')
    .values({
      id,
      app_id: appId,
      category: 'help',
      ...draft(),
      version: 1,
      status: 'published',
      published_at: '2026-10-20T01:00:00.000000Z',
      help_section: null,
      faq_rank: null,
      notice_closable: true,
      notice_content_version: 1,
      notice_end_at: null,
      row_version: 0,
      created_at: '2026-10-20T00:00:00Z',
      updated_at: '2026-10-20T00:00:00Z',
      ...patch,
    })
    .execute();
  return id;
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
export function articleAudits(state: Awaited<ReturnType<typeof snapshot>>) {
  return state.audits.filter((row) => row.action.startsWith('article_'));
}
/** 审计前后值里每个带 version 的对象（不固定多版本容器的键名）。 */
export function facts(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(facts);
  if (value === null || typeof value !== 'object') return [];
  const row = value as Record<string, unknown>;
  return [...('version' in row ? [row] : []), ...Object.values(row).flatMap(facts)];
}
export function noBodyInAudits(state: Awaited<ReturnType<typeof snapshot>>) {
  for (const row of state.audits) {
    expect(
      JSON.stringify([row.before, row.after], (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain('"body"');
  }
}
export async function create(f: Setup, extra: object = {}) {
  return success(
    await send(f, 'create', '', { article_id: newId(), category: 'help', ...draft(extra) }),
  );
}
export async function save(f: Setup, article: AdminArticle, extra: object = {}) {
  return success(
    await send(f, 'save', article.article_id, {
      ...draft(extra),
      expected_row_version: article.row_version,
    }),
  );
}
export async function publish(f: Setup, article: AdminArticle) {
  return success(
    await send(f, 'publish', article.article_id, {
      version: article.versions[0]!.version,
      expected_row_version: article.row_version,
    }),
  );
}
export async function publishAgreement(h: Harness, f: Setup) {
  await h.db
    .insertInto('config_items')
    .values({
      app_id: f.appId,
      key: 'h5_base_url',
      value: sql`${JSON.stringify('https://h5.example.test/legal/')}::jsonb`,
      version: 1,
      row_version: 0,
      updated_by: 'fixture',
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .execute();
  f.clock.advanceMs(30_000);
  const step = await f.app.inject({
    method: 'POST',
    url: '/admin/v1/auth/step-up',
    remoteAddress: '127.0.0.1',
    headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ tier: 'totp', code: totp(f.actor.secret, f.clock.now()) }),
  });
  expect(step.statusCode).toBe(200);
  expect(step.json()).toMatchObject({ code: 0, data: { step_up_token: expect.any(String) } });
  return success<Schema<'AdminAgreementVersion'>>(
    await send(
      f,
      'agreement',
      'privacy',
      {
        ...draft(),
        min_version: 1,
        requires_resign: false,
        legal_confirmed_by: '法务甲',
        legal_confirm_note: '已确认原文',
        legal_confirmed_on: '2026-10-20',
        expected_version: 0,
      },
      { step: step.json<{ data: { step_up_token: string } }>().data.step_up_token },
    ),
  );
}
