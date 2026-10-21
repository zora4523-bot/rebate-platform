// F1-02zs §9：只从真实 HTTP、版本行和审计观察行为；不替换 content 业务逻辑。
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { DB } from '@couli/db';
import { sql, type Insertable } from 'kysely';
import { expect } from 'vitest';
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
  type HttpApp,
  type Response,
} from './harness.ts';

export type Section = Schema<'ArticleHelpSection'>;
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
  return `0199f102-cccc-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
}
export function newAppId(): string {
  sequence += 1;
  return `f102zs_${sequence}`;
}
export function body(text = '使用说明'): string {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
}
export function draft(extra: object = {}) {
  return { title: '使用帮助', body: body(), ...extra };
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
    const doc = await parser.dereference(
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
              doc.paths[path]![method.toLowerCase()]!.responses[status]!.content[
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
export async function list(
  app: HttpApp,
  appId: string,
  options: { category?: Category; help_section?: string; limit?: number; cursor?: string } = {},
): Promise<Page> {
  const params = new URLSearchParams({
    category: 'help',
    ...Object.fromEntries(Object.entries(options).map(([k, v]) => [k, String(v)])),
  });
  return success<Page>(await get(app, appId, `/v1/articles?${params}`, 'publicList'));
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
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(f.clock.now().getTime() / 30_000)));
  const mac = createHmac('sha1', f.actor.secret).update(counter).digest();
  const code = String((mac.readUInt32BE(mac[19]! & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
  const step = await f.app.inject({
    method: 'POST',
    url: '/admin/v1/auth/step-up',
    remoteAddress: '127.0.0.1',
    headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ tier: 'totp', code }),
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
