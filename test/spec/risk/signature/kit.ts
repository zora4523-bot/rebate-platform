import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  installRequestChecks,
  type CheckedRequest,
  type RequestCheck,
  type RequestCheckInput,
} from '../../../../apps/api/src/modules/platform/http/request-checks.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import type {
  RedisHandle,
  RedisNamespace,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import {
  createValidatorCompiler,
  routeSchemaOf,
  type ContractOperation,
  type ContractParameter,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  createSignatureCheck,
  type DeviceSigningKey,
} from '../../../../apps/api/src/modules/risk/index.ts';
import { envelopeValidator } from '../../platform/errors/kit.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
export const TRACE = 'b103b000000000000000000000000001';
export const NOW = 1790661600;
export const DEVICE = '019a0000-0000-7000-8000-000000000001';
export const SECRET = 'test-only.signature.device-secret';
export const NONCE = '9f'.repeat(16);
export const SMS = '/v1/auth/sms-codes';
export const BODY = '{"phone":"13800138000","purpose":"login"}';
export const UNSIGNED_HEADERS = {
  'x-device-id': '019a0000-0000-7000-8000-000000000099',
  'x-timestamp': 'malformed-timestamp',
  'x-nonce': 'malformed-nonce',
  'x-sign': 'malformed-signature',
};
export const METHODS = [
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'head',
  'options',
  'trace',
] as const;

export interface Vector {
  note: string;
  method: string;
  path: string;
  body_utf8: string;
  timestamp: string;
  server_time: number;
  nonce: string;
  install_secret: string;
  expected_sign: string;
  expected_signing_string?: string;
  expected_reason?: string;
}
export const vectors = JSON.parse(
  readFileSync(new URL('specs/request-sign.vectors.json', ROOT), 'utf8'),
) as {
  valid_cases: Vector[];
  invalid_cases: Vector[];
};

type PathItem = { parameters?: readonly ContractParameter[] } & Partial<
  Record<(typeof METHODS)[number], ContractOperation>
>;
export interface Document {
  paths: Record<string, PathItem>;
}
export async function contract(): Promise<Document> {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<Document>;
  };
  return parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
}
export function template(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

// Independent client signer; fixtures supply precomputed external expectations.
export function signingString(
  method: string,
  url: string,
  body: Buffer,
  timestamp: string,
  nonce: string,
): string {
  return [method, url, timestamp, nonce, createHash('sha256').update(body).digest('hex')].join(
    '\n',
  );
}
export function sign(
  method: string,
  url: string,
  body: Buffer,
  timestamp: string,
  nonce: string,
  secret = SECRET,
): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(signingString(method, url, body, timestamp, nonce))
    .digest('hex');
}
export function input(options: Partial<RequestCheckInput> = {}): RequestCheckInput {
  const rawBody = options.rawBody ?? Buffer.from(BODY);
  const method = options.method ?? 'POST';
  const url = options.url ?? SMS;
  return {
    id: TRACE,
    method,
    url,
    routeTemplate: SMS,
    rawBody,
    headers: {
      'x-device-id': DEVICE,
      'x-app-id': 'couli',
      'x-timestamp': String(NOW),
      'x-nonce': NONCE,
      'x-sign': sign(method, url, rawBody, String(NOW), NONCE),
      'content-type': 'application/json',
      'x-trace-id': TRACE,
      'x-platform': 'ios',
      'x-app-version': '1.2.3',
    },
    ...options,
  };
}

/** Memory collaborator only: actual Lua/NX/TTL is covered against Redis in *.int.test.ts. */
export function dependencies() {
  const clock = new FixedClock(new Date(NOW * 1000));
  const rows = new Map<string, DeviceSigningKey>([
    [DEVICE, { deviceId: DEVICE, appId: 'couli', installSecret: SECRET }],
  ]);
  const devices = { findActive: vi.fn(async (id: string) => rows.get(id) ?? null) };
  const reserved = new Set<string>();
  // Lua must return SET ... NX EX unchanged: Redis 'OK' / nil maps to 'OK' / null.
  const evalScript = vi.fn(async (_script: string, options: { keys: readonly string[] }) => {
    const key = options.keys.join('|');
    if (reserved.has(key)) return null;
    reserved.add(key);
    return 'OK';
  });
  const ns: RedisNamespace = {
    eval: evalScript,
    get: vi.fn(async () => null),
    set: vi.fn(async () => {
      throw new Error('nonce reservation requires atomic NX');
    }),
  };
  const redis: RedisHandle = {
    namespace: vi.fn(() => ns),
    close: async () => undefined,
    onApplicationShutdown: async () => undefined,
  };
  return { clock, rows, devices, redis, evalScript, reserved };
}

