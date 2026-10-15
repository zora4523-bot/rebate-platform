import { expect, vi } from 'vitest';
import {
  AdminOperationGuard,
  type AdminActor,
  type AdminOperationResponse,
} from '../../../../apps/api/src/modules/platform/http/admin-guard.ts';
import type { AdminPrincipalCarrier } from '../../../../apps/api/src/modules/platform/http/admin-context.ts';
import {
  account,
  fixture,
  signedIn,
  totp,
  type Harness,
  type HttpApp,
  type Response,
} from '../auth/kit.ts';
import { ROOT } from '../permissions/expected.ts';
import { lastCode, ok, registered, SEND, STEP, validate, type Grant } from '../step-up/kit.ts';

export const PROBE = '/admin/v1/platform-icons';
export const TRACE = '8f268c53-b3c8-4bfd-87dd-61e8a7f16aa1';

export interface ProbeRequest extends AdminPrincipalCarrier {
  readonly id: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface ProbeServer {
  hasRoute(input: { method: 'GET'; url: string }): boolean;
  get(
    path: string,
    handler: (
      request: ProbeRequest,
      reply: { code(status: number): { send(body: unknown): unknown } },
    ) => Promise<unknown>,
  ): unknown;
}

export async function exportedGuard() {
  // Dynamic import avoids pulling Nest decorators into the erasable-only test TS project.
  const platform = (await import(new URL('apps/api/src/modules/platform/index.ts', ROOT).href)) as {
    AdminOperationGuard: typeof AdminOperationGuard;
  };
  const http = (await import(
    new URL('apps/api/src/modules/platform/http/index.ts', ROOT).href
  )) as { AdminOperationGuard: typeof AdminOperationGuard };
  expect(platform.AdminOperationGuard).toBe(AdminOperationGuard);
  expect(http.AdminOperationGuard).toBe(AdminOperationGuard);
  return platform.AdminOperationGuard;
}

export async function guardOf(app: HttpApp): Promise<AdminOperationGuard> {
  const token = await exportedGuard();
  const container = app as unknown as {
    get<T>(token: typeof AdminOperationGuard): T;
  };
  let guard: AdminOperationGuard | undefined;
  // A missing provider must fail an assertion, not escape as a Nest lookup error.
  expect(() => {
    guard = container.get<AdminOperationGuard>(token);
  }, 'admin 入口必须提供 platform 的 AdminOperationGuard').not.toThrow();
  expect(guard).toBeInstanceOf(token);
  return guard!;
}

export async function setup(
  h: Harness,
  options: {
    permission?: string;
    operation?: string;
    grants?: readonly string[];
    isSuper?: boolean;
    phone?: boolean;
  } = {},
) {
  const f = await fixture(h);
  const guard = await guardOf(f.app);
  const isSuper = options.isSuper ?? false;
  const a =
    options.phone === true ? await registered(h, isSuper) : await account(h, { is_super: isSuper });
  const selection = {
    permission: options.permission ?? 'content.platform_icon',
    ...(options.operation === undefined ? {} : { operation: options.operation }),
  };
  const grant = async (permission: string) => {
    await h.db
      .insertInto('admin_permissions')
      .values({
        app_id: 'couli',
        admin_id: a.id,
        permission_key: permission,
        granted_by: a.id,
        granted_at: f.clock.now(),
      })
      .execute();
  };
  for (const key of options.grants ?? [selection.permission]) await grant(key);
  const business = vi.fn(async (actor: AdminActor): Promise<AdminOperationResponse> => ({
    statusCode: 200,
    body: { code: 0, data: actor },
  }));
  const requests: ProbeRequest[] = [];
  const hooks: { beforeRun?: (request: ProbeRequest) => Promise<void> } = {};
  const server = f.app.getHttpAdapter().getInstance() as unknown as ProbeServer;
  expect(server.hasRoute({ method: 'GET', url: PROBE }), 'F1-06u 不挂真实业务路由').toBe(false);
  // This contract path has x-auth admin. The real F1-06k preParsing check attaches the principal.
  server.get(PROBE, async (request, reply) => {
    requests.push(request);
    await hooks.beforeRun?.(request);
    const response = await guard.run({ request, ...selection }, business);
    return reply.code(response.statusCode).send(response.body);
  });
  const session = await signedIn(f, a);
  const headers = { authorization: `Bearer ${session.admin_token}` };
  const read = (token?: string, extra: Record<string, string> = {}) =>
    f.read(session.admin_token, PROBE, {
      'x-trace-id': TRACE,
      ...(token === undefined ? {} : { 'x-step-up-token': token }),
      ...extra,
    });
  const issue = async (tier: 'totp' | 'sms' = 'totp') => {
    let code: string;
    if (tier === 'sms') {
      await ok(await f.post('/step-up/sms-codes', {}, headers), SEND);
      code = lastCode(f);
    } else {
      f.clock.advanceMs(30_000);
      code = totp(a.secret, f.clock);
    }
    return ok<Grant>(await f.post('/step-up', { tier, code }, headers), STEP);
  };
  return { f, a, guard, selection, business, requests, hooks, session, read, issue, grant };
}

export async function rejected(response: Response, code: number, data?: object) {
  expect(response.statusCode).toBe(code === 10001 ? 401 : code === 50001 ? 500 : 403);
  expect(response.json()).toMatchObject({ code, msg: expect.any(String), trace_id: TRACE });
  expect(response.json().data).toEqual(data);
  // Shared contract ErrorEnvelope; the successful probe payload is test-only.
  await validate(response, STEP);
}

export function allowed(response: Response, actor: AdminActor) {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ code: 0, data: actor });
}
