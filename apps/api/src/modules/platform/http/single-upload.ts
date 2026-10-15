// Reading the single file of a multipart/form-data request (task F1-06s; contracts/openapi.yaml
// adminUploadPlatformIcon: one part `file`, 20001 data.fields [file]; a body above the global limit
// 413 data.fields [body]).
//
// Only the admin entry registers @fastify/multipart (bootstrap.ts: attachFieldsToBody false, limits
// files 1, fields 0, parts 1, fileSize = Fastify's bodyLimit). Nothing is read before the handler:
// the route's guards run first, then the handler calls `readSingleUpload(request)`, which
//   - refuses a request that is not multipart, a body without parts, a first part that is not a
//     file named `file`, any further part (a second file, any ordinary field) and a malformed
//     multipart body: UploadRejection 400 / data.fields [file];
//   - refuses a file above `fileSize` and a whole request body above the route's bodyLimit
//     (Content-Length up front, or the bytes counted while streaming a chunked body; the multipart
//     overhead counts): UploadRejection 413 / data.fields [body]. On overflow it stops consuming
//     the request at once, as Fastify does for a JSON body above the limit;
//   - otherwise returns the file's bytes, its client filename and MIME type.
// global-errors.ts answers UploadRejection (and the plugin's own errors, should another caller
// raise them) with the 20001 envelope; neither the filename nor the content is written back.
//
// Exported to other modules only by ../index.ts (./index.ts keeps its runtime exports fixed).
// This file is also compiled by the `test` project: erasable syntax only, no NestJS import.
import type { IncomingMessage } from 'node:http';
import type { Multipart } from '@fastify/multipart';

/** Structural Fastify request; the admin entry installs the multipart methods. */
export interface SingleUploadRequest {
  readonly id: string;
  readonly headers: IncomingMessage['headers'];
  readonly raw: IncomingMessage;
  readonly routeOptions: { readonly bodyLimit: number };
  isMultipart(): boolean;
  parts(): AsyncIterableIterator<Multipart>;
}

export interface SingleUpload {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimetype: string;
}

export type UploadErrorField = 'file' | 'body';

/** A refused upload: the HTTP status and the one field named in the 20001 envelope. */
export class UploadRejection extends Error {
  readonly statusCode: 400 | 413;
  readonly field: UploadErrorField;

  constructor(statusCode: 400 | 413, field: UploadErrorField) {
    super(statusCode === 413 ? 'upload body too large' : 'invalid upload');
    this.name = 'UploadRejection';
    this.statusCode = statusCode;
    this.field = field;
  }
}

/** Codes of @fastify/multipart 10 errors that describe the client's request. */
const PLUGIN_FILE_ERRORS: ReadonlySet<string> = new Set([
  'FST_PARTS_LIMIT',
  'FST_FILES_LIMIT',
  'FST_FIELDS_LIMIT',
  'FST_PROTO_VIOLATION',
  'FST_INVALID_MULTIPART_CONTENT_TYPE',
  'FST_INVALID_JSON_FIELD_ERROR',
  'FST_MP_PREMATURE_CLOSE',
]);
const PLUGIN_BODY_ERRORS: ReadonlySet<string> = new Set(['FST_REQ_FILE_TOO_LARGE']);

/**
 * The UploadRejection a value stands for: itself, or a client error of the multipart plugin
 * (a file above fileSize → 413 [body]; a limit on parts / files / fields, a prototype field name,
 * a request that is not multipart, a bad JSON field, a premature close → 400 [file]). Undefined
 * for anything else.
 */
export function uploadRejectionOf(error: unknown): UploadRejection | undefined {
  if (error instanceof UploadRejection) return error;
  if (!(error instanceof Error) || error.name !== 'FastifyError') return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return undefined;
  if (PLUGIN_BODY_ERRORS.has(code)) return new UploadRejection(413, 'body');
  if (PLUGIN_FILE_ERRORS.has(code)) return new UploadRejection(400, 'file');
  return undefined;
}

const tooLarge = (): UploadRejection => new UploadRejection(413, 'body');
const invalid = (): UploadRejection => new UploadRejection(400, 'file');

/** Called by the handler after its guards; accepts exactly one part named `file`. */
export async function readSingleUpload(request: SingleUploadRequest): Promise<SingleUpload> {
  if (!request.isMultipart()) throw invalid();
  const limit = request.routeOptions.bodyLimit;
  const declared = request.headers['content-length'];
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > limit) {
    throw tooLarge();
  }

  // Count the raw bytes (a chunked body has no Content-Length); on overflow stop feeding the
  // parser and reject whatever step is pending.
  const raw = request.raw;
  let received = 0;
  let rejectOverflow: (error: UploadRejection) => void = () => undefined;
  const overflow = new Promise<never>((_resolve, reject) => {
    rejectOverflow = reject;
  });
  overflow.catch(() => undefined);
  const onData = (chunk: Buffer | string): void => {
    received += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (received > limit) {
      raw.removeListener('data', onData);
      raw.unpipe();
      rejectOverflow(tooLarge());
    }
  };
  raw.on('data', onData);
  // A step abandoned on overflow must not end as an unhandled rejection later.
  const step = <T>(promise: Promise<T>): Promise<T> => {
    promise.catch(() => undefined);
    return Promise.race([promise, overflow]);
  };

  const parts = request.parts();
  try {
    const first = await step(parts.next());
    if (first.done === true) throw invalid();
    const part = first.value;
    if (part.type !== 'file' || part.fieldname !== 'file') throw invalid();
    const bytes = await step(part.toBuffer());
    const rest = await step(parts.next());
    if (rest.done !== true) throw invalid();
    if (received > limit) throw tooLarge();
    return { bytes: new Uint8Array(bytes), filename: part.filename, mimetype: part.mimetype };
  } catch (error) {
    raw.removeListener('data', onData);
    raw.unpipe();
    if (received > limit) throw tooLarge();
    const rejection = uploadRejectionOf(error);
    if (rejection !== undefined) throw rejection;
    // busboy reports a malformed body (no boundary, a truncated part, a bad header) with a plain
    // Error: a bad upload, not a server error. Anything else (TypeError, ...) stays a 50001.
    if (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype) throw invalid();
    throw error;
  } finally {
    raw.removeListener('data', onData);
  }
}
