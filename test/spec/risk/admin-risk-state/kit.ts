import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { components } from '../../../../packages/contracts-ts/src/openapi.gen.ts';
import { expect } from 'vitest';
import { apiRequire, signedIn, type Harness, type Response } from '../../admin/auth/kit.ts';
import { setup as bindingSetup } from '../../linking/admin-union-bindings/kit.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
export { binding, current } from '../../linking/admin-union-bindings/kit.ts';

type Schema<Name extends keyof components['schemas']> = components['schemas'][Name];

export const ACTIONS = ['ban', 'unban', 'freeze', 'unfreeze'] as const;
export type Action = (typeof ACTIONS)[number];
export const REASON = '人工核实后调整账号状态';
export const ROOT = new URL('../../../../', import.meta.url);
export const permission = (action: Action) =>
  ['ban', 'unban'].includes(action) ? 'risk.ban' : 'risk.freeze';
export function body(
  action: Action,
  version: number | null = null,
): Schema<'AdminUserRiskStateUpdateRequest'> {
  return {
    action,
    reason: REASON,
    expected_row_version: version,
    ...(['ban', 'freeze'].includes(action) ? { reason_category: 'other' as const } : {}),
  };
}

export async function setup(h: Harness, options: Parameters<typeof bindingSetup>[1] = {}) {
  const s = await bindingSetup(h, {
    ...options,
    grants: options.grants ?? ['risk.ban', 'risk.freeze', 'union.binding_disable'],
  });
  s.f.clock.advanceMs(30_000);
  const session = await signedIn(s.f, s.a);
  // Shared harness predates PUT: widen only the transport, never register a fake route.
  const app = s.f.app as unknown as {
    inject(request: {
      method: 'PUT';
      url: string;
      headers: Record<string, string>;
      payload: string;
    }): Promise<Response>;
  };
  const put = async (
    input: Record<string, unknown>,
    opts: { token?: string | null; userId?: string; headers?: Record<string, string> } = {},
  ) => {
    const token = opts.token === undefined ? await s.issue() : opts.token;
    return app.inject({
      method: 'PUT',
      url: `/admin/v1/users/${opts.userId ?? s.userId}/risk-state`,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.admin_token}`,
        ...(token === null ? {} : { 'x-step-up-token': token }),
        ...opts.headers,
      },
      payload: JSON.stringify(input),
    });
  };
  const riskRows = () =>
    h.db
      .selectFrom('user_risk_state')
      .selectAll()
      .where('app_id', '=', s.appId)
      .where('user_id', '=', s.userId)
      .execute();
  const audits = () =>
    h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', s.appId)
      .where('action', '=', 'user_risk_state_change')
      .orderBy('id')
      .execute();
  const events = () =>
    h.db
      .selectFrom('event_log')
      .selectAll()
      .where('app_id', '=', s.appId)
      .where('name', '=', 'risk.state_changed')
      .orderBy('id')
      .execute();
  const sessions = () =>
    h.db
      .selectFrom('sessions')
      .selectAll()
      .where('app_id', '=', s.appId)
      .where('user_id', '=', s.userId)
      .orderBy('sid')
      .execute();
  const snapshot = async () => ({
    risk: await riskRows(),
    audits: await audits(),
    events: await events(),
    sessions: await sessions(),
    bindings: await s.rows(),
  });
  return { ...s, put, riskRows, riskAudits: audits, events, sessions, snapshot };
}
export type Scenario = Awaited<ReturnType<typeof setup>>;
export async function seedState(
  s: Scenario,
  state: 'normal' | 'banned' | 'frozen' | 'appealing',
  version = 7,
) {
  await s.h.db
    .insertInto('user_risk_state')
    .values({
      app_id: s.appId,
      user_id: s.userId,
      state,
      reason_category: state === 'normal' ? null : 'other',
      reason: '原原因',
      frozen_until: state === 'frozen' ? '2090-01-01T00:00:00Z' : null,
      changed_by: 'fixture',
      changed_at: s.f.clock.now(),
      row_version: version,
    })
    .execute();
}
export async function prepare(s: Scenario, action: Action) {
  if (action === 'unban' || action === 'unfreeze') {
    await seedState(s, action === 'unban' ? 'banned' : 'frozen');
    return body(action, 7);
  }
  return body(action);
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
  const name = response.json().code === 0 ? 'AdminUserRiskStateResponse' : 'ErrorEnvelope';
  const check = createValidatorCompiler()({ schema: (await schemas)[name]!, httpPart: 'body' });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}
export async function accepted(response: Response) {
  expect(response.statusCode).toBe(200);
  expect(response.json().code).toBe(0);
  await validate(response);
  return response.json<{ data: Schema<'AdminUserRiskState'> }>().data;
}
export async function rejected(response: Response, code: number, data?: object) {
  expect(response.statusCode).toBe(
    code === 20902 ? 409 : code === 20001 ? 400 : code === 50001 ? 500 : 403,
  );
  expect(response.json().code).toBe(code);
  expect(response.json().data).toEqual(data);
  await validate(response);
}
export function gateRequest(s: Scenario) {
  return {
    id: randomUUID(),
    method: 'GET',
    routeOptions: { url: '/v1/orders' },
    headers: {},
    principal: {
      app_id: s.appId,
      uid: s.userId,
      sid: 'new-session-after-ban',
      device_id: randomUUID(),
      scp: 'full' as const,
    },
  };
}
