import { randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type {
  TokenKeyProvider,
  TokenService,
} from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type { ThirdPartyIdentityPort } from '../../../../apps/api/src/modules/identity/application/step-up.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import {
  TOKEN_KEYS,
  TOKEN_SERVICE,
  SMS_CODES,
} from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import type { SmsCodeService } from '../../../../apps/api/src/modules/identity/application/sms-codes.ts';
import {
  FIELD_CRYPTO,
  REDIS,
  type FieldCrypto,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { apiRequire, ROOT, sign } from '../../risk/signature/kit.ts';
import { seedUser } from '../registration/kit.ts';
import { openSuite, closeSuite, type Suite } from '../session/kit.ts';
import { buildApp, outbox, type HttpApp, type Response } from '../sms-codes/http-kit.ts';
import { memoryLogger, phone } from '../sms-codes/kit.ts';
import { decode } from '../token/kit.ts';

export const ATTEMPTS = '/v1/auth/oauth-attempts';
export const STEP_UP = '/v1/auth/step-up';
export const H5 = '/v1/auth/h5-token';
export const CONSENTS = '/v1/consents';
export const INSTANT = '2026-10-08T02:00:00.000Z';
type Contract = {
  paths: Record<
    string,
    { post: { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> } }
  >;
};

export interface HttpKit {
  suite: Suite;
  app: HttpApp;
  dir: string;
  clock: FixedClock;
  document: Contract;
  exchange: ReturnType<typeof vi.fn<ThirdPartyIdentityPort['exchange']>>;
  lines: string[];
}

export async function openHttpKit(withPort = true): Promise<HttpKit> {
  const suite = await openSuite();
  const base = fileURLToPath(new URL('../../../../.tmp/', import.meta.url));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-02f-'));
  const clock = new FixedClock(INSTANT);
  const { logger, lines } = memoryLogger();
  const exchange = vi
    .fn<ThirdPartyIdentityPort['exchange']>()
    .mockResolvedValue({ unavailable: true });
  // Keep the real AppModule, guards and controllers. Only CT-15i's external exchange is a stub.
  const { IdentityModule } = (await import(
    new URL('apps/api/src/modules/identity/identity.module.ts', ROOT).href
  )) as {
    IdentityModule: {
      forRoot(options: {
        config: unknown;
        thirdPartyIdentity?: { useFactory(): ThirdPartyIdentityPort };
      }): unknown;
    };
  };
  const original = IdentityModule.forRoot;
  const wiring = vi
    .spyOn(IdentityModule, 'forRoot')
    .mockImplementation((options) =>
      original.call(
        IdentityModule,
        withPort
          ? { ...options, thirdPartyIdentity: { useFactory: () => ({ exchange }) } }
          : options,
      ),
    );
  let app: HttpApp | undefined;
  try {
    app = await buildApp(suite.db, dir, suite.server.url, clock, logger);
    await app.init();
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(path: string, options: object): Promise<Contract>;
    };
    const document = await parser.dereference(
      fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
      { resolve: { external: false } },
    );
    return { suite, app, dir, clock, document, exchange, lines };
  } catch (error) {
    await app?.close();
    await closeSuite(suite);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    wiring.mockRestore();
  }
}

export async function closeHttpKit(kit: HttpKit | undefined): Promise<void> {
  if (!kit) return;
  try {
    await kit.app.close();
  } finally {
    try {
      await closeSuite(kit.suite);
    } finally {
      rmSync(kit.dir, { recursive: true, force: true });
    }
  }
}

export async function client(kit: HttpKit, appId: string) {
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const created = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(created.statusCode).toBe(200);
  expect(created.json()).toMatchObject({ code: 0 });
  const data = created.json<{ data: { device_id: string; install_secret: string } }>().data;
  return {
    deviceId: data.device_id,
    async post(path: string, body: object, token?: string, extra: Record<string, string> = {}) {
      const raw = JSON.stringify(body);
      const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      return kit.app.inject({
        method: 'POST',
        url: path,
        payload: raw,
        headers: {
          ...headers,
          'x-device-id': data.device_id,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-sign': sign('POST', path, Buffer.from(raw), timestamp, nonce, data.install_secret),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...extra,
        },
      });
    },
  };
}

