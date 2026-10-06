// The registration point for request checks that must run before Fastify parses or validates a
// request body (规划/08 BR-ID-01: ① request signature 10401/10402 → ② token 10001/10002 → ③ app
// source and token scope 10403, all before ⑮ body validation; BR-ID-09). Fastify validates the
// route schema before any Nest guard runs, so a guard would answer a malformed signature header
// with 20001 instead of 10401: the checks run in Fastify's `preParsing` hook instead.
//
// installRequestChecks(server, checks, bufferWhen?) — call once per Fastify instance, before
// `ready()` (bootstrap calls it right after NestFactory.create, with the RequestCheckPlan the app
// module provides under REQUEST_CHECKS). For every request that matched a route (never for a 404):
//   1. when `bufferWhen(method, route template)` selects the route (every matched route when it is
//      omitted), buffer the raw body, bounded by the route's effective bodyLimit: a declared
//      Content-Length above it, or more bytes than it, rejects with Fastify's own 413 body error
//      (the global filter answers 413 / 20001, fields=[body]) before any check runs, whatever the
//      signature. A route it does not select is not read here at all: its checks see an empty
//      `rawBody`, and Fastify's own parser reads (and limits) the body after the checks passed;
//   2. run the checks in the given order on one RequestCheckInput, whose `url` is the origin-form
//      request target (an absolute-form target loses its scheme and authority, see
//      originFormTarget); the first check that throws ends the request with its error (the
//      remaining checks are not called, the body of an unbuffered route is never read);
//   3. copy `verifiedDevice` (set by stage ①) and `principal` (set by stage ②, read it with
//      tokenPrincipal of ./token-context.ts) onto the Fastify request for the handler and later
//      stages, and hand a buffered body's identical bytes to Fastify's content-type parser.
// So `bufferWhen` decides only which bodies are read before the checks (orchestrator ruling
// B1-02h §9.5 #10): a check that needs the body (the signature of BR-ID-09) must act only on
// buffered routes — bootstrap refuses a contract x-signed route the plan does not buffer — while
// header-only checks (the token stages ② ③) cover every matched route.
// A check rejects a request with a contract code by throwing a RequestRejection (the global error
// filter writes `{ code, msg, trace_id }` with its HTTP status); any other error is a 50001.
//
// refuseRoutes(server, refused, reason) keeps an entry from registering a route its checks do not
// cover (bootstrap: a contract x-signed route on an entry without the signature check).
//
// This file is also compiled by the `test` project: erasable syntax only (no parameter properties,
// enums, namespaces or decorators), `import type` for type-only imports, relative imports with the
// `.ts` extension, no NestJS, no `process.env`, no logging. Fastify is reached through the
// structural types below: it is not a direct dependency of @couli/api.
import { PassThrough, type Readable } from 'node:stream';
import type { TokenPrincipal } from './token-context.ts';

/** Verified by stage ①, before parsers, schema validation and later authentication stages. */
export interface VerifiedDevice {
  readonly deviceId: string;
  readonly appId: string;
}

export interface RequestCheckInput {
  /** The request id, which is the trace id (bootstrap's genReqId). */
  readonly id: string;
  readonly method: string;
  /**
   * The origin-form request target: path plus the query string exactly as sent (not decoded, not
   * reordered). An absolute-form target (`https://host/path?query`) arrives without its scheme and
   * authority (originFormTarget), so it reads like the origin-form target of the matched route.
   */
  readonly url: string;
  /** Fastify's matched route template; absent for an unmatched route. */
  readonly routeTemplate?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The buffered body; empty (nothing was read) on a route the plan's bufferWhen does not select. */
  readonly rawBody: Buffer;
  verifiedDevice?: VerifiedDevice;
  /** Set by stage ② (identity's token check) after the token and its session were verified. */
  principal?: TokenPrincipal;
}

export type RequestCheck = (request: RequestCheckInput) => Promise<void>;

/** What a handler or a later stage reads from the Fastify request (principal: tokenPrincipal). */
export interface CheckedRequest {
  verifiedDevice?: VerifiedDevice;
  principal?: TokenPrincipal;
}

/** Selects matched routes by request method and Fastify route template (e.g. `/v1/links/:link_id/open`). */
export type RouteFilter = (method: string, routeTemplate: string) => boolean;

/** What an HTTP entry installs at the registration point (app.module provides it, bootstrap installs it). */
export interface RequestCheckPlan {
  /** Run in this order on every matched route (BR-ID-01: ① signature first, then ② ③). */
  readonly checks: readonly RequestCheck[];
  /** The matched routes whose body is buffered before the checks; omitted = every matched route. */
  readonly bufferWhen?: RouteFilter;
}

