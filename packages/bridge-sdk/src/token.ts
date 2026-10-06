// h5_token handling (BR-ID-32; 规划/03 §5.4). The token lives only in this manager's memory: no
// Web Storage, IndexedDB, Cookie, URL, other pages or logs. Native picks the scope; the SDK only
// re-acquires and never upgrades a scope by itself or starts a login.
import { h5_token_scope, type errorCodes } from '@couli/contracts-ts';
import { BridgeError, call, has, type BridgeMethods } from './bridge.ts';

type ApiErrorCode = keyof typeof errorCodes;

/** access token expired (contracts/error-codes.yaml): renew once and replay once. */
const TOKEN_EXPIRED = 10002 satisfies ApiErrorCode;
/** Scope refused; with data.reason=h5_read_only the cached token is dropped (BR-ID-32 细则). */
const SCOPE_FORBIDDEN = 10403 satisfies ApiErrorCode;
const READ_ONLY_REASON = 'h5_read_only';
/** Native answered code 0 with a result outside the contract (bridge error 90500). */
const NATIVE_ERROR = 90500;
// RFC 3339 date-time (JSON Schema format "date-time").
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

/** Syntax plus calendar ranges (Date.parse alone accepts days such as 02-30). */
function isDateTime(value: string): boolean {
  const match = DATE_TIME.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second, offsetHour = 0, offsetMinute = 0] = match
    .slice(1)
    .map((part) => (part === undefined ? undefined : Number(part)));
  if (year === undefined || month === undefined || day === undefined) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour !== undefined &&
    hour <= 23 &&
    minute !== undefined &&
    minute <= 59 &&
    second !== undefined &&
    second <= 60 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

export type H5Token = BridgeMethods['auth.getH5Token']['result'];

/** Parsed server envelope; request does not interpret HTTP status as a business code. */
export interface H5ApiResponse<T = unknown> {
  code: number;
  msg: string;
  data?: T;
}

export interface H5TokenManager {
  getToken(options: { forWrite: boolean }): Promise<H5Token>;
  invalidate(): void;
  /**
   * send is an injected authenticated request, never a storage or navigation callback.
   * Every method other than GET is a write for read_only handling. A 10002 envelope triggers
   * one fresh acquisition and one replay; 10403 is returned unchanged, never retried or logged in.
   * Only 10403 with data.reason=h5_read_only discards the cached token.
   */
  request<T>(
    method: string,
    send: (token: string) => Promise<H5ApiResponse<T>>,
  ): Promise<H5ApiResponse<T>>;
}

function isReadOnlyDenial(response: H5ApiResponse<unknown>): boolean {
  if (response.code !== SCOPE_FORBIDDEN) return false;
  const data: unknown = response.data;
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { reason?: unknown }).reason === READ_ONLY_REASON
  );
}

/**
 * Checks auth.getH5Token's result against contracts/bridge.schema.json (token non-empty string,
 * expire_at date-time string, scope in h5_token_scope). Returns a frozen copy of only those three
 * fields, or null. The error raised for null never carries the received value.
 */
function parseToken(result: unknown): H5Token | null {
  if (typeof result !== 'object' || result === null) return null;
  const { token, expire_at: expireAt, scope } = result as Partial<Record<string, unknown>>;
  if (typeof token !== 'string' || token.length === 0) return null;
  if (typeof expireAt !== 'string' || !isDateTime(expireAt)) {
    return null;
  }
  if (!(h5_token_scope as readonly unknown[]).includes(scope)) return null;
  return Object.freeze({ token, expire_at: expireAt, scope: scope as H5Token['scope'] });
}

/**
 * Upper bound on attempts in each re-acquire loop (getting a token, and the check right before
 * send). Every extra attempt means invalidate() ran again meanwhile; a real account switch followed
 * by a logout needs at most 3, so more means invalidate() is being called in a loop and the request
 * fails (90500) instead of asking native for tokens without end.
 */
const MAX_ATTEMPTS = 3;

function tooManyInvalidations(): BridgeError {
  return new BridgeError(NATIVE_ERROR, 'H5 token was invalidated repeatedly while acquiring');
}

/** A token together with the invalidate() generation it was acquired in. */
interface Stamped {
  readonly token: H5Token;
  readonly generation: number;
}

