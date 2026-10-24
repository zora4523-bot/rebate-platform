import { expect } from 'vitest';
import { SUPER, type Harness, type HttpApp, type Response } from '../auth/kit.ts';
import { setup as accountsSetup, type Account } from '../admins-write/kit.ts';
import { validate } from '../exports/kit.ts';

export {
  alive,
  failingApp,
  harness,
  signInAgain,
  text,
  type Account,
} from '../admins-write/kit.ts';

/** Contract CT-24o adminSaveAdminPermissions. */
export const PATH = `${SUPER}/{admin_id}/permissions`;
export const OPERATION_ID = 'adminSaveAdminPermissions';

type Code = 10001 | 10003 | 10403 | 20001 | 20902 | 50001;
const STATUS: Record<Code, number> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20902: 409,
  50001: 500,
};

interface Injector {
  inject(request: {
    method: 'PUT';
    url: string;
    headers: Record<string, string>;
    payload: string;
    remoteAddress: string;
  }): Promise<Response>;
}

export interface Save {
  readonly token: string;
  readonly id: string;
  readonly body: object;
  readonly step?: string;
}

/** Raw PUT …/permissions on `app` (no step-up token unless given). */
export function saver(app: HttpApp) {
  // HttpApp's typed inject lists GET / POST / OPTIONS only; Fastify inject also takes PUT.
  const injector = app as unknown as Injector;
  return (input: Save): Promise<Response> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${input.token}`,
      'content-type': 'application/json',
    };
    if (input.step !== undefined) headers['x-step-up-token'] = input.step;
    return injector.inject({
      method: 'PUT',
      url: PATH.replace('{admin_id}', input.id),
      headers,
      payload: JSON.stringify(input.body),
      remoteAddress: '127.0.0.1',
    });
  };
}

export async function saved(response: Response): Promise<Account> {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response, PATH, 'put');
  return response.json<{ data: Account }>().data;
}

/** An error envelope of the operation; `data` is compared exactly when given. */
export async function refused(response: Response, code: Code, data?: object) {
  expect(response.statusCode).toBe(STATUS[code]);
  expect(response.json()).toMatchObject({ code });
  if (data !== undefined) expect(response.json<{ data?: unknown }>().data).toEqual(data);
  await validate(response, PATH, 'put');
}

/**
 * Same timezone tolerance as the B1-34h writes; permission points are compared as a set (the
 * contract fixes no order).
 */
export function expectAccount(actual: Account, expected: Account) {
  expect({
    ...actual,
    permissions: [...actual.permissions].sort(),
    created_at: new Date(actual.created_at).toISOString(),
    locked_until: actual.locked_until === null ? null : new Date(actual.locked_until).toISOString(),
  }).toEqual({ ...expected, permissions: [...expected.permissions].sort() });
}

/** The B1-34h fixture (super admin signed in, real couli_app rows) plus the save. */
export async function setup(h: Harness) {
  const f = await accountsSetup(h);
  const save = saver(f.app);

  /** The save as the fixture's super admin with a fresh totp-tier step-up token. */
  const put = async (id: string, body: object) =>
    save({ token: f.token, id, body, step: await f.issue() });

  /** admin_permissions rows of `adminId` in this app, by key. */
  const grants = (adminId: string) =>
    h.db
      .selectFrom('admin_permissions')
      .selectAll()
      .where('app_id', '=', f.appId)
      .where('admin_id', '=', adminId)
      .orderBy('permission_key')
      .execute();

  return { ...f, save, put, grants };
}
export type Setup = Awaited<ReturnType<typeof setup>>;
