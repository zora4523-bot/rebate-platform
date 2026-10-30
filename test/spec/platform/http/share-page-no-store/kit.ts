// B1-15y rule-test kit: every response of the share page routes is Cache-Control: no-store
// (BR-ATTR-10 细则「缓存」; contract NoStoreClientError / NoStoreServerError), including requests
// the route schema or a request check refuses before the controller runs. The B1-01zzq rule for
// requests that carry an identity is unchanged and other anonymous responses stay untouched.
// One fixture: the real api entry from bootstrap's createHttpApp (no database, no Redis, no
// listener), whose SharePageService provider is a stand-in, so a request that reaches the
// controller is seen (and answered as the case says) while one refused earlier never calls it.
// Probe routes outside the contract (registered after init, as test/spec/platform/http/no-store
// does) put the verified carrier on the request themselves.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import { SharePageService } from '../../../../../apps/api/src/modules/linking/application/share-page.ts';
import { LinkingModule } from '../../../../../apps/api/src/modules/linking/index.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
} from '../../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../../apps/api/src/modules/platform/validation/index.ts';
import { appPrincipal } from '../no-store/kit.ts';

const ROOT = new URL('../../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

export const NO_STORE = 'no-store';
export const TRACE = '0199a3b4-5c6d-7000-8000-0000000015f1';
/** A well-formed link id (UUIDv7). */
export const LINK = '0199a3b4-5c6d-7000-8000-0000000015f2';
/** Route templates of the two operations (Fastify `request.routeOptions.url`). */
export const SHARE_PAGE = '/v1/share-pages/:link_id';
export const SHARE_TPWD = '/v1/share-pages/:link_id/tpwd';
/** The contract's bounds: link_id 1..64 characters, ticket 1..256 characters. */
export const LINK_ID_MAX = 64;
export const TICKET_MAX = 256;

/** Headers of a share page request as a system browser sends it (no token, no device, unsigned). */
export const SHARE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-app-id': 'synthetic_share_no_store',
  'x-platform': 'h5',
  'x-app-version': '1.0.0',
  'x-trace-id': TRACE,
  'user-agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
});

export function pageUrl(linkId: string): string {
  return `/v1/share-pages/${encodeURIComponent(linkId)}`;
}

export function tpwdUrl(linkId: string): string {
  return `/v1/share-pages/${encodeURIComponent(linkId)}/tpwd`;
}

export interface Response {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | number | undefined>>;
  readonly payload: string;
  json(): unknown;
}

/** One request. A header set to undefined is left out of the request (also a default one). */
export interface Request {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  /** Raw body bytes as sent; POSTs default to Content-Type application/json. */
  readonly payload?: string;
}

interface ProbeRequest {
  principal?: unknown;
}
interface ProbeReply {
  code(status: number): ProbeReply;
  header(name: string, value: string): ProbeReply;
  send(body?: unknown): ProbeReply;
}
interface ProbeServer {
  get(path: string, handler: (request: ProbeRequest, reply: ProbeReply) => unknown): unknown;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<Response>;
  getHttpAdapter(): { getInstance(): unknown };
}

/** A probe route outside the contract: who the request is, the Cache-Control it sets (if any). */
export interface Probe {
  readonly path: string;
  readonly identity: 'app' | 'none';
  readonly cacheControl?: string;
}

/** What the stand-in SharePageService answers unless a case says otherwise. */
function pageNotFound() {
  return {
    status: 404,
    envelope: { code: 30144, msg: 'synthetic not found', trace_id: TRACE },
  };
}
function tpwdGranted() {
  return {
    status: 200,
    envelope: { code: 0, msg: '', data: { tpwd: '￥SynNoStore01￥' }, trace_id: TRACE },
  };
}

/**
 * The real api entry (createHttpApp, then init) with the stand-in SharePageService and the given
 * probes. The caller closes it with `close()` and restores the mocks (afterEach).
 */
export async function shareEntry(probes: readonly Probe[] = []) {
  const service = {
    get: vi.fn<SharePageService['get']>(async () => pageNotFound()),
    tpwd: vi.fn<SharePageService['tpwd']>(async () => tpwdGranted()),
  };
  const forRoot = LinkingModule.forRoot;
  vi.spyOn(LinkingModule, 'forRoot').mockImplementation((...args) => {
    const module = forRoot(...args);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []).filter((provider) => {
          return typeof provider !== 'object' || provider.provide !== SharePageService;
        }),
        { provide: SharePageService, useValue: service },
      ],
    };
  });
  // The dynamic import keeps Nest's decorators out of the test TS project.
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: 'api', overrides: object): Promise<HttpApp>;
  };
  const app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
    clock: new FixedClock('2026-10-30T02:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  try {
    await app.init();
    const server = app.getHttpAdapter().getInstance() as ProbeServer;
    for (const probe of probes) {
      server.get(probe.path, async (request, reply) => {
        if (probe.identity === 'app') request.principal = appPrincipal();
        if (probe.cacheControl !== undefined) reply.header('Cache-Control', probe.cacheControl);
        return reply.code(200).send({ code: 0, msg: '', data: {}, trace_id: TRACE });
      });
    }
  } catch (error) {
    await app.close();
    throw error;
  }
  return {
    service,
    close: () => app.close(),
    request(request: Request): Promise<Response> {
      const merged: Record<string, string | undefined> = {
        ...SHARE_HEADERS,
        ...(request.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...request.headers,
      };
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(merged)) {
        if (value !== undefined) headers[name] = value;
      }
      return app.inject({
        method: request.method,
        url: request.url,
        headers,
        ...(request.payload === undefined ? {} : { payload: request.payload }),
        remoteAddress: '198.51.100.7',
      });
    },
  };
}

/** The Cache-Control of a response (undefined when it has none). */
export function cacheControl(response: { readonly headers: Readonly<Record<string, unknown>> }) {
  return response.headers['cache-control'];
}

let schemas: Promise<Record<string, JsonSchema>> | undefined;

/** The body passes the named contract schema. */
export async function expectSchema(
  response: Response,
  name: 'ErrorEnvelope' | 'ShareTpwdResponse',
): Promise<void> {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  schemas ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)))
    .then((contract) => contract.components.schemas);
  const schema = (await schemas)[name];
  expect(schema, name).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  const body = response.json();
  expect(check(body), `${name}: ${response.payload}`).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}

/**
 * NoStoreClientError: an HTTP 4xx contract ErrorEnvelope with Cache-Control exactly no-store (one
 * value, not repeated) and the trace id; `status` / `code` pin them when given.
 */
export async function expectNoStoreClientError(
  response: Response,
  what: string,
  expected: { readonly status?: number; readonly code?: number } = {},
): Promise<void> {
  expect(cacheControl(response), what).toBe(NO_STORE);
  expect(response.statusCode, what).toBeGreaterThanOrEqual(400);
  expect(response.statusCode, what).toBeLessThan(500);
  if (expected.status !== undefined) expect(response.statusCode, what).toBe(expected.status);
  if (expected.code !== undefined) {
    expect(response.json(), what).toMatchObject({ code: expected.code });
  }
  expect(response.headers['x-trace-id'], what).toBe(TRACE);
  await expectSchema(response, 'ErrorEnvelope');
}
