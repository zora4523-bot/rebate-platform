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
 * - `ok`: the channel answered, the answer passed verification (signature, key identity,
 *   freshness) and has the fields this call requires. It means "this is what the channel says",
 *   not "the money moved": read the state fields in `data`.
 * - `rejected`: a verified answer carrying a business error code that is not one of the codes the
 *   channel documents as "still processing / cannot tell". Whether the code proves that no money
 *   moved is still decided by the caller's verified code lists (BR-WDR-28, BR-PAY-04).
 * - `unknown`: anything else — timeout, transport error, 5xx, throttling, an answer that cannot
 *   be verified (including every unsigned error), an unexpected shape, or a documented
 *   indeterminate code (`reason: 'indeterminate'`, with the code in `code`). The caller must only
 *   query, never resend a transfer (BR-WDR-14).
 *
 * `data` and `message` come from the channel and may hold personal data (openid, account ids,
 * names). Never log or return them as a whole; use `describeResult` for logs.
 */
export type ChannelResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | {
      readonly kind: 'rejected';
      readonly code: string;
      readonly message: string;
      readonly httpStatus: number;
    }
  | UnknownResult;

export interface UnknownResult {
  readonly kind: 'unknown';
  readonly reason: UnknownReason;
  readonly detail: string;
  /** Channel code when one was readable. Diagnostic only: it may come from an unverified answer. */
  readonly code?: string;
}

export type UnknownReason =
  | 'timeout'
  | 'transport'
  | 'http_5xx'
  | 'throttled'
  | 'bad_signature'
  | 'bad_body'
  | 'indeterminate';

/** Log-safe summary: no channel payload, no free-text message. */
export function describeResult(r: ChannelResult<unknown>): string {
  if (r.kind === 'ok') return 'ok';
  if (r.kind === 'rejected') return `rejected code=${r.code} http=${String(r.httpStatus)}`;
  return `unknown reason=${r.reason} detail=${r.detail}${r.code === undefined ? '' : ` code=${r.code}`}`;
}

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
): Promise<HttpResponse | UnknownResult> {
  try {
    return await transport(req);
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    const reason: UnknownReason =
      name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'transport';
    return { kind: 'unknown', reason, detail: name };
  }
}
