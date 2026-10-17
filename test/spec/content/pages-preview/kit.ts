// F1-09e §9.1–9.3: real admin/api entries, one database and one injected Clock.
// F1-09a is not yet in this checkout: parameterised SQL follows its page table migration;
// no substitute tables, test routes or implementation providers are installed here.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { createTokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { seedUser } from '../../identity/request-context/db-kit.ts';
import { grant, seed } from '../../admin/accounts/kit.ts';
import {
  apiRequire,
  factory,
  fixture,
  signedIn,
  type Harness,
  type HttpApp,
  type Response,
} from '../../admin/auth/kit.ts';

export const ISSUE = '/admin/v1/pages/{page_key}/preview-tokens';
export const PREVIEW = '/v1/pages/{page_key}/preview';
export const ACTION = 'page_preview_token_issue';
export type Issued = Schema<'AdminPagePreviewToken'>;
export type Preview = Schema<'PagePreview'>;
export const SECTIONS: Preview['sections'] = [
  { id: 'guest', type: 'banner', data_source: { kind: 'static', items: [] } },
  { id: 'members', type: 'banner', condition: { login: 'yes' }, text: '登录可见但预览不筛选' },
  {
    id: 'future',
    type: 'banner',
    min_app_version: { ios: '99.0.0', android: '99.0.0', harmony: '99.0.0' },
    nested: { keep: [null, false, 0, '原样'] },
  },
];

export const appId = () => `f109e_${randomUUID().replaceAll('-', '')}`;
export const hash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export function assertRoute(app: HttpApp, method: 'GET' | 'POST', path: string) {
  const server = app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  expect(server.hasRoute({ method, url: path.replace('{page_key}', ':page_key') }), path).toBe(
    true,
  );
}

