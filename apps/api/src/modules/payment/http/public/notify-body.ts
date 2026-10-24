// B2-15c: the raw bytes of a channel notification (08 BR-PAY-04: the signature is checked over the
// original; specs/pay-notify.md §2). Fastify parses a JSON body before the handler runs and has
// no parser for a form body at all, so on the api entry's Fastify instance the payment module
// installs, for the notification routes only:
//   - a preParsing hook that buffers the body (bounded by the route's bodyLimit, like
//     platform/http/request-checks.ts does for signed contract routes), keeps the bytes on the
//     request under NOTIFY_RAW_BODY and replays them to Fastify's parser;
//   - a parser for application/x-www-form-urlencoded (Alipay posts a form, docs-mirror/alipay/
//     app-pay/00dn78.md, 待实测) that yields the text as is on the notification routes and, on
//     every other route, refuses the media type exactly as Fastify does without a parser (415,
//     the 20001 body envelope of the global filter), so no other route starts accepting forms.
// Nothing here reads the body's content; the adapter does (PayChannel.verifyNotification).
// Fastify is reached through structural types (it is not a direct dependency of @couli/api).
import { PassThrough, type Readable } from 'node:stream';

/** The request property holding the buffered notification body. */
export const NOTIFY_RAW_BODY = 'payNotifyRawBody';

const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

type PayloadStream = Readable & { receivedEncodedLength?: number };

interface HookRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly routeOptions: { readonly url?: string | undefined; readonly bodyLimit: number };
  [NOTIFY_RAW_BODY]?: Buffer;
}

interface ParserRequest {
  readonly method: string;
  readonly routeOptions: { readonly url?: string | undefined };
}

type ParserDone = (error: Error | null, body?: unknown) => void;

/** The parts of a Fastify instance this module uses. */
interface NotifyServer {
  addHook(
    name: 'preParsing',
    hook: (request: HookRequest, reply: unknown, payload: PayloadStream) => Promise<unknown>,
  ): unknown;
  addContentTypeParser(
    contentType: string,
    options: { readonly parseAs: 'string' },
    parser: (request: ParserRequest, body: string, done: ParserDone) => void,
  ): unknown;
  hasContentTypeParser(contentType: string): boolean;
  decorateRequest(name: string, value: undefined): unknown;
  hasRequestDecorator(name: string): boolean;
}

function isNotifyServer(server: object): server is NotifyServer {
  const candidate = server as Partial<Record<keyof NotifyServer, unknown>>;
  return (
    typeof candidate.addHook === 'function' &&
    typeof candidate.addContentTypeParser === 'function' &&
    typeof candidate.hasContentTypeParser === 'function' &&
    typeof candidate.decorateRequest === 'function' &&
    typeof candidate.hasRequestDecorator === 'function'
  );
}

/** Selects the notification routes by method and Fastify route template. */
export type NotifyRouteFilter = (method: string, routeTemplate: string) => boolean;

/** The same shape Fastify gives its own body errors (@fastify/error): the global filter knows it. */
class NotifyBodyError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = 'FastifyError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function tooLarge(): NotifyBodyError {
  return new NotifyBodyError('FST_ERR_CTP_BODY_TOO_LARGE', 413, 'Request body is too large');
}

function unsupportedMediaType(): NotifyBodyError {
  return new NotifyBodyError(
    'FST_ERR_CTP_INVALID_MEDIA_TYPE',
    415,
    'Unsupported Media Type: application/x-www-form-urlencoded',
  );
}

/** Reads the whole payload, refusing more than `limit` bytes as Fastify's body reader does. */
function readRawBody(payload: PayloadStream, limit: number, declared: number): Promise<Buffer> {
  if (declared > limit) return Promise.reject(tooLarge());
  if (payload.readableEnded || payload.destroyed) {
    return Promise.reject(new Error('notification body stream was consumed before the hook'));
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const stop = (): void => {
      payload.removeListener('data', onData);
      payload.removeListener('end', onEnd);
      payload.removeListener('error', onError);
      payload.removeListener('close', onClose);
    };
    const fail = (error: unknown): void => {
      stop();
      reject(error instanceof Error ? error : new Error('notification body stream failed'));
    };
    function onData(chunk: Buffer | string): void {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      received += bytes.length;
      if (received > limit || (payload.receivedEncodedLength ?? 0) > limit) {
        fail(tooLarge());
        return;
      }
      chunks.push(bytes);
    }
    function onEnd(): void {
      stop();
      resolve(Buffer.concat(chunks, received));
    }
    function onError(error: unknown): void {
      fail(error);
    }
    function onClose(): void {
      fail(new Error('notification body stream closed before its end'));
    }
    payload.on('data', onData);
    payload.on('end', onEnd);
    payload.on('error', onError);
    payload.on('close', onClose);
    payload.resume();
  });
}

/** The same bytes as a fresh stream for Fastify's content-type parser. */
function replay(rawBody: Buffer, source: PayloadStream): PayloadStream {
  const stream: PassThrough & { receivedEncodedLength?: number } = new PassThrough();
  stream.receivedEncodedLength =
    typeof source.receivedEncodedLength === 'number'
      ? source.receivedEncodedLength
      : rawBody.length;
  stream.end(rawBody);
  return stream;
}

/**
 * Installs the capture on a Fastify instance before it is ready (the module's init hook): once
 * per instance. `isNotifyRoute` selects the notification routes.
 */
export function installNotifyBodyCapture(server: unknown, isNotifyRoute: NotifyRouteFilter): void {
  if (typeof server !== 'object' || server === null || !isNotifyServer(server)) {
    throw new TypeError('installNotifyBodyCapture needs a Fastify instance');
  }
  if (server.hasRequestDecorator(NOTIFY_RAW_BODY)) {
    throw new Error('the notification body capture is already installed on this server');
  }
  server.decorateRequest(NOTIFY_RAW_BODY, undefined);
  server.addHook('preParsing', async (request, _reply, payload) => {
    const template = request.routeOptions.url;
    if (template === undefined || !isNotifyRoute(request.method, template)) return undefined;
    const rawBody = await readRawBody(
      payload,
      request.routeOptions.bodyLimit,
      Number(request.headers['content-length']),
    );
    request[NOTIFY_RAW_BODY] = rawBody;
    return replay(rawBody, payload);
  });
  if (!server.hasContentTypeParser(FORM_MEDIA_TYPE)) {
    server.addContentTypeParser(FORM_MEDIA_TYPE, { parseAs: 'string' }, (request, body, done) => {
      const template = request.routeOptions.url;
      if (template !== undefined && isNotifyRoute(request.method, template)) done(null, body);
      else done(unsupportedMediaType());
    });
  }
}

/** The buffered body of a notification request (empty when the hook saw no body). */
export function notifyRawBodyOf(request: { readonly [NOTIFY_RAW_BODY]?: Buffer }): Buffer {
  return request[NOTIFY_RAW_BODY] ?? Buffer.alloc(0);
}
