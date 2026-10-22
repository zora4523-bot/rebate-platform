// Reading the two parts of POST /admin/v1/pages/popup-assets (F1-09r; contract
// adminUploadPopupAsset: multipart/form-data with `kind` and `file`, in either order). Called by the
// handler inside the guard's business callback only, so a refused permission never consumes the
// request body (as platform readSingleUpload for the platform icon upload).
//   - not multipart, a part other than one field `kind` and one file `file`, or a malformed body:
//     PopupAssetPartsRejection 400 / data.fields [file];
//   - a body above the route's bodyLimit (Content-Length up front, or the bytes counted while
//     streaming): 413 / data.fields [body]; on overflow it stops consuming the request at once;
//   - the multipart plugin's own client errors are rethrown unchanged (the global filter answers
//     them with the same envelopes).
// `kind` is returned as sent (undefined when absent); the caller decides 20001 [kind].
//
// Limits: the admin entry registers @fastify/multipart with one part and no ordinary field
// (bootstrap.ts, for the platform icon upload). This route needs two parts, so for this request
// only the plugin's per-request parser factory (Symbol('multipartHandler'), which `parts()` calls)
// is wrapped to merge files 1 / fields 1 / parts 2 over the global limits (fileSize stays the
// global one). Wrapping the factory rather than passing options to `parts()` keeps the limits
// whatever wraps `parts`. A plugin without that factory is a server error (50001), never a looser
// parse. TODO(规划/11 §3.2): per-route multipart limits in bootstrap — blocked on a task outside
// content's paths.
// Erasable syntax only; no NestJS import.
import type { SingleUploadRequest } from '../../../platform/index.ts';
import type { PopupAssetParts } from '../../application/popup-asset-uploader.ts';

/** A refused upload body: the HTTP status and the one field named in the 20001 envelope. */
export class PopupAssetPartsRejection extends Error {
  readonly statusCode: 400 | 413;
  readonly field: 'file' | 'body';

  constructor(statusCode: 400 | 413, field: 'file' | 'body') {
    super(statusCode === 413 ? 'popup asset body too large' : 'invalid popup asset upload');
    this.name = 'PopupAssetPartsRejection';
    this.statusCode = statusCode;
    this.field = field;
  }
}

/** The limits of this route's multipart body: one field `kind` and one file `file`. */
const POPUP_LIMITS = Object.freeze({ files: 1, fields: 1, parts: 2 });
const HANDLER = 'multipartHandler';

type Handler = (this: unknown, options?: { readonly limits?: object }) => unknown;

/** Makes `request.parts()` parse this request under POPUP_LIMITS (see the header). */
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
          limits: { ...options?.limits, ...POPUP_LIMITS },
        });
      },
    });
    return;
  }
  throw new Error('content: the multipart plugin exposes no per-request parser');
}

const tooLarge = (): PopupAssetPartsRejection => new PopupAssetPartsRejection(413, 'body');
const invalid = (): PopupAssetPartsRejection => new PopupAssetPartsRejection(400, 'file');

/** One structural multipart part (a file with toBuffer, or an ordinary field with its value). */
interface Part {
  readonly type: string;
  readonly fieldname: string;
  readonly value?: unknown;
  toBuffer?: () => Promise<Buffer>;
}

export async function readPopupAssetParts(request: SingleUploadRequest): Promise<PopupAssetParts> {
  if (!request.isMultipart()) throw invalid();
  const limit = request.routeOptions.bodyLimit;
  const declared = request.headers['content-length'];
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > limit) {
    throw tooLarge();
  }
  widenLimits(request);

  // Count the raw bytes (a chunked body has no Content-Length); on overflow stop feeding the
  // parser and reject whatever step is pending.
  const raw = request.raw;
  let received = 0;
  let rejectOverflow: (error: PopupAssetPartsRejection) => void = () => undefined;
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

  const parts = request.parts();
  let kind: unknown;
  let sawKind = false;
  let file: Uint8Array | undefined;
  try {
    for (;;) {
      const next = await step(parts.next());
      if (next.done === true) break;
      const part = next.value as Part;
      if (part.type === 'file' && part.fieldname === 'file' && file === undefined) {
        if (part.toBuffer === undefined) throw invalid();
        file = new Uint8Array(await step(part.toBuffer()));
      } else if (part.type === 'field' && part.fieldname === 'kind' && !sawKind) {
        sawKind = true;
        kind = part.value;
      } else {
        throw invalid();
      }
    }
    if (received > limit) throw tooLarge();
    return { kind, file };
  } catch (error) {
    raw.removeListener('data', onData);
    raw.unpipe();
    if (received > limit) throw tooLarge();
    if (error instanceof PopupAssetPartsRejection) throw error;
    // The multipart plugin's client errors (FastifyError) go to the global filter unchanged.
    if (error instanceof Error && error.name === 'FastifyError') throw error;
    // busboy reports a malformed body with a plain Error: a bad upload, not a server error.
    if (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype) throw invalid();
    throw error;
  } finally {
    raw.removeListener('data', onData);
  }
}