export async function setup(h: Harness) {
  const f = await fixture(h);
  const api = await (await factory())('api', f.overrides);
  h.apps.push(api);
  await api.init();
  // Every case must be red by assertion if either real route is missing, including negatives.
  // Run before page SQL, so the unmerged F1-09a dependency cannot cause an invalid red.
  assertRoute(f.app, 'POST', ISSUE);
  assertRoute(api, 'GET', PREVIEW);
  const id = appId();
  const owner = await seed(h, id, { isSuper: true });
  const actor = await seed(h, id);
  await grant(h, actor, owner, ['content.page']);
  const auth = await signedIn(f, actor);
  return { ...f, api, appId: id, owner, actor, token: auth.admin_token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

export async function member(h: Harness, f: Setup, permissions: readonly string[]) {
  const actor = await seed(h, f.appId);
  if (permissions.length > 0) await grant(h, actor, f.owner, permissions);
  return (await signedIn(f, actor)).admin_token;
}

export async function seedVersion(
  h: Harness,
  f: Setup,
  version: number,
  status: 'draft' | 'published' | 'rolled_back' = 'draft',
  pageKey = 'home',
  sections: Preview['sections'] = SECTIONS,
) {
  await sql`INSERT INTO app.page_versions
    (app_id, page_key, version, sections, status, created_by_admin_id, created_at,
     publish_at, publisher)
    VALUES (${f.appId}, ${pageKey}, ${version}, ${JSON.stringify(sections)}::jsonb,
      ${status}, ${f.actor.id}::uuid, ${f.clock.now()},
      ${status === 'draft' ? null : f.clock.now()},
      ${status === 'draft' ? null : f.actor.id}::uuid)`.execute(h.db);
  await sql`INSERT INTO app.pages (app_id, page_key, created_at, updated_at)
    VALUES (${f.appId}, ${pageKey}, ${f.clock.now()}, ${f.clock.now()})
    ON CONFLICT (app_id, page_key) DO NOTHING`.execute(h.db);
}

export async function publishPointers(h: Harness, f: Setup) {
  await seedVersion(h, f, 2, 'published', 'home', [{ id: 'current', type: 'banner' }]);
  await seedVersion(h, f, 3, 'published', 'home', [{ id: 'gray', type: 'banner' }]);
  await sql`UPDATE app.pages SET current_version = 2, gray_version = 3, gray_percent = 99
    WHERE app_id = ${f.appId} AND page_key = 'home'`.execute(h.db);
}

export interface TokenRow {
  token_hash: string;
  app_id: string;
  page_key: string;
  version: number;
  created_by: string;
  created_at: Date;
  expire_at: Date;
  used_count: number;
}
export async function tokenRows(h: Harness, id: string) {
  return (
    await sql<TokenRow>`SELECT * FROM app.page_preview_tokens
      WHERE app_id = ${id} ORDER BY token_hash`.execute(h.db)
  ).rows;
}
export async function tokenRow(h: Harness, f: Setup, token: string) {
  const row = (await tokenRows(h, f.appId)).find((item) => item.token_hash === hash(token));
  expect(row, 'sha256(token) must identify the stored row').toBeDefined();
  return row!;
}
export const audits = (h: Harness, id: string) =>
  h.db.selectFrom('audit_logs').selectAll().where('app_id', '=', id).orderBy('id').execute();

/** JSONB projection preserves all columns and avoids BigInt serialisation in snapshots. */
export async function contentSnapshot(h: Harness, id: string) {
  const pages = await sql`SELECT to_jsonb(p) AS row FROM app.pages p
    WHERE app_id = ${id} ORDER BY page_key`.execute(h.db);
  const versions = await sql`SELECT to_jsonb(v) AS row FROM app.page_versions v
    WHERE app_id = ${id} ORDER BY page_key, version`.execute(h.db);
  return { pages: pages.rows, versions: versions.rows };
}
export async function snapshot(h: Harness, f: Setup) {
  return {
    ...(await contentSnapshot(h, f.appId)),
    tokens: await tokenRows(h, f.appId),
    audits: await audits(h, f.appId),
  };
}

export interface Sent {
  response: Response;
  trace: string;
}
export async function issue(
  f: Setup,
  version: number,
  pageKey = 'home',
  token: string | null = f.token,
  extra: Record<string, string> = {},
): Promise<Sent> {
  const trace = randomUUID();
  const response = await f.app.inject({
    method: 'POST',
    url: ISSUE.replace('{page_key}', encodeURIComponent(pageKey)),
    headers: {
      'content-type': 'application/json',
      'x-trace-id': trace,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...extra,
    },
    payload: JSON.stringify({ version }),
    remoteAddress: '127.0.0.1',
  });
  return { response, trace };
}
export async function read(
  f: Setup,
  token: string | null,
  pageKey = 'home',
  id = f.appId,
  extra: Record<string, string> = {},
  api = f.api,
): Promise<Sent> {
  const trace = randomUUID();
  const response = await api.inject({
    method: 'GET',
    url:
      PREVIEW.replace('{page_key}', encodeURIComponent(pageKey)) +
      (token === null ? '' : `?token=${encodeURIComponent(token)}`),
    headers: {
      'x-app-id': id,
      'x-platform': 'ios',
      'x-app-version': '1.0.0',
      'x-trace-id': trace,
      ...extra,
    },
    remoteAddress: '127.0.0.1',
  });
  return { response, trace };
}

type Operation = 'issue' | 'preview';
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
    const result = new Map<string, Validator>();
    for (const [op, path, method] of [
      ['issue', ISSUE, 'post'],
      ['preview', PREVIEW, 'get'],
    ] as const) {
      for (const status of ['200', '4XX', '5XX']) {
        result.set(
          `${op}:${status}`,
          compile({
            schema:
              doc.paths[path]![method]!.responses[status]!.content['application/json']!.schema,
            httpPart: 'body',
          }),
        );
      }
    }
    return result;
  })();
  return validators;
}
export async function validate(sent: Sent, op: Operation) {
  const check = (await responseValidators()).get(
    `${op}:${sent.response.statusCode === 200 ? '200' : sent.response.statusCode < 500 ? '4XX' : '5XX'}`,
  )!;
  expect(check(sent.response.json()), JSON.stringify(check.errors)).toBe(true);
  expect(sent.response.json()).toMatchObject({ trace_id: sent.trace });
}
export async function issued(sent: Sent): Promise<Issued> {
  expect(sent.response.statusCode, JSON.stringify(sent.response.json())).toBe(200);
  expect(sent.response.json()).toMatchObject({ code: 0, data: expect.any(Object) });
  await validate(sent, 'issue');
  return sent.response.json<{ data: Issued }>().data;
}
export async function previewed(sent: Sent): Promise<Preview> {
  expect(sent.response.statusCode, JSON.stringify(sent.response.json())).toBe(200);
  expect(sent.response.json()).toMatchObject({ code: 0, data: expect.any(Object) });
  await validate(sent, 'preview');
  return sent.response.json<{ data: Preview }>().data;
}
export async function rejected(sent: Sent, op: Operation, code: number) {
  const status =
    code === 10001 ? 401 : code === 10403 ? 403 : code === 30701 ? 404 : code === 50001 ? 500 : 400;
  expect(sent.response.statusCode).toBe(status);
  expect(sent.response.json()).toMatchObject({ code });
  if (code === 30701) expect(sent.response.json()).not.toHaveProperty('data');
  await validate(sent, op);
  const body = sent.response.json<Record<string, unknown>>();
  const { trace_id: trace, ...stable } = body;
  expect(trace).toBe(sent.trace);
  return stable;
}

/** A real persisted user/session with the api entry's signing key, not an arbitrary Bearer. */
export async function userBearer(h: Harness, f: Setup) {
  const device = await f.api.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: {
      'content-type': 'application/json',
      'x-app-id': f.appId,
      'x-platform': 'ios',
      'x-app-version': '1.0.0',
    },
    payload: JSON.stringify({ device_hash: hash(randomUUID()), id_source: 'idfv' }),
  });
  expect(device.statusCode).toBe(200);
  expect(device.json()).toMatchObject({ code: 0, data: { device_id: expect.any(String) } });
  const deviceId = device.json<{ data: { device_id: string } }>().data.device_id;
  const user = await seedUser(h.db, f.appId);
  const tokens = createTokenService({
    clock: f.clock,
    keys: {
      kid: 'f1-06k-app',
      privateKey: h.appKey.privateKey,
      publicKeys: new Map([['f1-06k-app', h.appKey.publicKey]]),
    },
  });
  const session = await h.db
    .transaction()
    .execute((tx) =>
      createSession(
        tx,
        { uid: user.id, app_id: f.appId, device_id: deviceId, scp: 'full' },
        { clock: f.clock, tokens },
      ),
    );
  expect(await tokens.verifyAccess(session.access_token)).toMatchObject({
    uid: user.id,
    sid: session.sid,
  });
  return { authorization: `Bearer ${session.access_token}` };
}
