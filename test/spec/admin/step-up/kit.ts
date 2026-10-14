import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { components } from '../../../../packages/contracts-ts/src/openapi.gen.ts';
import {
  smsSenderToken,
  type FakeSmsSender,
} from '../../../../apps/api/src/modules/identity/infra/fake-sms.ts';
import type { RedisHandle } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { phone } from '../../identity/sms-codes/kit.ts';
import {
  account,
  apiRequire,
  fixture,
  signedIn,
  type Fixture,
  type Harness,
  type Response,
} from '../auth/kit.ts';
import { ROOT } from '../permissions/expected.ts';

export const SEND = '/admin/v1/auth/step-up/sms-codes';
export const STEP = '/admin/v1/auth/step-up';
export const ME = '/admin/v1/me/permissions';
export type Grant = components['schemas']['AdminStepUpData'];
export type Me = components['schemas']['AdminMe'];

type Check = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let validators: Promise<Map<string, Check>> | undefined;
async function checks() {
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
            {
              responses: Record<
                string,
                {
                  content: Record<string, { schema: JsonSchema }>;
                }
              >;
            }
          >
        >;
      }>;
    };
    const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    });
    const result = new Map<string, Check>();
    const compile = createValidatorCompiler();
    for (const path of [SEND, STEP, ME]) {
      const operation = doc.paths[path]![path === ME ? 'get' : 'post']!;
      for (const status of ['200', '429', '4XX', '5XX']) {
        result.set(
          `${path}:${status}`,
          compile({
            schema: operation.responses[status]!.content['application/json']!.schema,
            httpPart: 'body',
          }),
        );
      }
    }
    return result;
  })();
  return validators;
}

export async function validate(response: Response, path: string) {
  const status =
    response.statusCode === 429
      ? '429'
      : response.statusCode < 400
        ? '200'
        : response.statusCode < 500
          ? '4XX'
          : '5XX';
  const check = (await checks()).get(`${path}:${status}`)!;
  expect(check(response.json())).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}

export async function ok<T>(response: Response, path: string): Promise<T> {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response, path);
  return response.json<{ data: T }>().data;
}

export async function error(response: Response, path: string, code: number, data?: object) {
  const status =
    code === 10003 || code === 10403 || code === 10009
      ? 403
      : code === 10001
        ? 401
        : code === 42901
          ? 429
          : code >= 50000
            ? 500
            : 400;
  expect(response.statusCode).toBe(status);
  expect(response.json()).toMatchObject({ code });
  if (data === undefined) expect(response.json()).not.toHaveProperty('data');
  else expect(response.json()).toHaveProperty('data', data);
  await validate(response, path);
}

export async function registered(h: Harness, isSuper = false) {
  const number = phone('138');
  const a = await account(h, { is_super: isSuper });
  await h.db
    .updateTable('admin_users')
    .set({
      verify_phone_cipher: Buffer.from(
        h.fields.encrypt(number, `admin_users.verify_phone:couli:${a.id}`),
      ),
      verify_phone_hmac: h.fields.blindIndex(number, 'admin_users.verify_phone'),
      verify_phone_set_at: '2026-10-09T02:00:00.000Z',
    })
    .where('id', '=', a.id)
    .execute();
  return { ...a, number };
}

export async function setup(h: Harness, hasPhone = true) {
  const f = await fixture(h, { probes: true });
  const a = hasPhone ? await registered(h) : await account(h);
  const session = await signedIn(f, a);
  const headers = { authorization: `Bearer ${session.admin_token}` };
  return {
    f,
    a,
    session,
    headers,
    send: () => f.post('/step-up/sms-codes', {}, headers),
    step: (tier: 'sms' | 'totp', code: string) => f.post('/step-up', { tier, code }, headers),
  };
}

export function sender(f: Fixture): FakeSmsSender {
  let result: FakeSmsSender | undefined;
  expect(() => {
    result = f.app.get<FakeSmsSender>(smsSenderToken());
  }, '后台入口须提供 identity 的假短信发送器').not.toThrow();
  expect(result).toBeDefined();
  return result!;
}

export function lastCode(f: Fixture): string {
  const message = sender(f).outbox().at(-1);
  expect(message).toBeDefined();
  expect(message!.code).toMatch(/^\d{6}$/);
  return message!.code;
}

export async function redisOf(f: Fixture): Promise<RedisHandle> {
  const { REDIS } = (await import(
    new URL('apps/api/src/modules/platform/platform.module.ts', ROOT).href
  )) as { REDIS: symbol };
  return f.app.get<RedisHandle>(REDIS);
}
