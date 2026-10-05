import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DynamicModule } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { dereference } from '@readme/openapi-parser';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import type { OpenAPIV3_1 } from 'openapi-types';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { AppModule } from '../../../../app.module.ts';
import { createHttpApp } from '../../../../bootstrap.ts';
import {
  DB,
  FIELD_CRYPTO,
  FixedClock,
  contractRouteSchema,
  createRootLogger,
  loadConfig,
  type FieldCrypto,
} from '../../../platform/index.ts';

const CONTRACT = fileURLToPath(
  new URL('../../../../../../../contracts/openapi.yaml', import.meta.url),
);
const TRACE = 'abcdefABCDEF01234567abcdefABCDEF';
const hash = createHash('sha256').update('3f2504e0-4f89-11d3-9a0c-0305e82c3301').digest('hex');
// First seed of specs/device-hash.vectors.json: SHA-256 of the empty string.
const emptyHash = createHash('sha256').update('').digest('hex');
const headers = { 'x-app-id': 'couli', 'x-platform': 'harmony', 'x-app-version': '3.1.0' };

type Validate = ((data: unknown) => boolean) & { errors?: unknown[] | null };
let validateSuccess: Validate;
let validateError: Validate;

beforeAll(async () => {
  const document = await dereference<OpenAPIV3_1.Document>(CONTRACT, {
    resolve: { external: false },
  });
  const responses = document.paths?.['/v1/devices']?.post?.responses ?? {};
  const schemaOf = (status: string) =>
    (responses[status] as OpenAPIV3_1.ResponseObject | undefined)?.content?.['application/json']
      ?.schema as object;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajvFormats.default(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) =>
      Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  validateSuccess = ajv.compile(schemaOf('200'));
  validateError = ajv.compile(schemaOf('4XX'));
});

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

/** Records the one statement of the repository: insertInto(table).values(row).execute(). */
function fakeDb() {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const db = {
    insertInto: (table: string) => ({
      values: (row: Record<string, unknown>) => ({
        execute: async () => {
          inserts.push({ table, row });
          return [];
        },
      }),
    }),
  };
  return { db, inserts };
}

function fakeCrypto(): FieldCrypto {
  const unused = (): never => {
    throw new Error('not used by device registration');
  };
  return {
    currentKeyVersion: 1,
    encrypt: (plaintext, context) =>
      `v1.1.${createHash('sha256').update(`${context}\0${plaintext}`).digest('base64url')}`,
    decrypt: unused,
    keyVersionOf: unused,
    needsReencrypt: unused,
    reencrypt: unused,
    blindIndex: unused,
  };
}

/**
 * The api entry as bootstrap builds it. With `infra`, a global test module supplies the DB and
 * FIELD_CRYPTO tokens that PlatformModule leaves out when it has no handles and no keyring.
 */
async function build(infra?: { db: unknown; crypto: FieldCrypto }) {
  const lines: string[] = [];
  if (infra !== undefined) {
    const original = AppModule.forEntry;
    vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
      const root = original(options);
      const fakes: DynamicModule = {
        module: class FakeInfraModule {},
        global: true,
        providers: [
          { provide: DB, useValue: infra.db },
          { provide: FIELD_CRYPTO, useValue: infra.crypto },
        ],
        exports: [DB, FIELD_CRYPTO],
      };
      return { ...root, imports: [...(root.imports ?? []), fakes] };
    });
  }
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-05T04:00:00.000Z'),
    logger: createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      { write: (chunk: string) => void lines.push(chunk) },
    ),
  });
  const schemas: unknown[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if (route.url === '/v1/devices') schemas.push({ method: route.method, schema: route.schema });
    });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, lines, schemas };
}

function register(target: NestFastifyApplication, payload: unknown, extra = {}) {
  return target.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: { ...headers, 'x-trace-id': TRACE, ...extra },
    payload: payload as Record<string, unknown>,
  });
}

it('[AC-B1-02c#1] mounts the contract route schema that the platform module exports', async () => {
  const { schemas } = await build();
  expect(schemas).toEqual([{ method: 'POST', schema: contractRouteSchema('registerDevice') }]);
});

it('[AC-B1-02c#1][AC-B1-02c#2] registers without a token or signature and answers the contract envelope', async () => {
  const { db, inserts } = fakeDb();
  const { app } = await build({ db, crypto: fakeCrypto() });
  const response = await register(app, { device_hash: hash, id_source: 'odid' });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ data: { device_id: string; install_secret: string } }>();
  expect(validateSuccess(body), JSON.stringify(validateSuccess.errors)).toBe(true);
  expect(body).toMatchObject({ code: 0, msg: '', trace_id: TRACE });
  expect(body.data.device_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(inserts).toHaveLength(1);
  expect(inserts[0]!.row).toMatchObject({
    id: body.data.device_id,
    app_id: 'couli',
    platform: 'harmony',
    app_version: '3.1.0',
    device_hash: hash,
    id_source: 'odid',
    user_id: null,
    revoked_at: null,
  });
});

it('[AC-B1-02c#4][AC-B1-02c#5][AC-B1-02c#6] answers 20001 with the contract error envelope and stores nothing', async () => {
  const { db, inserts } = fakeDb();
  const { app } = await build({ db, crypto: fakeCrypto() });
  const cases: [unknown, Record<string, string>, string[]][] = [
    [{ device_hash: emptyHash, id_source: 'idfv' }, {}, ['device_hash']],
    [{ device_hash: hash.toUpperCase(), id_source: 'idfv' }, {}, ['device_hash']],
    [{ device_hash: '', id_source: 'idfv' }, {}, ['device_hash']],
    [{ device_hash: hash }, {}, ['id_source']],
    [{ device_hash: hash, id_source: 'IDFV' }, {}, ['id_source']],
    [{ device_hash: hash, id_source: 'idfv' }, { 'x-app-version': '3.1' }, ['x-app-version']],
  ];
  for (const [payload, extra, fields] of cases) {
    const response = await register(app, payload, extra);
    expect(response.statusCode).toBe(400);
    const body = response.json<unknown>();
    expect(validateError(body), JSON.stringify(validateError.errors)).toBe(true);
    expect(body).toEqual({ code: 20001, msg: '参数校验失败', data: { fields }, trace_id: TRACE });
  }
  expect(inserts).toEqual([]);
});

it('[AC-B1-02c#9] writes request logs that never carry the issued install_secret', async () => {
  const { app, lines } = await build({ db: fakeDb().db, crypto: fakeCrypto() });
  const start = lines.length;
  const response = await register(app, { device_hash: hash, id_source: 'odid' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const secret = response.json<{ data: { install_secret: string } }>().data.install_secret;
  expect(lines.length).toBeGreaterThan(start);
  const logs = lines.join('');
  for (const form of [
    secret,
    Buffer.from(secret).toString('hex'),
    Buffer.from(secret, 'base64url').toString('hex'),
    Buffer.from(secret, 'base64url').toString('base64'),
  ]) {
    expect(logs).not.toContain(form);
  }
});

it('still serves the route without database handles or keyring: invalid hashes 20001, others 500', async () => {
  const { app } = await build();
  const invalid = await register(app, { device_hash: emptyHash, id_source: 'idfv' });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toEqual({
    code: 20001,
    msg: '参数校验失败',
    data: { fields: ['device_hash'] },
    trace_id: TRACE,
  });
  const valid = await register(app, { device_hash: hash, id_source: 'idfv' });
  expect(valid.statusCode).toBe(500);
  expect(valid.body).not.toContain('install_secret');
});