/** Acquires via has('auth.getH5Token') + call; the returned manager owns only page memory. */
export function createH5TokenManager(): H5TokenManager {
  let cached: Stamped | null = null;
  let inflight: Promise<Stamped> | null = null;
  // Bumped by invalidate() (account switch or logout). A token is usable only while its own
  // generation is still the current one; a late acquisition cannot resurrect a dropped token.
  let generation = 0;

  /**
   * invalidate(): forget the cached token and detach any acquisition still in flight. Callers
   * already waiting on that acquisition re-acquire instead of receiving its (old) token.
   */
  function invalidate(): void {
    cached = null;
    inflight = null;
    generation += 1;
  }

  /**
   * Drops only the cached token (the given one, or whatever is cached). An acquisition already
   * in flight was started after that token was issued, so it stays shared: concurrent requests
   * renew through one auth.getH5Token (single flight, contracts 10002).
   */
  function dropCached(stamped?: Stamped): void {
    if (stamped === undefined || cached === stamped) cached = null;
  }

  /** One shared auth.getH5Token; the result is stamped with the generation it started in. */
  function acquire(): Promise<Stamped> {
    if (inflight !== null) return inflight;
    const cap = has('auth.getH5Token');
    if (cap === null) {
      return Promise.reject(new BridgeError(90001, 'auth.getH5Token is not supported'));
    }
    const epoch = generation;
    const pending: Promise<Stamped> = call(cap, {}).then(
      (result) => {
        const token = parseToken(result);
        const stamped = token === null ? null : Object.freeze({ token, generation: epoch });
        if (generation === epoch) {
          cached = stamped;
          inflight = null;
        }
        if (stamped === null) {
          throw new BridgeError(NATIVE_ERROR, 'auth.getH5Token returned a malformed result');
        }
        return stamped;
      },
      (error: unknown) => {
        if (generation === epoch) {
          cached = null;
          inflight = null;
        }
        throw error;
      },
    );
    // invalidate() may run synchronously inside postMessage; never share a detached acquisition.
    if (generation === epoch) inflight = pending;
    return pending;
  }

  /**
   * A token of the current generation. An acquisition that started before invalidate() is
   * discarded, success or failure, and a fresh one is awaited instead (F1-01l). A write with a
   * cached read_only token asks native once more and uses whatever scope comes back; the server
   * then answers 10403 h5_read_only if it is still read_only (BR-ID-32).
   */
  async function obtain(forWrite: boolean): Promise<Stamped> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (cached !== null && !(forWrite && cached.token.scope === 'read_only')) return cached;
      // acquire() either joins the in-flight acquisition or starts one; both belong to this
      // generation because invalidate() detaches the in-flight one.
      const epoch = generation;
      let stamped: Stamped;
      try {
        stamped = await acquire();
      } catch (error) {
        if (generation === epoch) throw error;
        continue;
      }
      if (stamped.generation === generation) return stamped;
    }
    throw tooManyInvalidations();
  }

  async function getToken({ forWrite }: { forWrite: boolean }): Promise<H5Token> {
    return (await obtain(forWrite)).token;
  }

  /**
   * Obtains a token and calls send in the same synchronous continuation as the final generation
   * check, so no invalidate() can slip in between. Once send has been called the request is not
   * withdrawn; only later requests see the invalidation.
   */
  async function sendCurrent<T>(
    forWrite: boolean,
    send: (token: string) => Promise<H5ApiResponse<T>>,
  ): Promise<{ stamped: Stamped; response: H5ApiResponse<T> }> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const stamped = await obtain(forWrite);
      if (stamped.generation !== generation) continue;
      const sent = send(stamped.token.token);
      return { stamped, response: await sent };
    }
    throw tooManyInvalidations();
  }

  async function request<T>(
    method: string,
    send: (token: string) => Promise<H5ApiResponse<T>>,
  ): Promise<H5ApiResponse<T>> {
    const forWrite = method.trim().toUpperCase() !== 'GET';
    let { stamped, response } = await sendCurrent(forWrite, send);
    // 10002 on a token from before an invalidate() (another account, or logged out) is returned
    // as is: replaying it with the new generation's token would act for a different account.
    if (response.code === TOKEN_EXPIRED && stamped.generation === generation) {
      // Reuses a newer cached token or an acquisition already in flight; otherwise asks native.
      dropCached(stamped);
      ({ stamped, response } = await sendCurrent(forWrite, send));
      // Still expired after one renewal: report the failure, keep nothing stale, no third try.
      if (response.code === TOKEN_EXPIRED) dropCached(stamped);
    }
    if (isReadOnlyDenial(response)) dropCached();
    return response;
  }

  return { getToken, invalidate, request };
}