export async function vectorInput(vector: Vector): Promise<RequestCheckInput> {
  const parsed = new URL(vector.path, 'https://api.example.com');
  const url = parsed.pathname + parsed.search;
  const segments = parsed.pathname.split('/');
  const paths = Object.entries((await contract()).paths)
    .filter(([path, item]) => {
      const parts = path.split('/');
      return (
        item[vector.method.toLowerCase() as (typeof METHODS)[number]] !== undefined &&
        parts.length === segments.length &&
        parts.every((part, index) =>
          /^\{[^}]+\}$/.test(part) ? segments[index] !== '' : part === segments[index],
        )
      );
    })
    // Literal paths take precedence over parameter paths, as in Fastify routing.
    .sort(([a], [b]) => (a.match(/\{/g)?.length ?? 0) - (b.match(/\{/g)?.length ?? 0));
  expect(paths.length, '向量路径必须匹配契约操作').toBeGreaterThan(0);
  const routeTemplate = template(paths[0]![0]);
  return input({
    method: vector.method.toUpperCase(),
    url,
    routeTemplate,
    rawBody: Buffer.from(vector.body_utf8, 'utf8'),
    headers: {
      'x-device-id': DEVICE,
      'x-timestamp': vector.timestamp,
      'x-nonce': vector.nonce,
      'x-sign': vector.expected_sign,
    },
  });
}

export interface Response {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json<T = Record<string, unknown>>(): T;
}
// Only the Fastify methods exercised by this fixture. Resolve runtime through the API's
// existing adapter; the spec package neither adds fastify nor imports decorated app files.
interface ProbeRequest extends CheckedRequest {
  body?: unknown;
}
interface ProbeReply {
  header(name: string, value: string): unknown;
}
export interface RequestCheckServer {
  setErrorHandler(
    handler: (error: unknown, request: ProbeRequest, reply: ProbeReply) => void,
  ): void;
  setValidatorCompiler(compiler: ReturnType<typeof createValidatorCompiler>): void;
  addHook(
    name: 'onSend',
    handler: (request: ProbeRequest, reply: ProbeReply, payload: unknown) => Promise<unknown>,
  ): void;
  route(options: {
    method: string;
    url: string;
    schema?: object;
    handler: (request: ProbeRequest) => unknown;
  }): void;
  post(url: string, handler: (request: ProbeRequest) => unknown): void;
  ready(): Promise<unknown>;
  close(): Promise<void>;
  inject(options: {
    method: string;
    url: string;
    headers?: Readonly<Record<string, string | string[] | undefined>>;
    payload?: string | Buffer | Readable | Record<string, unknown>;
  }): Promise<Response>;
}
export async function rejected(
  response: Response,
  code: 10401 | 10402 | 20001 | 50001,
  status = code === 20001 ? 400 : code === 50001 ? 500 : 401,
) {
  expect(response.statusCode).toBe(status);
  const body = response.json();
  const validate = await envelopeValidator();
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(body).toMatchObject({ code, trace_id: TRACE });
  expect(response.headers['x-trace-id']).toBe(TRACE);
  if (code === 10401 || code === 10402) expect(body['data']).toBeUndefined();
  return body;
}

/** Standalone Fastify + production adapter/filter; no production planned route added. */
export async function httpFixture(
  options: {
    deps?: ReturnType<typeof dependencies>;
    checksAfter?: readonly RequestCheck[];
    schema?: boolean;
    bodyLimit?: number;
    withoutRedis?: boolean;
  } = {},
) {
  const deps = options.deps ?? dependencies();
  // Inside each test, never a hook: skeleton throws NotImplemented per case.
  const signature = createSignatureCheck(
    options.withoutRedis === true ? { clock: deps.clock, devices: deps.devices } : deps,
  );
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const errorModule = new URL('apps/api/src/modules/platform/http/global-errors.ts', ROOT).href;
  const { PlatformFastifyAdapter, GlobalErrorFilter } = (await import(errorModule)) as {
    PlatformFastifyAdapter: new (options: object) => { getInstance(): RequestCheckServer };
    GlobalErrorFilter: new (
      adapter: unknown,
      logger: unknown,
    ) => { catch(error: unknown, host: unknown): void };
  };
  const adapter = new PlatformFastifyAdapter({
    loggerInstance: logger,
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
    genReqId: () => TRACE,
  });
  const server = adapter.getInstance();
  try {
    const filter = new GlobalErrorFilter(adapter, logger);
    server.setErrorHandler((error, request, reply) =>
      filter.catch(error, {
        switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
        getArgByIndex: (index: number) => [request, reply][index],
      }),
    );
    server.setValidatorCompiler(createValidatorCompiler());
    server.addHook('onSend', async (_request, reply, payload) => {
      reply.header('x-trace-id', TRACE);
      return payload;
    });
    installRequestChecks(server, [signature, ...(options.checksAfter ?? [])]);
    const document = await contract();
    for (const [path, item] of Object.entries(document.paths)) {
      for (const method of METHODS) {
        const operation = item[method];
        if (operation === undefined) continue;
        server.route({
          method: method.toUpperCase() as 'POST',
          url: template(path),
          ...(options.schema === true && path === SMS
            ? { schema: routeSchemaOf(operation, item.parameters) }
            : {}),
          handler: (request) => ({
            reached: true,
            body: request.body ?? null,
            verifiedDevice: (request as CheckedRequest).verifiedDevice ?? null,
          }),
        });
      }
    }
    await server.ready();
    return { server, deps, lines };
  } catch (error) {
    await server.close();
    throw error;
  }
}

export function inject(server: RequestCheckServer, request: RequestCheckInput = input()) {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(request.headers))
    if (value !== undefined) headers[key] = value;
  return server.inject({
    method: request.method as 'POST',
    url: request.url,
    headers,
    payload: request.rawBody,
  });
}
