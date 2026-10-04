// HTTP transport and the result every channel call returns.

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
 * A call has exactly two outcomes.
 *
 * - `ok`: the channel answered; the answer passed verification (signature, key identity,
 *   freshness where the channel provides it), carries the identifiers of this very request, and
 *   has the fields and value ranges this call requires. It means "this is what the channel says
 *   about this order", not "the money moved": read the state fields in `data`.
 * - `unknown`: everything else. This package never claims that a money operation definitely did
 *   not happen. In particular a verified error answer is `unknown` with `reason:
 *   'channel_error'`: its signature proves who sent it, not which request it answers, and the
 *   channels' own docs say to query the bill before treating an error as a failure. The caller
 *   decides what an error code means from the `ok` result of a later query and from its own
 *   verified code lists (BR-WDR-14, BR-WDR-28, BR-PAY-04) — never by resending a transfer.
 *
 * `data` comes from the channel and may hold personal data (openid, account ids, names). Never
 * log or return it as a whole; use `describeResult` for logs.
 */
export type ChannelResult<T> = { readonly kind: 'ok'; readonly data: T } | UnknownResult;

export interface UnknownResult {
  readonly kind: 'unknown';
  readonly reason: UnknownReason;
  /** Built from fixed words, HTTP statuses and field names only. */
  readonly detail: string;
  /**
   * Channel error code when one was readable. With `verified: true` it comes from an answer that
   * passed signature verification; otherwise it is a diagnostic hint from an untrusted answer.
   */
  readonly code?: string;
  readonly verified?: boolean;
}

export type UnknownReason =
  | 'timeout'
  | 'transport'
  | 'http_5xx'
  | 'throttled'
  | 'bad_signature'
  | 'bad_body'
  | 'channel_error';

export function unknownResult(
  reason: UnknownReason,
  detail: string,
  code?: string,
  verified?: boolean,
): UnknownResult {
  return {
    kind: 'unknown',
    reason,
    detail,
    ...(code === undefined ? {} : { code }),
    ...(verified === true ? { verified: true } : {}),
  };
}

/** Error codes that may be printed. Anything else, wherever it came from, prints as `<other>`. */
const PRINTABLE_CODES: ReadonlySet<string> = new Set([
  // WeChat Pay
  'PARAM_ERROR',
  'INVALID_REQUEST',
  'NO_AUTH',
  'SIGN_ERROR',
  'NOT_ENOUGH',
  'APPID_MCHID_NOT_MATCH',
  'MCH_NOT_EXISTS',
  'SYSTEM_ERROR',
  'ALREADY_EXISTS',
  'OUT_TRADE_NO_USED',
  'FREQUENCY_LIMIT_EXCEED',
  'RATELIMIT_EXCEEDED',
  'FREQUENCY_LIMIT',
  'NOT_FOUND',
  'ORDER_NOT_EXIST',
  'RESOURCE_NOT_EXISTS',
  'ORDERPAID',
  'ORDER_CLOSED',
  'NAME_NOT_CORRECT',
  // Alipay
  '20000',
  '20001',
  '40001',
  '40002',
  '40003',
  '40004',
  '40006',
  'INVALID_PARAMETER',
  'PAYEE_NOT_EXIST',
  'BALANCE_IS_NOT_ENOUGH',
  'REQUEST_PROCESSING',
  'TRANS_ORDER_DEALING',
  'PROMO_TRANS_ORDER_DEALING',
  'BIZ_UNIQUE_EXCEPTION',
  'PAYMENT_INFO_INCONSISTENCY',
  'MRCHPROD_QUERY_ERROR',
  'ACQ.TRADE_NOT_EXIST',
  'ACQ.SYSTEM_ERROR',
  'aop.unknow-error',
  'isp.unknow-error',
  'isv.invalid-signature',
]);

function printableDetail(detail: string): string {
  // Details are built from fixed words; this is a second line of defence, not the first.
  return detail
    .replace(/[^A-Za-z0-9_ .:-]/g, '?')
    .replace(/\d{7,}/g, '#')
    .slice(0, 60);
}

/** Log-safe summary: no channel payload, no free text, no value that is not a known constant. */
export function describeResult(r: ChannelResult<unknown>): string {
  if (r.kind === 'ok') return 'ok';
  const code =
    r.code === undefined ? '' : ` code=${PRINTABLE_CODES.has(r.code) ? r.code : '<other>'}`;
  const verified = r.verified === true ? ' verified' : '';
  return `unknown reason=${r.reason} detail=${printableDetail(r.detail)}${code}${verified}`;
}

/** What a successful answer of one call must contain. Anything else is `unknown`. */
export interface Shape {
  /** Required non-empty strings. */
  readonly strings?: readonly string[];
  /** Required integers greater than zero (amounts in fen). */
  readonly positiveIntegers?: readonly string[];
  /** Required decimal amounts in yuan, at most two places. */
  readonly amounts?: readonly string[];
  /** Amounts that may be absent but must be well-formed when present. */
  readonly optionalAmounts?: readonly string[];
  /** String fields restricted to the documented values. */
  readonly enums?: Readonly<Record<string, readonly string[]>>;
  /**
   * Fields that, when present, must equal the value sent in the request (order numbers, merchant
   * and application ids). A valid signature proves who answered, not which request was answered.
   * List a field in `strings` as well to make it mandatory.
   */
  readonly echo?: Readonly<Record<string, string>>;
  /** When set, the object may contain these keys and no others. */
  readonly exactKeys?: readonly string[];
  /** Call-specific checks; returns the violation or `undefined`. */
  readonly check?: (obj: Readonly<Record<string, unknown>>) => string | undefined;
}

const YUAN = /^\d{1,12}(\.\d{1,2})?$/;

/** Returns the first violation, or `undefined` when the object matches the shape. */
export function shapeViolation(
  obj: Readonly<Record<string, unknown>>,
  shape: Shape,
): string | undefined {
  for (const f of shape.strings ?? []) {
    const v = obj[f];
    if (typeof v !== 'string' || v === '') return `missing ${f}`;
  }
  for (const f of shape.positiveIntegers ?? []) {
    const v = obj[f];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) return `invalid ${f}`;
  }
  for (const f of shape.amounts ?? []) {
    const v = obj[f];
    if (typeof v !== 'string' || !YUAN.test(v)) return `invalid ${f}`;
  }
  for (const f of shape.optionalAmounts ?? []) {
    const v = obj[f];
    if (v !== undefined && (typeof v !== 'string' || !YUAN.test(v))) return `invalid ${f}`;
  }
  for (const [f, allowed] of Object.entries(shape.enums ?? {})) {
    const v = obj[f];
    if (typeof v !== 'string' || !allowed.includes(v)) return `unexpected ${f}`;
  }
  for (const [f, expected] of Object.entries(shape.echo ?? {})) {
    const v = obj[f];
    if (v !== undefined && v !== expected) return `mismatched ${f}`;
  }
  if (shape.exactKeys !== undefined) {
    for (const k of Object.keys(obj)) {
      if (!shape.exactKeys.includes(k)) return 'unexpected field';
    }
  }
  return shape.check?.(obj);
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

/** Runs the transport and folds thrown errors into `unknown`. Error text never leaves here. */
export async function send(
  transport: Transport,
  req: HttpRequest,
): Promise<HttpResponse | UnknownResult> {
  try {
    return await transport(req);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError')
      return unknownResult('timeout', 'timed out');
    return unknownResult('transport', 'transport error');
  }
}
