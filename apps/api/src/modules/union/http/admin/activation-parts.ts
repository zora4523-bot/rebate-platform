// Reading the multipart/form-data body of POST /admin/v1/union-pids/{pid_id}/activate (B1-22h;
// contract adminActivateUnionPid: parts `expected_row_version`, `hjy_ignore_confirmed_at`, an
// optional `reason` and the file `hjy_ignore_evidence`, in any order). Called by the handler inside
// the guard's business callback only, so a refused permission or step-up never consumes the body
// (as platform readSingleUpload and content's popup asset parts).
//   - a body above the route's bodyLimit (Content-Length up front, or the bytes counted while
//     streaming): ActivationPartsRejection 413 / data.fields [body]; on overflow it stops consuming
//     the request at once;
//   - not multipart, an unknown part, a malformed body or the plugin's own client errors:
//     400 / data.fields [body];
//   - a repeated field, or an ordinary field named hjy_ignore_evidence: reported in `invalid`, so
//     the use case answers it in the contract's order of checks.
// Values are returned as sent; the use case validates them.
//
// Limits: the admin entry registers @fastify/multipart with one part and no ordinary field
// (bootstrap.ts, for the platform icon upload). For this request only, the plugin's per-request
// parser factory (Symbol('multipartHandler'), which `parts()` calls) is wrapped to merge the limits
// below (fileSize stays the global one), as content's popup asset upload does. A plugin without
// that factory is a server error (50001), never a looser parse.
// TODO(规划/11 §3.2): per-route multipart limits in bootstrap — blocked on a task outside union's paths.
// Erasable syntax only; no NestJS import.
import type { SingleUploadRequest } from '../../../platform/index.ts';
import type { AdminPidActivationParts } from '../../application/admin-pids.ts';

/** A refused activation body: the HTTP status and the one field named in the 20001 envelope. */
export class ActivationPartsRejection extends Error {
  readonly statusCode: 400 | 413;

  constructor(statusCode: 400 | 413) {
    super(statusCode === 413 ? 'activation body too large' : 'invalid activation body');
    this.name = 'ActivationPartsRejection';
    this.statusCode = statusCode;
  }
}

/** Three ordinary fields and one file; one spare of each so a repeat is reported, not cut off. */
const ACTIVATION_LIMITS = Object.freeze({ files: 2, fields: 6, parts: 8 });
const HANDLER = 'multipartHandler';
const FIELDS = ['expected_row_version', 'hjy_ignore_confirmed_at', 'reason'] as const;
type FieldName = (typeof FIELDS)[number];

type Handler = (this: unknown, options?: { readonly limits?: object }) => unknown;

function widenLimits(request: object): void {
  for (let owner: object | null = request; owner !== null; owner = Object.getPrototypeOf(owner)) {
    const key = Object.getOwnPropertySymbols(owner).find(
      (symbol) => symbol.description === HANDLER,
    );
    if (key === undefined) continue;
    const handler: unknown = Reflect.get(request, key);
    if (typeof handler !== 'function') break;
    const factory = handler as Handler;
    Object.defineProperty(request, key, {
      configurable: true,
      writable: true,
      value: function (this: unknown, options?: { readonly limits?: object }): unknown {
        return factory.call(this, {
          ...options,
          limits: { ...options?.limits, ...ACTIVATION_LIMITS },
        });
      },
    });
    return;
  }
  throw new Error('union: the multipart plugin exposes no per-request parser');
}

const tooLarge = (): ActivationPartsRejection => new ActivationPartsRejection(413);
const invalidBody = (): ActivationPartsRejection => new ActivationPartsRejection(400);

/** One structural multipart part (a file with toBuffer, or an ordinary field with its value). */
interface Part {
  readonly type: string;
  readonly fieldname: string;
  readonly value?: unknown;
  toBuffer?: () => Promise<Buffer>;
}

function isField(name: string): name is FieldName {
  return (FIELDS as readonly string[]).includes(name);
}

export async function readActivationParts(
  request: SingleUploadRequest,
): Promise<AdminPidActivationParts> {
  if (!request.isMultipart()) throw invalidBody();
  const limit = request.routeOptions.bodyLimit;
  const declared = request.headers['content-length'];
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > limit) {
    throw tooLarge();
  }
  widenLimits(request);

  const raw = request.raw;
  let received = 0;
  let rejectOverflow: (error: ActivationPartsRejection) => void = () => undefined;
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
  const step = <T>(promise: Promise<T>): Promise<T> => {
    promise.catch(() => undefined);
    return Promise.race([promise, overflow]);
  };

  const values: Partial<Record<FieldName, string>> = {};
  const invalid = new Set<string>();
  let evidence: Uint8Array | undefined;
  const parts = request.parts();
  try {
    for (;;) {
      const next = await step(parts.next());
      if (next.done === true) break;
      const part = next.value as Part;
      const name = part.fieldname;
      if (part.type === 'file') {
        if (name !== 'hjy_ignore_evidence' || part.toBuffer === undefined) throw invalidBody();
        const bytes = new Uint8Array(await step(part.toBuffer()));
        if (evidence !== undefined) invalid.add(name);
        else evidence = bytes;
      } else if (part.type === 'field') {
        if (name === 'hjy_ignore_evidence') {
          invalid.add(name);
        } else if (isField(name)) {
          if (Object.hasOwn(values, name) || typeof part.value !== 'string') invalid.add(name);
          else values[name] = part.value;
        } else {
          throw invalidBody();
        }
      } else {
        throw invalidBody();
      }
    }
    if (received > limit) throw tooLarge();
    return {
      expected_row_version: values.expected_row_version,
      hjy_ignore_confirmed_at: values.hjy_ignore_confirmed_at,
      reason: values.reason,
      hjy_ignore_evidence: invalid.has('hjy_ignore_evidence') ? undefined : evidence,
      invalid: [...invalid],
    };
  } catch (error) {
    raw.removeListener('data', onData);
    raw.unpipe();
    if (received > limit) throw tooLarge();
    if (error instanceof ActivationPartsRejection) throw error;
    // The multipart plugin's client errors: a file above fileSize is the body limit, any other
    // limit or protocol error a bad body.
    if (error instanceof Error && error.name === 'FastifyError') {
      const code = (error as { code?: unknown }).code;
      throw code === 'FST_REQ_FILE_TOO_LARGE' ? tooLarge() : invalidBody();
    }
    // busboy reports a malformed body with a plain Error: a bad request, not a server error.
    if (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype) {
      throw invalidBody();
    }
    throw error;
  } finally {
    raw.removeListener('data', onData);
  }
}
