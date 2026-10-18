import { randomBytes, randomUUID, randomInt, createHash, createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';

export const ROOT = new URL('../../../../', import.meta.url);
export const PATH = '/v1/landing/sms-codes';
export const NOW = '2026-10-18T10:00:00+08:00';
export const IP = '203.0.113.71';
export const TRACE = 'abcdefABCDEF01234567abcdefABCDEF';
type ClockModule = typeof import('../../../../apps/api/src/modules/platform/clock/index.ts');
type ConfigModule = typeof import('../../../../apps/api/src/modules/platform/config/index.ts');
type CryptoModule = typeof import('../../../../apps/api/src/modules/platform/crypto/index.ts');
type LoggerModule = typeof import('../../../../apps/api/src/modules/platform/logging/logger.ts');
type DbModule = typeof import('../../../../apps/api/src/modules/platform/db/index.ts');
type ValidatorModule =
  typeof import('../../../../apps/api/src/modules/platform/validation/index.ts');
type SmsModule =
  typeof import('../../../../apps/api/src/modules/identity/application/sms-codes.ts');
type SenderModule = typeof import('../../../../apps/api/src/modules/identity/infra/fake-sms.ts');
type RiskModule = typeof import('../../../../apps/api/src/modules/risk/application/sms-risk.ts');

// URL imports keep Nest's decorated graph out of the erasable-only spec compilation.
export async function api<T>(path: string): Promise<T> {
  return (await import(new URL(`apps/api/src/${path}`, ROOT).href)) as T;
}
export interface Response {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  json<T = Record<string, unknown>>(): T;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol): T;
  inject(input: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload: string;
    remoteAddress: string;
  }): Promise<Response>;
}
type Bootstrap = {
  createHttpApp(
    entry: 'api',
    options: {
      config: ReturnType<ConfigModule['loadConfig']>;
      clock: InstanceType<ClockModule['FixedClock']>;
      logger: ReturnType<LoggerModule['createRootLogger']>;
      redisUrl: ReturnType<DbModule['loadConnectionConfig']>['redisUrl'];
      dbHandles: { db: Kysely<DB>; dbRead: null; close(): Promise<void> };
    },
  ): Promise<HttpApp>;
};
export type Operation = {
  operationId: string;
  'x-implementation'?: string;
  'x-auth': string;
  'x-signed': boolean;
  'x-min-version-gate': boolean;
  security: unknown[];
  parameters: { name: string; required?: boolean }[];
  requestBody: { content: Record<string, { schema: Record<string, unknown> }> };
  responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
};
export async function contract() {
  const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{ paths: Record<string, { post: Operation }> }>;
  };
  return parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
}

