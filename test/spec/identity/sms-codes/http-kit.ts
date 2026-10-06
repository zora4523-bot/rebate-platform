import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import type { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type { DbHandles } from '../../../../apps/api/src/modules/platform/db/index.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  smsSenderToken,
  type FakeSmsSender,
} from '../../../../apps/api/src/modules/identity/infra/fake-sms.ts';
import { redisConnection } from './kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
export interface Response {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  json<T>(): T;
}
export interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol): T;
  inject(request: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload: string;
  }): Promise<Response>;
}
type CreateHttpApp = (
  entry: 'api',
  overrides: {
    config: ReturnType<typeof loadConfig>;
    clock: FixedClock;
    logger: RootLogger;
    dbHandles: DbHandles;
    redisUrl: ReturnType<typeof redisConnection>['redisUrl'];
  },
) => Promise<HttpApp>;

export async function buildApp(
  db: Kysely<DB>,
  dir: string,
  redisUrl: string,
  clock: FixedClock,
  logger: RootLogger,
): Promise<HttpApp> {
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  const masterFile = join(dir, 'master.hex');
  const keyringFile = join(dir, 'keyring.json');
  writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
  writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 });
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp: CreateHttpApp;
  };
  return createHttpApp('api', {
    config: loadConfig({
      APP_ENV: 'test',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: masterFile,
      FIELD_KEYRING_FILE: keyringFile,
    }),
    clock,
    logger,
    redisUrl: redisConnection(redisUrl).redisUrl,
    dbHandles: { db, dbRead: null, close: async () => undefined },
  });
}

function signingString(
  method: string,
  path: string,
  body: string,
  timestamp: string,
  nonce: string,
): string {
  return [method, path, timestamp, nonce, createHash('sha256').update(body).digest('hex')].join(
    '\n',
  );
}
function sign(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}
function checkSigner(): void {
  const vectors = JSON.parse(
    readFileSync(new URL('specs/request-sign.vectors.json', ROOT), 'utf8'),
  ) as {
    valid_cases: {
      method: string;
      path: string;
      body_utf8: string;
      timestamp: string;
      nonce: string;
      install_secret: string;
      expected_signing_string: string;
      expected_sign: string;
    }[];
  };
  expect(vectors.valid_cases.length).toBeGreaterThan(0);
  for (const v of vectors.valid_cases) {
    const text = signingString(v.method, v.path, v.body_utf8, v.timestamp, v.nonce);
    expect(text).toBe(v.expected_signing_string);
    expect(sign(v.install_secret, text)).toBe(v.expected_sign);
  }
}
export async function device(app: HttpApp, clock: FixedClock) {
  checkSigner();
  const headers = {
    'content-type': 'application/json',
    'x-app-id': 'couli',
    'x-platform': 'ios',
    'x-app-version': '1.2.3',
  };
  const response = await app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({
      device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      id_source: 'idfv',
    }),
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{
    code: number;
    data: { device_id: string; install_secret: string };
  }>();
  expect(body.code).toBe(0);
  expect(body.data).toMatchObject({
    device_id: expect.any(String),
    install_secret: expect.any(String),
  });
  return (payload: Record<string, unknown>) => {
    const raw = JSON.stringify(payload);
    const timestamp = String(Math.floor(clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const path = '/v1/auth/sms-codes';
    return app.inject({
      method: 'POST',
      url: path,
      payload: raw,
      headers: {
        ...headers,
        'x-device-id': body.data.device_id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': sign(
          body.data.install_secret,
          signingString('POST', path, raw, timestamp, nonce),
        ),
      },
    });
  };
}
export function outbox(app: HttpApp) {
  return app.get<FakeSmsSender>(smsSenderToken()).outbox();
}

export async function responseValidator() {
  const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{
      paths: Record<
        string,
        { post: { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> } }
      >;
    }>;
  };
  const document = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)));
  const schema =
    document.paths['/v1/auth/sms-codes']!.post.responses['200']!.content['application/json']!
      .schema;
  const errorSchema =
    document.paths['/v1/auth/sms-codes']!.post.responses['4XX']!.content['application/json']!
      .schema;
  const compile = createValidatorCompiler();
  return {
    validate: compile({ schema, httpPart: 'body' }),
    validateError: compile({ schema: errorSchema, httpPart: 'body' }),
  };
}

export async function validateErrorResponse(response: Response): Promise<void> {
  const { validateError } = await responseValidator();
  expect(validateError(response.json())).toBe(true);
  expect(validateError.errors ?? []).toEqual([]);
}
