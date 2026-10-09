import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import {
  smsSenderToken,
  type FakeSmsSender,
} from '../../../../apps/api/src/modules/identity/infra/fake-sms.ts';
import { FIELD_CRYPTO, type FieldCrypto } from '../../../../apps/api/src/modules/platform/index.ts';
import { responseValidator, type Response } from '../../identity/sms-codes/http-kit.ts';
import { sign } from '../signature/kit.ts';
import {
  registered,
  withHttp as withDeviceHttp,
  type HttpFixture as DeviceFixture,
} from '../device-register/kit.ts';
import { hash, IP } from './kit.ts';

export { openSuite, closeSuite } from '../device-register/kit.ts';
type Suite = Parameters<typeof withDeviceHttp>[0];
export interface Client {
  deviceId: string;
  deviceHash: string;
  send(
    phone: string,
    ip?: string,
    extraBody?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<Response>;
  post(
    path: string,
    body: Record<string, unknown>,
    ip?: string,
    headers?: Record<string, string>,
  ): Promise<Response>;
}
export interface HttpFixture extends DeviceFixture {
  sender: FakeSmsSender;
  crypto: FieldCrypto;
  client(deviceHash?: string, appId?: string): Promise<Client>;
}
export async function withHttp(
  suite: Suite,
  config: Record<string, unknown>,
  run: (f: HttpFixture) => Promise<void>,
) {
  await withDeviceHttp(suite, config, async (f) => {
    const sender = f.app.get<FakeSmsSender>(smsSenderToken());
    let sequence = 0;
    await run({
      ...f,
      sender,
      crypto: f.app.get<FieldCrypto>(FIELD_CRYPTO),
      async client(deviceHash = hash(), appId = f.id) {
        // Registration IP is independent of SMS IP and of other devices (B1-03f cap).
        const data = await registered(await f.send(`198.51.100.${++sequence}`, deviceHash, appId));
        const post: Client['post'] = (path, body, ip = IP, extraHeaders = {}) => {
          const raw = JSON.stringify(body);
          const timestamp = String(Math.floor(f.clock.now().getTime() / 1000));
          const nonce = randomBytes(16).toString('hex');
          return f.app.inject({
            method: 'POST',
            url: path,
            remoteAddress: ip,
            payload: raw,
            headers: {
              'content-type': 'application/json',
              'x-app-id': appId,
              'x-platform': 'ios',
              'x-app-version': '2.0.0',
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
          post,
          send: (phone, ip, extra = {}, headers) =>
            post('/v1/auth/sms-codes', { phone, purpose: 'login', ...extra }, ip, headers),
        };
      },
    });
  });
}

let validators: ReturnType<typeof responseValidator> | undefined;
export async function result(response: Response, code: number, seconds?: number) {
  expect(response.json<{ code: number }>().code).not.toBe(44003);
  expect(response.json()).toMatchObject({ code });
  expect(response.statusCode).toBe(
    code === 0
      ? 200
      : code === 42901
        ? 429
        : code === 50001
          ? 500
          : code === 44001
            ? 403
            : code === 20001
              ? 400
              : 401,
  );
  validators ??= responseValidator();
  const schema = await validators;
  const validate = code === 0 ? schema.validate : schema.validateError;
  expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
  if (code === 42901) {
    expect(String(response.headers['retry-after'])).toMatch(/^[1-9][0-9]*$/);
    if (seconds !== undefined) expect(Number(response.headers['retry-after'])).toBe(seconds);
  }
}
