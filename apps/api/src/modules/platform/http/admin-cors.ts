// CORS of the admin entry (F1-06k; 02 §3.4: the admin API opens CORS to the console's exact origin
// only; contract adminBearerAuth: Authorization header, never a cookie, so no credentials mode).
//
// installAdminCors(server, policy) adds one `onRequest` hook (it also runs for unmatched routes,
// so a preflight needs no OPTIONS route) for paths under /admin/v1/:
// - every response carries `Vary: Origin`;
// - when the request's Origin equals the configured origin exactly (no wildcard, no suffix match,
//   never `null`), the response carries Access-Control-Allow-Origin with that origin and exposes
//   X-Trace-Id;
// - a preflight (OPTIONS with Access-Control-Request-Method) from that origin and from a client
//   address the whitelist allows is answered here with 204, the methods and the request headers
//   the console sends (Authorization, Content-Type, X-Trace-Id, X-Step-Up-Token);
// - any other origin gets no CORS header, and its preflight falls through to the 404 handler.
// No origin configured (policy.corsOrigin null): nothing is installed.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no `process.env`, no logging. Fastify is reached through
// the structural types below.

export interface AdminCorsPolicy {
  readonly corsOrigin: string | null;
  readonly allows: (ip: string | undefined) => boolean;
}

interface CorsRequest {
  readonly method: string;
  readonly url: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

interface CorsReply {
  header(name: string, value: string): unknown;
  code(status: number): CorsReply;
  send(payload?: unknown): unknown;
}

interface CorsServer {
  addHook(
    name: 'onRequest',
    hook: (request: CorsRequest, reply: CorsReply) => Promise<unknown>,
  ): unknown;
}

const ADMIN_PREFIX = '/admin/v1/';
const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE';
const ALLOW_HEADERS = 'Authorization, Content-Type, X-Trace-Id, X-Step-Up-Token';
const MAX_AGE_SEC = '600';

export function installAdminCors(server: object, policy: AdminCorsPolicy): void {
  const candidate = server as Partial<Record<keyof CorsServer, unknown>>;
  if (typeof candidate.addHook !== 'function') {
    throw new TypeError('installAdminCors needs a Fastify instance');
  }
  const origin = policy.corsOrigin;
  if (origin === null) return;
  (server as CorsServer).addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith(ADMIN_PREFIX)) return undefined;
    reply.header('Vary', 'Origin');
    if (request.headers['origin'] !== origin) return undefined;
    const preflight =
      request.method === 'OPTIONS' &&
      typeof request.headers['access-control-request-method'] === 'string';
    if (!preflight) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Expose-Headers', 'X-Trace-Id');
      return undefined;
    }
    if (!policy.allows(request.ip)) return undefined;
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Methods', ALLOW_METHODS);
    reply.header('Access-Control-Allow-Headers', ALLOW_HEADERS);
    reply.header('Access-Control-Max-Age', MAX_AGE_SEC);
    reply.code(204).send();
    return reply;
  });
}
