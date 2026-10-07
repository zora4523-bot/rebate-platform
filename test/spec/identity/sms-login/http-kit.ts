import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { apiRequire, ROOT, sign } from '../../risk/signature/kit.ts';
import type { HttpApp, Response } from '../sms-codes/http-kit.ts';

export async function client(app: HttpApp, clock: FixedClock) {
  const deviceHash = createHash('sha256').update(randomUUID()).digest('hex');
  const headers = {
    'content-type': 'application/json',
    'x-app-id': 'couli',
    'x-platform': 'ios',
    'x-app-version': '2.0.0',
  };
  const created = await app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({
      device_hash: deviceHash,
      id_source: 'idfv',
    }),
  });
  expect(created.statusCode).toBe(200);
  const { data } = created.json<{ data: { device_id: string; install_secret: string } }>();
  expect(data.device_id).toEqual(expect.any(String));
  const post = (
    path: string,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ) => {
    const raw = JSON.stringify(body);
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
        ...extraHeaders,
      },
    });
  };
  return {
    deviceId: data.device_id,
    deviceHash,
    send: (phone: string) => post('/v1/auth/sms-codes', { phone, purpose: 'login' }),
    login: (body: Record<string, unknown>, extraHeaders?: Record<string, string>) =>
      post('/v1/auth/login/sms', body, extraHeaders),
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
        { post: { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> } }
      >;
    }>;
  };
  const document = await parser.dereference(
    fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
    { resolve: { external: false } },
  );
  const schema =
    document.paths['/v1/auth/login/sms']!.post.responses[success ? '200' : '4XX']!.content[
      'application/json'
    ]!.schema;
  const check = createValidatorCompiler()({ schema, httpPart: 'body' });
  expect(check(response.json())).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}