export async function openKit(db: Kysely<DB>, databaseUrl: string, redisUrl: string) {
  const { FixedClock } = await api<ClockModule>('modules/platform/clock/index.ts');
  const { loadConfig } = await api<ConfigModule>('modules/platform/config/index.ts');
  const { createWrappedKeyring, LocalKeyProvider } = await api<CryptoModule>(
    'modules/platform/crypto/index.ts',
  );
  const { createRootLogger } = await api<LoggerModule>('modules/platform/logging/logger.ts');
  const { loadConnectionConfig } = await api<DbModule>('modules/platform/db/index.ts');
  const { createValidatorCompiler } = await api<ValidatorModule>(
    'modules/platform/validation/index.ts',
  );
  const { createHttpApp } = await api<Bootstrap>('bootstrap.ts');
  const { smsSenderToken } = await api<SenderModule>('modules/identity/infra/fake-sms.ts');
  const { SMS_CODES, IDENTITY_CONFIG } = await api<{ SMS_CODES: symbol; IDENTITY_CONFIG: symbol }>(
    'modules/identity/application/tokens.ts',
  );
  const { FIELD_CRYPTO, REDIS } = await api<{ FIELD_CRYPTO: symbol; REDIS: symbol }>(
    'modules/platform/index.ts',
  );
  const { createSmsRisk } = await api<RiskModule>('modules/risk/index.ts');
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-11g-'));
  let app: HttpApp | undefined;
  try {
    const master = randomBytes(32);
    const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
    const masterFile = join(dir, 'master.hex');
    const keyringFile = join(dir, 'keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 });
    const lines: string[] = [];
    const logger = createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      {
        write: (line: string) => void lines.push(line),
      },
    );
    const clock = new FixedClock(NOW);
    app = await createHttpApp('api', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: masterFile,
        FIELD_KEYRING_FILE: keyringFile,
      }),
      clock,
      logger,
      redisUrl: loadConnectionConfig('api', { DATABASE_URL: databaseUrl, REDIS_URL: redisUrl })
        .redisUrl,
      dbHandles: { db, dbRead: null, close: async () => undefined },
    });
    await app.init();
    const crypto = app.get<Parameters<RiskModule['createSmsRisk']>[0]['crypto']>(FIELD_CRYPTO);
    const risk = createSmsRisk({
      clock,
      logger,
      crypto,
      redis: app.get(REDIS),
      config: app.get(IDENTITY_CONFIG),
    });
    return {
      app,
      db: db.withSchema('app'),
      clock,
      crypto,
      risk,
      lines,
      sender: app.get<ReturnType<SenderModule['createFakeSmsSender']>>(smsSenderToken()),
      codes: app.get<ReturnType<SmsModule['createSmsCodeService']>>(SMS_CODES),
      document: await contract(),
      compile: createValidatorCompiler(),
      async close() {
        try {
          await app!.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
export type Kit = Awaited<ReturnType<typeof openKit>>;
let sequence = randomInt(10_000_000, 90_000_000);
export function phone(prefix = '139'): string {
  return prefix + String(++sequence).padStart(11 - prefix.length, '0');
}
export function fixture(kit: Kit) {
  kit.clock.set(NOW);
  const appId = `ls_${randomBytes(10).toString('hex')}`;
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'h5',
    'x-app-version': '0.0.1',
    'x-trace-id': TRACE,
  };
  return {
    appId,
    headers,
    send(
      number: string,
      options: {
        body?: Record<string, unknown>;
        headers?: Record<string, string>;
        ip?: string;
      } = {},
    ) {
      return kit.app.inject({
        method: 'POST',
        url: PATH,
        remoteAddress: options.ip ?? IP,
        headers: { ...headers, ...options.headers },
        payload: JSON.stringify({ phone: number, ...options.body }),
      });
    },
    messages: () => kit.sender.outbox().filter((message) => message.app_id === appId),
    verify(number: string, code: string, purpose: 'login' | 'bind' | 'step_up' = 'login') {
      return kit.codes.verifyAndConsume({ app_id: appId, phone: number, code, purpose });
    },
    async config(key: string, value: unknown) {
      await kit.db
        .insertInto('config_items')
        .values({ app_id: appId, key, value: JSON.stringify(value), updated_by: 'b1-11g' })
        .execute();
    },
    async blocked(number: string) {
      await kit.db
        .insertInto('blocklist')
        .values({
          id: randomUUID(),
          app_id: appId,
          dimension: 'phone',
          value_hmac: kit.crypto.blindIndex(number, 'users.phone'),
          violation_type: 'other',
          status: 'active',
          created_by: 'b1-11g',
          expire_at: new Date(kit.clock.now().getTime() + 86_400_000),
        })
        .execute();
    },
    async registrations(instants: string[], ip = IP) {
      for (const instant of instants) {
        kit.clock.set(instant);
        await kit.risk.recordRegistered({ appId, clientIp: ip, userId: randomUUID() });
      }
    },
    async accepted(instants: string[], ip = IP) {
      for (const instant of instants) {
        kit.clock.set(instant);
        await kit.risk.recordAccepted({ appId, clientIp: ip });
      }
    },
    async appSender() {
      const created = await kit.app.inject({
        method: 'POST',
        url: '/v1/devices',
        remoteAddress: IP,
        headers: { ...headers, 'x-platform': 'ios', 'x-app-version': '2.0.0' },
        payload: JSON.stringify({
          device_hash: randomBytes(32).toString('hex'),
          id_source: 'idfv',
        }),
      });
      expect(created.statusCode).toBe(200);
      const { device_id, install_secret } = created.json<{
        data: { device_id: string; install_secret: string };
      }>().data;
      return (number: string, purpose: 'login' | 'bind' | 'step_up' = 'login') => {
        const path = '/v1/auth/sms-codes';
        const payload = JSON.stringify({ phone: number, purpose });
        const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
        const nonce = randomBytes(16).toString('hex');
        const text = [
          'POST',
          path,
          timestamp,
          nonce,
          createHash('sha256').update(payload).digest('hex'),
        ].join('\n');
        return kit.app.inject({
          method: 'POST',
          url: path,
          remoteAddress: IP,
          payload,
          headers: {
            ...headers,
            'x-platform': 'ios',
            'x-app-version': '2.0.0',
            'x-device-id': device_id,
            'x-timestamp': timestamp,
            'x-nonce': nonce,
            'x-sign': createHmac('sha256', install_secret).update(text).digest('hex'),
          },
        });
      };
    },
  };
}
export function envelope(
  kit: Kit,
  response: Response,
  code = 0,
  retryAfter?: number,
  resendAfterSec = 60,
): void {
  const status =
    code === 0 ? 200 : code === 20001 ? 400 : code === 44001 ? 403 : code === 42901 ? 429 : 500;
  expect(response.statusCode).toBe(status);
  const body = response.json();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: TRACE });
  expect(response.headers['x-trace-id']).toBe(TRACE);
  const key = status === 200 ? '200' : status === 429 ? '429' : status < 500 ? '4XX' : '5XX';
  const schema = kit.document.paths[PATH]!.post.responses[key]!.content['application/json']!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  if (code === 0) {
    expect(body['data']).toEqual({ resend_after_sec: resendAfterSec, expires_in_sec: 300 });
    expect(response.headers['set-cookie']).toBeUndefined();
  }
  if (retryAfter !== undefined)
    expect(String(response.headers['retry-after'])).toBe(String(retryAfter));
}
