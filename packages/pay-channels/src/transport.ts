// HTTP transport and the three-way result every channel call returns.

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
}

export interface HttpResponse {
  readonly status: number;
  /** Header names lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

/**
 * - `ok`: the channel answered and the answer passed signature verification.
 * - `rejected`: the channel answered with a business error code. Whether that code means the money
 *   definitely did not move is decided by the caller's verified code lists (BR-WDR-28, BR-PAY-04),
 *   never here.
 * - `unknown`: timeout, transport error, 5xx, throttling, unverifiable or unparsable answer. The
 *   caller must only query, never resend a transfer (BR-WDR-14).
 */
export type ChannelResult<T> =
  | { readonly kind: 'ok'; readonly data: T; readonly raw: string }
  | {
      readonly kind: 'rejected';
      readonly code: string;
      readonly message: string;
      readonly httpStatus: number;
      readonly raw: string;
    }
  | { readonly kind: 'unknown'; readonly reason: UnknownReason; readonly detail: string };

export type UnknownReason =
  'timeout' | 'transport' | 'http_5xx' | 'throttled' | 'bad_signature' | 'bad_body';

/** Default transport on the global fetch. One attempt, no retries, no redirects. */
export const fetchTransport: Transport = async (req) => {
  const init: RequestInit = {
    method: req.method,
    headers: { ...req.headers },
    redirect: 'error',
    signal: AbortSignal.timeout(req.timeoutMs),
  };
  if (req.body !== undefined) init.body = req.body;
  const res = await fetch(req.url, init);
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: res.status, headers, body: await res.text() };
};

/** Runs the transport and folds thrown errors into `unknown`. */
export async function send(
  transport: Transport,
  req: HttpRequest,
): Promise<
  | HttpResponse
  | { readonly kind: 'unknown'; readonly reason: UnknownReason; readonly detail: string }
> {
  try {
    return await transport(req);
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    const reason: UnknownReason =
      name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'transport';
    return { kind: 'unknown', reason, detail: name };
  }
}