/** Nest token of the entry's RequestCheckPlan that bootstrap installs (app.module). */
export const REQUEST_CHECKS = Symbol('REQUEST_CHECKS');

/**
 * A request refused with a contract business code (contracts/error-codes.yaml). The global error
 * filter answers it with `statusCode` and the ErrorEnvelope { code, msg: message, trace_id } and
 * no `data`; a status outside 400–499 or a code outside 10000–99999 is answered as 50001. The
 * message is a fixed fallback text: never put a submitted value, a key or a signature in it.
 */
export class RequestRejection extends Error {
  readonly code: number;
  readonly statusCode: number;

  constructor(code: number, statusCode: number, message: string) {
    super(message);
    this.name = 'RequestRejection';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * The error Fastify's body reader raises for a body above the limit (FST_ERR_CTP_BODY_TOO_LARGE:
 * a RangeError named FastifyError, 413, same message). Raised here where Fastify would raise it, so
 * that PlatformFastifyAdapter and GlobalErrorFilter treat both alike (413 / 20001, fields=[body]).
 */
class RequestBodyTooLargeError extends RangeError {
  readonly code = 'FST_ERR_CTP_BODY_TOO_LARGE';
  readonly statusCode = 413;

  constructor() {
    super('Request body is too large');
    this.name = 'FastifyError';
  }
}

/** A payload stream; a decoding preParsing hook may report the encoded bytes it consumed. */
type PayloadStream = Readable & { receivedEncodedLength?: number };

/** The parts of a Fastify request this hook reads or writes. */
interface HookRequest extends CheckedRequest {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly raw: { readonly url?: string | undefined };
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly routeOptions: { readonly url?: string | undefined; readonly bodyLimit: number };
}

/** The parts of a Fastify instance this module uses. */
interface HookServer {
  addHook(
    name: 'preParsing',
    hook: (request: HookRequest, reply: unknown, payload: PayloadStream) => Promise<unknown>,
  ): unknown;
  decorateRequest(name: 'verifiedDevice' | 'principal', value: undefined): unknown;
  hasRequestDecorator(name: string): boolean;
}

function isHookServer(server: object): server is HookServer {
  const candidate = server as Partial<Record<keyof HookServer, unknown>>;
  return (
    typeof candidate.addHook === 'function' &&
    typeof candidate.decorateRequest === 'function' &&
    typeof candidate.hasRequestDecorator === 'function'
  );
}

/** The route options Fastify hands an `onRoute` hook that refuseRoutes reads. */
interface RouteRegistration {
  readonly method: string | readonly string[];
  readonly url: string;
}

interface RouteHookServer {
  addHook(name: 'onRoute', hook: (route: RouteRegistration) => void): unknown;
}

/**
 * The origin-form of a request target (RFC 9112 §3.2). A client may send the absolute-form
 * (`http(s)://authority/path?query`), which Fastify's router matches by its path (find-my-way
 * getPathFromAbsoluteUrl) while `request.raw.url` keeps the whole target. The scheme and authority
 * are dropped (no path → `/`); the path and query keep every byte (not decoded, not reordered).
 * Any other target is returned unchanged. That includes targets the router still matches: an
 * asterisk-form-like `*v1/auth/sms-codes` reaches the route `/v1/auth/sms-codes` (find-my-way does
 * not compare the first character of the path with the root `/`), and it stays `*v1/...` here, so
 * the signing string carries the target exactly as sent: a client that signed `/v1/...` is
 * refused with 10401 (fail closed), and the token stages still run on the matched route.
 */
export function originFormTarget(target: string): string {
  if (target.startsWith('/')) return target;
  const absolute = /^https?:\/\/[^/?#]*/i.exec(target);
  if (absolute === null) return target;
  const rest = target.slice(absolute[0].length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/**
 * Register before init/ready. Run checks in supplied order on every matched route before body
 * parsing; stop on error. Only matched routes that `bufferWhen` selects (all matched routes
 * without it) have their raw body buffered first, bounded by the effective Fastify bodyLimit, and
 * replayed as identical bytes to the parser; the others are checked on their headers with an
 * empty rawBody and keep Fastify's own body handling. Copy verifiedDevice and principal onto the
 * request for subsequent authentication stages. Overflow of a buffered body uses the existing
 * 413/20001 body-error envelope, even for an invalid signature.
 */
export function installRequestChecks(
  server: object,
  checks: readonly RequestCheck[],
  bufferWhen?: RouteFilter,
): void {
  if (!isHookServer(server)) throw new TypeError('installRequestChecks needs a Fastify instance');
  const ordered = [...checks];
  if (ordered.some((check) => typeof check !== 'function')) {
    throw new TypeError('every request check must be a function');
  }
  if (bufferWhen !== undefined && typeof bufferWhen !== 'function') {
    throw new TypeError('bufferWhen must be a function');
  }
  // One registration per server keeps the order of the stages in one list.
  if (server.hasRequestDecorator('verifiedDevice')) {
    throw new Error('request checks are already installed on this server');
  }
  server.decorateRequest('verifiedDevice', undefined);
  server.decorateRequest('principal', undefined);
  if (ordered.length === 0) return;
  server.addHook('preParsing', async (request, _reply, payload) => {
    const routeTemplate = request.routeOptions.url;
    // An unmatched route answers 404 untouched: nothing to check, nothing to buffer.
    if (routeTemplate === undefined) return undefined;
    // A route the plan does not buffer is checked on its headers; Fastify reads its body later.
    const buffered = bufferWhen === undefined || bufferWhen(request.method, routeTemplate);
    const rawBody = buffered
      ? await readRawBody(
          payload,
          request.routeOptions.bodyLimit,
          Number(request.headers['content-length']),
        )
      : Buffer.alloc(0);
    const input: RequestCheckInput = {
      id: request.id,
      method: request.method,
      url: originFormTarget(request.raw.url ?? request.url),
      routeTemplate,
      headers: request.headers,
      rawBody,
    };
    for (const check of ordered) await check(input);
    if (input.verifiedDevice !== undefined) request.verifiedDevice = input.verifiedDevice;
    if (input.principal !== undefined) request.principal = input.principal;
    return buffered ? replay(rawBody, payload) : undefined;
  });
}

/**
 * Refuses to register a route that `refused` matches (any of its methods): a Fastify `onRoute`
 * hook throws while the route is added, so the registration fails (Nest registers its routes in
 * init, which then rejects) and the entry does not start. Call before any route is registered.
 * The error message is `${reason}: ${METHOD} ${url}`.
 */
export function refuseRoutes(server: object, refused: RouteFilter, reason: string): void {
  const candidate = server as Partial<Record<keyof RouteHookServer, unknown>>;
  if (typeof candidate.addHook !== 'function') {
    throw new TypeError('refuseRoutes needs a Fastify instance');
  }
  if (typeof refused !== 'function') throw new TypeError('refused must be a function');
  (server as RouteHookServer).addHook('onRoute', (route) => {
    const methods = typeof route.method === 'string' ? [route.method] : route.method;
    for (const method of methods) {
      if (refused(method, route.url)) {
        throw new Error(`${reason}: ${method.toUpperCase()} ${route.url}`);
      }
    }
  });
}

/** Reads the whole payload, refusing more than `limit` bytes as Fastify's body reader does. */
function readRawBody(payload: PayloadStream, limit: number, declared: number): Promise<Buffer> {
  if (declared > limit) return Promise.reject(new RequestBodyTooLargeError());
  if (payload.readableEnded || payload.destroyed) {
    return Promise.reject(new Error('request body stream was consumed before the request checks'));
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const stopListening = (): void => {
      payload.removeListener('data', onData);
      payload.removeListener('end', onEnd);
      payload.removeListener('error', onError);
      payload.removeListener('close', onClose);
    };
    const fail = (error: unknown): void => {
      stopListening();
      reject(error instanceof Error ? error : new Error('request body stream failed'));
    };
    function onData(chunk: Buffer | string): void {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      received += bytes.length;
      // Like Fastify: stop listening and leave the rest unread; the reply ends the request.
      if (received > limit || (payload.receivedEncodedLength ?? 0) > limit) {
        fail(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(bytes);
    }
    function onEnd(): void {
      stopListening();
      resolve(Buffer.concat(chunks, received));
    }
    function onError(error: unknown): void {
      fail(error);
    }
    function onClose(): void {
      fail(new Error('request body stream closed before its end'));
    }
    payload.on('data', onData);
    payload.on('end', onEnd);
    payload.on('error', onError);
    payload.on('close', onClose);
    payload.resume();
  });
}

/**
 * The same bytes as a fresh stream for Fastify's content-type parser. Its Content-Length check
 * compares `receivedEncodedLength` (else the bytes it reads) with the header, so carry the count of
 * bytes actually received from the client.
 */
function replay(rawBody: Buffer, source: PayloadStream): PayloadStream {
  const stream: PassThrough & { receivedEncodedLength?: number } = new PassThrough();
  stream.receivedEncodedLength =
    typeof source.receivedEncodedLength === 'number'
      ? source.receivedEncodedLength
      : rawBody.length;
  stream.end(rawBody);
  return stream;
}
