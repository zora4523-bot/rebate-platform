// B2-15k: the HTTP transport of the real collection channels (NotImplemented skeleton; the rule
// tests are test/spec/payment/channels/**). The default transport uses fetch, follows no redirect,
// has a timeout and an upper limit on the response size (task §9.10).
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

export function fetchPayTransport(request: PayHttpRequest): Promise<PayHttpResponse> {
  void request;
  throw new Error('NotImplemented: fetchPayTransport');
}
