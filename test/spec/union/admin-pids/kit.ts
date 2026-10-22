// B1-22h / BR-ATTR-02, SPEC_REF 17b5fe5. Real admin HTTP + business-role PG;
// only the container runner executes this fixture. No service or authorization mocks.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { DB } from '@couli/db';
import type { Insertable } from 'kysely';
import { expect } from 'vitest';
import {
  account,
  apiRequire,
  fixture,
  signedIn,
  totp,
  type Harness,
  type Response,
} from '../../admin/auth/kit.ts';
import { ok, STEP, type Grant } from '../../admin/step-up/kit.ts';
import { PNG } from './image-fixtures.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const BASE = '/admin/v1/union-pids';
export const WRITES = ['create', 'update', 'activate', 'retire'] as const;
export type Action = (typeof WRITES)[number];
export type Pid = Schema<'AdminUnionPid'>;
export const CONFIRMED = '2026-10-09T01:00:00.000Z';
export const REASON = '核对花卷云忽略登记后更换推广位';
export { PNG };

export interface Upload {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly filename: string;
}

export function multipart(parts: Record<string, unknown>, file: Upload | null) {
  const boundary = `b1-22h-${randomUUID()}`;
  const buffers: Buffer[] = [];
  for (const [name, value] of Object.entries(parts)) {
    if (value === undefined) continue;
    buffers.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`,
      ),
    );
  }
  if (file !== null) {
    buffers.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="hjy_ignore_evidence"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      ),
      file.bytes,
      Buffer.from('\r\n'),
    );
  }
  buffers.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(buffers),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

interface InjectRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  payload?: string | Buffer;
}

export async function setup(
  h: Harness,
  options: { grants?: readonly string[]; isSuper?: boolean } = {},
) {
  const appId = `admin_pids_${randomUUID().replaceAll('-', '')}`;
  const f = await fixture(h);
  const server = f.app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  // No planned-route fallback: every case must exercise the actual admin assembly.
  for (const [method, url] of [
    ['GET', BASE],
    ['POST', BASE],
    ['PATCH', `${BASE}/:pid_id`],
    ['POST', `${BASE}/:pid_id/activate`],
    ['POST', `${BASE}/:pid_id/retire`],
  ] as const) {
    expect(server.hasRoute({ method, url }), `${method} ${url} is registered`).toBe(true);
  }
  const a = await account(h, { app_id: appId, is_super: options.isSuper ?? false });
  await h.db
    .updateTable('admin_users')
    .set({
      totp_secret_cipher: Buffer.from(
        h.fields.encrypt(a.secret, `admin_users.totp_secret:${appId}:${a.id}`),
      ),
    })
    .where('id', '=', a.id)
    .execute();
  for (const permission of options.grants ?? ['union.pid']) {
    await h.db
      .insertInto('admin_permissions')
      .values({
        app_id: appId,
        admin_id: a.id,
        permission_key: permission,
        granted_by: a.id,
        granted_at: f.clock.now(),
      })
      .execute();
  }
  const session = await signedIn(f, a);
  const inject = (input: InjectRequest) =>
    (f.app as unknown as { inject(request: InjectRequest): Promise<Response> }).inject(input);
  const issue = async () => {
    f.clock.advanceMs(30_000);
    const grant = await ok<Grant>(
      await f.post(
        '/step-up',
        {
          tier: 'totp',
          code: totp(a.secret, f.clock),
        },
        { authorization: `Bearer ${session.admin_token}` },
      ),
      STEP,
    );
    return grant.step_up_token;
  };
  const list = () =>
    inject({
      method: 'GET',
      url: BASE,
      headers: { authorization: `Bearer ${session.admin_token}` },
    });
  const write = async (
    action: Action,
    id: string,
    body: Record<string, unknown>,
    options: { token?: string | null; headers?: Record<string, string>; file?: Upload | null } = {},
  ) => {
    const token = options.token === undefined ? await issue() : options.token;
    const upload =
      action === 'activate'
        ? multipart(
            body,
            options.file === undefined
              ? { bytes: PNG, contentType: 'image/png', filename: 'hjy.png' }
              : options.file,
          )
        : undefined;
    return inject({
      method: action === 'update' ? 'PATCH' : 'POST',
      url: action === 'create' ? BASE : `${BASE}/${id}${action === 'update' ? '' : `/${action}`}`,
      headers: {
        authorization: `Bearer ${session.admin_token}`,
        'content-type': upload?.contentType ?? 'application/json',
        ...(token === null ? {} : { 'x-step-up-token': token }),
        ...options.headers,
      },
      payload: upload?.payload ?? JSON.stringify(body),
    });
  };
  const rows = () =>
    h.db.selectFrom('union_pids').selectAll().where('app_id', '=', appId).orderBy('id').execute();
  const accounts = () =>
    h.db
      .selectFrom('union_accounts')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute();
  const audits = () =>
    h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .where(
        'action',
        'in',
        WRITES.map((action) => `union_pid_${action}`),
      )
      .orderBy('id')
      .execute();
  return { h, f, a, appId, session, inject, issue, list, write, rows, accounts, audits };
}
export type Scenario = Awaited<ReturnType<typeof setup>>;

export async function seedAccount(
  s: Scenario,
  patch: Partial<Insertable<DB['union_accounts']>> = {},
) {
  return s.h.db
    .insertInto('union_accounts')
    .values({
      id: randomUUID(),
      app_id: s.appId,
      platform: 'jd',
      account_name: 'synthetic-account',
      status: 'active',
      auth_status: 'active',
      sync_start_at: null,
      created_at: s.f.clock.now(),
      updated_at: s.f.clock.now(),
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function seedPid(s: Scenario, patch: Partial<Insertable<DB['union_pids']>> = {}) {
  const platform = patch.platform ?? 'jd';
  const accountId = patch.union_account_id ?? (await seedAccount(s, { platform })).id;
  const pending = (patch.status ?? 'pending') === 'pending';
  return s.h.db
    .insertInto('union_pids')
    .values({
      id: randomUUID(),
      app_id: s.appId,
      platform,
      union_account_id: accountId,
      site_id: platform === 'taobao' ? '3001' : null,
      pid: randomUUID(),
      pid_scene: 'self_buy',
      status: 'pending',
      row_version: 7,
      hjy_ignore_confirmed_at: pending ? null : new Date(CONFIRMED),
      hjy_ignore_evidence_path: pending ? null : `union-pids/${randomUUID()}/hjy.png`,
      created_at: s.f.clock.now(),
      updated_at: s.f.clock.now(),
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
export type PidRow = Awaited<ReturnType<typeof seedPid>>;
export function bodyFor(action: Action, row: PidRow): Record<string, unknown> {
  if (action === 'create')
    return {
      platform: row.platform,
      union_account_id: row.union_account_id,
      site_id: row.site_id,
      pid: randomUUID(),
      pid_scene: row.pid_scene,
    };
  return {
    expected_row_version: row.row_version,
    ...(action === 'update' ? { pid: randomUUID() } : {}),
    ...(action === 'activate' ? { hjy_ignore_confirmed_at: CONFIRMED } : {}),
  };
}
export async function current(s: Scenario, id: string) {
  return s.h.db.selectFrom('union_pids').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}
export async function snapshot(s: Scenario) {
  return { rows: await s.rows(), accounts: await s.accounts(), audits: await s.audits() };
}

let schemas: Promise<Record<string, JsonSchema>> | undefined;
export async function validate(response: Response, list = false) {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  schemas ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    })
    .then((doc) => doc.components.schemas);
  const name =
    response.json().code !== 0
      ? 'ErrorEnvelope'
      : list
        ? 'AdminUnionPidListResponse'
        : 'AdminUnionPidResponse';
  const check = createValidatorCompiler()({ schema: (await schemas)[name]!, httpPart: 'body' });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}
export async function accepted(response: Response): Promise<Pid> {
  expect(response.statusCode).toBe(200);
  expect(response.json().code).toBe(0);
  await validate(response);
  return response.json<{ data: Pid }>().data;
}
export async function listed(s: Scenario): Promise<Pid[]> {
  const response = await s.list();
  expect(response.statusCode).toBe(200);
  expect(response.json().code).toBe(0);
  await validate(response, true);
  return response.json<{ data: { items: Pid[] } }>().data.items;
}
export async function rejected(response: Response, code: number, data?: object) {
  expect(response.statusCode).toBe(
    code === 20902 ? 409 : code === 30155 ? 422 : code === 20001 ? 400 : code === 10001 ? 401 : 403,
  );
  expect(response.json().code).toBe(code);
  if (data === undefined) expect(response.json()).not.toHaveProperty('data');
  else expect(response.json().data).toEqual(data);
  await validate(response);
}
export async function audit(s: Scenario, action: Action, id: string, reason?: string) {
  const rows = (await s.audits()).filter((row) => row.action === `union_pid_${action}`);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    app_id: s.appId,
    admin_id: s.a.id,
    action: `union_pid_${action}`,
    at: s.f.clock.now(),
  });
  expect(rows[0]!.target).toContain(id);
  if (reason !== undefined) expect(rows[0]!.after).toMatchObject({ reason });
  return rows[0]!;
}
