// B2-15k: the HTTP transport of the real collection channels (rule tests:
// test/spec/payment/channels/transport.test.ts). The default transport uses fetch, makes one
// attempt, follows no redirect, has a timeout and an upper limit on the response size (task §9.10).
// Also compiled by the `test` project: erasable syntax only.

export interface PayHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  /** Largest response accepted; a larger one rejects. The default transport has its own default. */
  readonly maxResponseBytes?: number;
}

export interface PayHttpResponse {
  readonly status: number;
  /** Header names lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body as UTF-8 text; a response signature covers this text. */
  readonly body: string;
  /** The body's bytes when the transport has them (the WeChat bill's SHA1 covers the bytes). */
  readonly bytes?: Uint8Array;
}

export type PayTransport = (request: PayHttpRequest) => Promise<PayHttpResponse>;

/** No channel API answer documented for these calls comes near this; bills pass their own limit. */
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** The response went over its limit; the connection is dropped, nothing of the body is kept. */
export class PayResponseTooLarge extends Error {
  constructor() {
    super('pay channel response is over its size limit');
    this.name = 'PayResponseTooLarge';
  }
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new PayResponseTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export async function fetchPayTransport(request: PayHttpRequest): Promise<PayHttpResponse> {
  const limit = request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const response = await fetch(request.url, {
    method: request.method,
    headers: { ...request.headers },
    redirect: 'error',
    signal: AbortSignal.timeout(request.timeoutMs),
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new PayResponseTooLarge();
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  const bytes = await readLimited(response, limit);
  return {
    status: response.status,
    headers,
    // Never strips a BOM and never throws: a signature over other bytes simply fails to verify,
    // and a bill in another encoding keeps its exact bytes for the hash.
    body: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes),
    bytes,
  };
}
