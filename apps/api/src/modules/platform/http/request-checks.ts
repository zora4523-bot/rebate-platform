// The registration point for request checks that must run before Fastify parses or validates a
// request body (规划/08 BR-ID-01: ① request signature 10401/10402 → ② token → ③ app source and
// token scope, all before ⑮ body validation; BR-ID-09). Fastify validates the route schema before
// any Nest guard runs, so a guard would answer a malformed signature header with 20001 instead of
// 10401: the checks run in Fastify's `preParsing` hook instead.
//
// installRequestChecks(server, checks) — call once per Fastify instance, before `ready()` (bootstrap
// calls it right after NestFactory.create, with the ordered list the app module provides under
// REQUEST_CHECKS). For every request that matched a route (never for a 404):
//   1. buffer the raw body, bounded by the route's effective bodyLimit: a declared Content-Length
//      above it, or more bytes than it, rejects with Fastify's own 413 body error (the global
//      filter answers 413 / 20001, fields=[body]) before any check runs, whatever the signature;
//   2. run the checks in the given order on one RequestCheckInput; the first one that throws ends
//      the request with its error (the remaining checks are not called);
//   3. copy `verifiedDevice` (set by stage ①) onto the Fastify request for the handler and later
//      stages, and hand the identical bytes to Fastify's content-type parser.
// A check rejects a request with a contract code by throwing a RequestRejection (the global error
// filter writes `{ code, msg, trace_id }` with its HTTP status); any other error is a 50001.
//
// This file is also compiled by the `test` project: erasable syntax only (no parameter properties,
// enums, namespaces or decorators), `import type` for type-only imports, relative imports with the
// `.ts` extension, no NestJS, no `process.env`, no logging. Fastify is reached through the
// structural types below: it is not a direct dependency of @couli/api.
import { PassThrough, type Readable } from 'node:stream';

/** Verified by stage ①, before parsers, schema validation and later authentication stages. */
export interface VerifiedDevice {
  readonly deviceId: string;
  readonly appId: string;
}

export interface RequestCheckInput {
  /** The request id, which is the trace id (bootstrap's genReqId). */
  readonly id: string;
  readonly method: string;
  /** Original origin-form URL, including the untouched query string. */
  readonly url: string;
  /** Fastify's matched route template; absent for an unmatched route. */
  readonly routeTemplate?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly rawBody: Buffer;
  verifiedDevice?: VerifiedDevice;
}

export type RequestCheck = (request: RequestCheckInput) => Promise<void>;

/** What a handler or a later stage reads from the Fastify request. */
export interface CheckedRequest {
  verifiedDevice?: VerifiedDevice;
}

/** Nest token of the ordered `readonly RequestCheck[]` that bootstrap installs (app.module). */
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
  decorateRequest(name: 'verifiedDevice', value: undefined): unknown;
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

/**
 * Register before init/ready. Run checks in supplied order before body parsing; stop on error.
 * Bound raw-body buffering by the effective Fastify bodyLimit, replay identical bytes to the
 * parser, and copy verifiedDevice onto the request for subsequent authentication stages.
 * Overflow uses the existing 413/20001 body-error envelope, even for an invalid signature.
 */
export function installRequestChecks(server: object, checks: readonly RequestCheck[]): void {
  if (!isHookServer(server)) throw new TypeError('installRequestChecks needs a Fastify instance');
  const ordered = [...checks];
  if (ordered.some((check) => typeof check !== 'function')) {
    throw new TypeError('every request check must be a function');
  }
  // One registration per server keeps the order of the stages in one list.
  if (server.hasRequestDecorator('verifiedDevice')) {
    throw new Error('request checks are already installed on this server');
  }
  server.decorateRequest('verifiedDevice', undefined);
  if (ordered.length === 0) return;
  server.addHook('preParsing', async (request, _reply, payload) => {
    const routeTemplate = request.routeOptions.url;
    // An unmatched route answers 404 untouched: nothing to check, nothing to buffer.
    if (routeTemplate === undefined) return undefined;
    const rawBody = await readRawBody(
      payload,
      request.routeOptions.bodyLimit,
      Number(request.headers['content-length']),
    );
    const input: RequestCheckInput = {
      id: request.id,
      method: request.method,
      url: request.raw.url ?? request.url,
      routeTemplate,
      headers: request.headers,
      rawBody,
    };
    for (const check of ordered) await check(input);
    if (input.verifiedDevice !== undefined) request.verifiedDevice = input.verifiedDevice;
    return replay(rawBody, payload);
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
