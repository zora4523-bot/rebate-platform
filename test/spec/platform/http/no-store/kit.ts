// B1-01zzq rule-test kit: Cache-Control no-store on responses to requests that carry a verified
// identity (orchestrator ruling D10-396 ③). Two kinds of fixture:
// - `entry(name)`: the real HTTP entry from bootstrap's createHttpApp (no database, no Redis, no
//   listener), with probe routes outside the contract registered after init, before the server
//   is ready. A probe stands in for a route behind the request checks: it puts the verified
//   carrier (`principal` / `adminPrincipal`, exactly what the checks copy onto the request) on the
//   request itself, as test/spec/admin/guard-mount does;
// - `fakeReply()`: a reply with Fastify's case-insensitive header semantics for the onSend step.
import { randomUUID } from 'node:crypto';
import type { AdminPrincipal } from '../../../../../apps/api/src/modules/platform/http/admin-context.ts';
import type { TokenPrincipal } from '../../../../../apps/api/src/modules/platform/http/token-context.ts';
import type { NoStoreReply } from '../../../../../apps/api/src/modules/platform/http/no-store.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
} from '../../../../../apps/api/src/modules/platform/index.ts';

const ROOT = new URL('../../../../../', import.meta.url);

/** What every route under test answers when the routes leave Cache-Control alone. */
export const NO_STORE = 'no-store';
export const TRACE = '01920000-0000-7000-8000-00000000f001';
/** The App headers of the api entry (every request of the probes sends them). */
export const APP_HEADERS = {
  'x-app-id': 'synthetic_no_store',
  'x-platform': 'ios',
  'x-channel': 'appstore',
  'x-app-version': '2.0.0',
  'x-device-id': '01920000-0000-7000-8000-00000000f0d1',
  'x-trace-id': TRACE,
} as const;

/** A stage ② principal as the token check builds it from an App access token. */
export function appPrincipal(scp: TokenPrincipal['scp'] = 'full'): TokenPrincipal {
  return Object.freeze({
    uid: '01920000-0000-7000-8000-00000000f011',
    app_id: 'synthetic_no_store',
    sid: `synthetic-session-${randomUUID()}`,
    device_id: APP_HEADERS['x-device-id'],
    scp,
  });
}

/** The principal the token check builds from an h5_token (its scp is always `full`, B1-02f). */
export function h5Principal(): TokenPrincipal {
  return Object.freeze({ ...appPrincipal('full'), sid: `synthetic-h5-session-${randomUUID()}` });
}

/** A live admin session as the admin token check attaches it. */
export function adminSession(isSuper = false): AdminPrincipal {
  return Object.freeze({
    adminId: 'f42c9e39-248c-4b85-a018-9a578cfaf464',
    appId: 'couli',
    sessionId: randomUUID(),
    isSuper,
  });
}

export interface Response {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
}

interface ProbeRequest {
  principal?: TokenPrincipal;
  adminPrincipal?: AdminPrincipal;
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
    method: 'GET';
    url: string;
    headers: Record<string, string>;
    remoteAddress?: string;
  }): Promise<Response>;
  getHttpAdapter(): { getInstance(): unknown };
}

/** One probe route: who the request is, the Cache-Control the route sets itself (if any). */
export interface Probe {
  readonly path: string;
  readonly identity: 'app' | 'h5' | 'admin' | 'none';
  /** Header name as the route writes it (any letter case) and its value. */
  readonly cacheControl?: readonly [name: string, value: string];
  /** HTTP status the route answers; 200 when omitted. */
  readonly status?: number;
  /** Answer with no body at all (as a 204 does). */
  readonly empty?: boolean;
}

/**
 * The real entry (createHttpApp, then init) with the given probe routes registered. Caller closes
 * `app` (afterEach). The dynamic import keeps Nest's decorators out of the test TS project.
 */
export async function entry(name: 'api' | 'admin', probes: readonly Probe[]) {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: 'api' | 'admin', overrides: object): Promise<HttpApp>;
  };
  const app = await createHttpApp(name, {
    config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
    clock: new FixedClock('2026-10-28T04:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry: name, appEnv: 'test' }),
  });
  try {
    await app.init();
    const server = app.getHttpAdapter().getInstance() as ProbeServer;
    for (const probe of probes) {
      server.get(probe.path, async (request, reply) => {
        if (probe.identity === 'app') request.principal = appPrincipal();
        if (probe.identity === 'h5') request.principal = h5Principal();
        if (probe.identity === 'admin') request.adminPrincipal = adminSession();
        if (probe.cacheControl !== undefined) reply.header(...probe.cacheControl);
        reply.code(probe.status ?? 200);
        return probe.empty === true ? reply.send() : reply.send({ code: 0, msg: '', data: {} });
      });
    }
  } catch (error) {
    await app.close();
    throw error;
  }
  return {
    app,
    get(path: string): Promise<Response> {
      return app.inject({
        method: 'GET',
        url: path,
        headers: { ...APP_HEADERS },
        remoteAddress: '127.0.0.1',
      });
    },
  };
}

/** The Cache-Control of a response (undefined when the response has none). */
export function cacheControl(response: { headers: Record<string, unknown> }): unknown {
  return response.headers['cache-control'];
}

/**
 * A reply with Fastify's header semantics: names are case-insensitive, `header` replaces the
 * value. `headers` is the lower-cased record of what is set; `writes` every header() call.
 */
export function fakeReply(initial: Record<string, string> = {}) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(initial)) headers[name.toLowerCase()] = value;
  const writes: [string, string][] = [];
  const reply: NoStoreReply = {
    hasHeader: (name) => Object.hasOwn(headers, name.toLowerCase()),
    getHeader: (name) => headers[name.toLowerCase()],
    header(name, value) {
      writes.push([name, value]);
      headers[name.toLowerCase()] = value;
      return reply;
    },
  };
  return { reply, headers, writes };
}