export async function fixture(kit: HttpKit, bound = false) {
  kit.clock.set(INSTANT);
  kit.exchange.mockReset().mockResolvedValue({ unavailable: true });
  const appId = `s_${randomBytes(12).toString('hex')}`;
  const db = kit.suite.db.withSchema('app');
  const device = await client(kit, appId);
  const crypto = kit.app.get<FieldCrypto>(FIELD_CRYPTO);
  const number = phone();
  const uid = await seedUser(db, appId);
  if (bound)
    await db
      .updateTable('users')
      .set({
        phone_hmac: crypto.blindIndex(number, 'users.phone'),
        phone_cipher: Buffer.from(crypto.encrypt(number, 'users.phone'), 'utf8'),
      })
      .where('id', '=', uid)
      .execute();
  const tokens = kit.app.get<TokenService>(TOKEN_SERVICE);
  const keys = kit.app.get<TokenKeyProvider>(TOKEN_KEYS);
  const issue = (user = uid, deviceId = device.deviceId) =>
    db
      .transaction()
      .execute((trx) =>
        createSession(
          trx,
          { uid: user, app_id: appId, device_id: deviceId, scp: 'full' },
          { clock: kit.clock, tokens },
        ),
      );
  const session = await issue();
  const principal = {
    uid,
    app_id: appId,
    sid: session.sid,
    device_id: device.deviceId,
    scp: 'full' as const,
  };
  const post = (
    path: string,
    body: object,
    token = session.access_token,
    extra?: Record<string, string>,
  ) => device.post(path, body, token, extra);
  const bindOauth = async (provider: Schema<'LoginProvider'> = 'wechat') => {
    const unionId = `union-${randomUUID()}`;
    await db
      .insertInto('user_oauth')
      .values({ id: randomUUID(), app_id: appId, user_id: uid, provider, union_id: unionId })
      .execute();
    return unionId;
  };
  const sms = kit.app.get<SmsCodeService>(SMS_CODES);
  const send = async (purpose: 'step_up' | 'login' = 'step_up') => {
    expect(
      await sms.send({
        app_id: appId,
        phone: number,
        purpose,
        action: 'withdraw',
        device_id: device.deviceId,
      }),
    ).toMatchObject({ code: 0 });
    const sent = outbox(kit.app)
      .filter(
        (message) =>
          message.app_id === appId && message.phone === number && message.purpose === purpose,
      )
      .at(-1);
    expect(sent).toBeDefined();
    return sent!.code;
  };
  return {
    kit,
    db,
    appId,
    uid,
    device,
    number,
    crypto,
    keys,
    tokens,
    session,
    principal,
    issue,
    post,
    bindOauth,
    sms,
    send,
    redis: kit.app.get<RedisHandle>(REDIS),
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export function validate(kit: HttpKit, path: string, response: Response): void {
  const status = response.statusCode === 200 ? '200' : response.statusCode >= 500 ? '5XX' : '4XX';
  const schema =
    kit.document.paths[path]!.post.responses[status]!.content['application/json']!.schema;
  const check = createValidatorCompiler()({ schema, httpPart: 'body' });
  expect(check(response.json())).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}
export function accepted<T>(kit: HttpKit, path: string, response: Response): T {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    code: 0,
    msg: expect.any(String),
    trace_id: expect.any(String),
  });
  validate(kit, path, response);
  return response.json<{ data: T }>().data;
}
export function rejected(
  kit: HttpKit,
  path: string,
  response: Response,
  code: number,
  data?: object,
): void {
  const status =
    code === 50001
      ? 500
      : code === 50305
        ? 503
        : code === 10403
          ? 403
          : [10001, 10002, 10401, 10402].includes(code)
            ? 401
            : 400;
  expect(response.statusCode).toBe(status);
  expect(response.json()).toMatchObject({ code, ...(data === undefined ? {} : { data }) });
  validate(kit, path, response);
}
export async function attempt(
  f: Fixture,
  provider: Schema<'LoginProvider'> = 'wechat',
  purpose: Schema<'OauthAttemptPurpose'> = 'step_up',
) {
  return accepted<Schema<'OauthAttemptData'>>(
    f.kit,
    ATTEMPTS,
    await f.post(ATTEMPTS, {
      provider,
      purpose,
      ...(purpose === 'step_up' ? { action: 'account_deletion' } : {}),
    }),
  );
}
export function oauthBody(
  id: string,
  provider: Schema<'LoginProvider'> = 'wechat',
):
  | Schema<'StepUpByWechatRequest'>
  | Schema<'StepUpByAppleRequest'>
  | Schema<'StepUpByHuaweiRequest'> {
  const base = { action: 'account_deletion' as const, provider, attempt_id: id };
  if (provider === 'apple')
    return {
      ...base,
      provider,
      identity_token: 'test-identity-token',
      authorization_code: 'test-authorization-code',
    };
  if (provider === 'huawei')
    return { ...base, provider, authorization_code: 'test-authorization-code' };
  return { ...base, provider, code: 'test-wechat-credential' };
}
export function jwt(
  f: Fixture,
  token: string,
  audience: 'step_up' | 'h5',
  ttl: number,
  expireAt: string,
) {
  const decoded = decode(token);
  expect(decoded.header).toMatchObject({ alg: 'ES256', typ: 'JWT', kid: f.keys.kid });
  expect(
    verify(
      'sha256',
      decoded.input,
      { key: f.keys.publicKeys.get(f.keys.kid)!, dsaEncoding: 'ieee-p1363' },
      decoded.signature,
    ),
  ).toBe(true);
  const now = Math.floor(f.kit.clock.now().getTime() / 1000);
  expect(decoded.payload).toMatchObject({
    aud: audience,
    iss: 'couli-api',
    uid: f.uid,
    app_id: f.appId,
    sid: f.session.sid,
    device_id: f.device.deviceId,
    iat: now,
    exp: now + ttl,
  });
  expect(Date.parse(expireAt)).toBe((now + ttl) * 1000);
  return decoded.payload;
}
