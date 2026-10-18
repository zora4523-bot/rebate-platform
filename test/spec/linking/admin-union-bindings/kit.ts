import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
import { seedUser } from '../../identity/registration/kit.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

export const ACTIONS = ['reset', 'disable', 'enable'] as const;
export type Action = (typeof ACTIONS)[number];
export const REASON = '用户反馈错绑，核实后处理';
export const ROOT = new URL('../../../../', import.meta.url);
export const STATES = [
  ['active', null],
  ['invalid', null],
  ['pending_auth', null],
  ['unbound', null],
  ['blocked', 'ban'],
  ['blocked', 'admin_disable'],
  ['blocked', 'deletion'],
  ['released', null],
  ['absent', null],
] as const;
export const permission = (action: Action) =>
  action === 'reset' ? 'union.binding_reset' : 'union.binding_disable';

export async function setup(
  h: Harness,
  options: {
    appId?: string;
    userId?: string;
    grants?: readonly string[];
    isSuper?: boolean;
    now?: string;
  } = {},
) {
  const appId = options.appId ?? `admin_binding_${randomUUID().replaceAll('-', '')}`;
  const f = await fixture(h);
  if (options.now !== undefined) f.clock.set(options.now);
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
  const userId = options.userId ?? (await seedUser(h.db, appId));
  for (const key of options.grants ?? ['union.binding_reset', 'union.binding_disable']) {
    await h.db
      .insertInto('admin_permissions')
      .values({
        app_id: appId,
        admin_id: a.id,
        permission_key: key,
        granted_by: a.id,
        granted_at: f.clock.now(),
      })
      .execute();
  }
  const session = await signedIn(f, a);
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
  const rows = () =>
    h.db
      .selectFrom('union_bindings')
      .selectAll()
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .orderBy('id')
      .execute();
  const audits = () =>
    h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .where('admin_id', '=', a.id)
      .where(
        'action',
        'in',
        ACTIONS.map((action) => `union_binding_${action}`),
      )
      .orderBy('id')
      .execute();
  const post = async (
    action: Action,
    body: Record<string, unknown>,
    options: {
      platform?: string;
      userId?: string;
      token?: string | null;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const token = options.token === undefined ? await issue() : options.token;
    return f.app.inject({
      method: 'POST',
      url: `/admin/v1/users/${options.userId ?? userId}/union-bindings/${options.platform ?? 'taobao'}/${action}`,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.admin_token}`,
        ...(token === null ? {} : { 'x-step-up-token': token }),
        ...options.headers,
      },
      payload: JSON.stringify(body),
    });
  };
  return { h, f, a, appId, userId, issue, post, rows, audits };
}
export type Scenario = Awaited<ReturnType<typeof setup>>;

export async function binding(s: Scenario, patch: Partial<Insertable<DB['union_bindings']>> = {}) {
  const platform = patch.platform ?? 'taobao';
  const accountId = patch.union_account_id ?? randomUUID();
  if (patch.union_account_id === undefined) {
    await s.h.db
      .insertInto('union_accounts')
      .values({
        id: accountId,
        app_id: s.appId,
        platform,
        account_name: 'synthetic-account',
        status: 'active',
        auth_status: 'active',
      })
      .execute();
  }
  const released = patch.status === 'released';
  return s.h.db
    .insertInto('union_bindings')
    .values({
      id: randomUUID(),
      app_id: s.appId,
      user_id: s.userId,
      platform,
      union_account_id: accountId,
      relation_id: platform === 'taobao' ? randomUUID().replaceAll('-', '') : null,
      status: 'active',
      blocked_reason: null,
      reason: null,
      row_version: 7,
      bound_at: new Date('2026-10-01T00:00:00Z'),
      released_at: released ? s.f.clock.now() : null,
      cooldown_until: released ? new Date(s.f.clock.now().getTime() + 86_400_000) : null,
      created_at: s.f.clock.now(),
      updated_at: s.f.clock.now(),
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
export async function risk(s: Scenario, state: 'normal' | 'banned') {
  await s.h.db
    .insertInto('user_risk_state')
    .values({
      app_id: s.appId,
      user_id: s.userId,
      state,
      reason_category: state === 'banned' ? 'other' : null,
      changed_by: 'synthetic',
      changed_at: s.f.clock.now(),
    })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({
        state,
        reason_category: state === 'banned' ? 'other' : null,
      }),
    )
    .execute();
}
export async function current(s: Scenario, id: string) {
  return s.h.db
    .selectFrom('union_bindings')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}
export async function snapshot(s: Scenario) {
  return { rows: await s.rows(), audits: await s.audits() };
}

let schemas: Promise<Record<string, JsonSchema>> | undefined;
export async function validate(response: Response) {
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
  const name = response.json().code === 0 ? 'AdminUserUnionBindingResponse' : 'ErrorEnvelope';
  const check = createValidatorCompiler()({ schema: (await schemas)[name]!, httpPart: 'body' });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}
export async function accepted(response: Response) {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response);
  return response.json<{ data: Record<string, unknown> }>().data;
}
export async function rejected(response: Response, code: number, data?: object) {
  expect(response.statusCode).toBe(
    code === 20902 ? 409 : code === 30154 ? 422 : code === 20001 ? 400 : 403,
  );
  expect(response.json().code).toBe(code);
  expect(response.json().data).toEqual(data);
  await validate(response);
}
