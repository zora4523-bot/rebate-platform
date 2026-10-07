import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { RefreshPair } from '../../../../apps/api/src/modules/identity/application/refresh.ts';
import { expect } from 'vitest';
import type { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { apiRequire, ROOT, sign } from '../../risk/signature/kit.ts';
import type { HttpApp, Response } from '../sms-codes/http-kit.ts';
import { hash } from './kit.ts';

export async function client(app: HttpApp, clock: FixedClock, appId = 'couli') {
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-app-version': '2.0.0',
  };
  const created = await app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: hash(randomUUID()), id_source: 'idfv' }),
  });
  expect(created.statusCode).toBe(200);
  const { data } = created.json<{ data: { device_id: string; install_secret: string } }>();
  expect(data.device_id).toEqual(expect.any(String));
  return {
    deviceId: data.device_id,
    refresh(refresh_token: string, extra: Record<string, string> = {}) {
      const path = '/v1/auth/refresh';
      const raw = JSON.stringify({ refresh_token });
      const timestamp = String(Math.floor(clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      return app.inject({
        method: 'POST',
        url: path,
        payload: raw,
        headers: {
          ...headers,
          'x-device-id': data.device_id,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-sign': sign('POST', path, Buffer.from(raw), timestamp, nonce, data.install_secret),
          ...extra,
        },
      });
    },
  };
}

export async function validate(response: Response, success: boolean) {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{
      paths: Record<
        string,
        {
          post: { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> };
        }
      >;
    }>;
  };
  const document = await parser.dereference(
    fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
    { resolve: { external: false } },
  );
  const schema =
    document.paths['/v1/auth/refresh']!.post.responses[success ? '200' : '4XX']!.content[
      'application/json'
    ]!.schema;
  const check = createValidatorCompiler()({ schema, httpPart: 'body' });
  expect(check(response.json())).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}
export async function accepted(response: Response): Promise<RefreshPair> {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    code: 0,
    msg: expect.any(String),
    trace_id: expect.any(String),
  });
  await validate(response, true);
  return response.json<{ data: RefreshPair }>().data;
}
export async function rejected(response: Response, code: 10401 | 10403 | 10404) {
  expect(response.statusCode).toBe(code === 10403 ? 403 : 401);
  expect(response.json()).toMatchObject({
    code,
    msg: expect.any(String),
    trace_id: expect.any(String),
  });
  expect(response.json()).not.toHaveProperty('data');
  await validate(response, false);
}
