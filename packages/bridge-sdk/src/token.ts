// h5_token handling (BR-ID-32; 规划/03 §5.4). The token lives only in this manager's memory: no
// Web Storage, IndexedDB, Cookie, URL, other pages or logs. Native picks the scope; the SDK only
// re-acquires and never upgrades a scope by itself or starts a login.
import type { errorCodes } from '@couli/contracts-ts';
import { BridgeError, call, has, type BridgeMethods } from './bridge.ts';

type ApiErrorCode = keyof typeof errorCodes;

/** access token expired (contracts/error-codes.yaml): renew once and replay once. */
const TOKEN_EXPIRED = 10002 satisfies ApiErrorCode;
/** Scope refused; with data.reason=h5_read_only the cached token is dropped (BR-ID-32 细则). */
const SCOPE_FORBIDDEN = 10403 satisfies ApiErrorCode;
const READ_ONLY_REASON = 'h5_read_only';

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

/** Acquires via has('auth.getH5Token') + call; the returned manager owns only page memory. */
export function createH5TokenManager(): H5TokenManager {
  let cached: H5Token | null = null;
  let inflight: Promise<H5Token> | null = null;
  // Bumped by invalidate() so a late acquisition cannot resurrect a dropped token.
  let generation = 0;

  /** invalidate(): forget the cached token and detach any acquisition still in flight. */
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
  function dropCached(token?: H5Token): void {
    if (token === undefined || cached === token) cached = null;
  }

  function acquire(): Promise<H5Token> {
    if (inflight !== null) return inflight;
    const cap = has('auth.getH5Token');
    if (cap === null) {
      return Promise.reject(new BridgeError(90001, 'auth.getH5Token is not supported'));
    }
    const epoch = generation;
    const pending: Promise<H5Token> = call(cap, {}).then(
      (result) => {
        const token = Object.freeze({ ...result });
        if (generation === epoch) {
          cached = token;
          inflight = null;
        }
        return token;
      },
      (error: unknown) => {
        if (generation === epoch) {
          cached = null;
          inflight = null;
        }
        throw error;
      },
    );
    inflight = pending;
    return pending;
  }

  function getToken({ forWrite }: { forWrite: boolean }): Promise<H5Token> {
    // A read_only token is fine for GET; before anything else ask native again (BR-ID-32).
    if (cached !== null && !(forWrite && cached.scope === 'read_only')) {
      return Promise.resolve(cached);
    }
    return acquire();
  }

  async function request<T>(
    method: string,
    send: (token: string) => Promise<H5ApiResponse<T>>,
  ): Promise<H5ApiResponse<T>> {
    const forWrite = method.trim().toUpperCase() !== 'GET';
    let current = await getToken({ forWrite });
    let response = await send(current.token);
    if (response.code === TOKEN_EXPIRED) {
      // Reuses a newer cached token or an acquisition already in flight; otherwise asks native.
      dropCached(current);
      current = await getToken({ forWrite });
      response = await send(current.token);
      // Still expired after one renewal: report the failure, keep nothing stale, no third try.
      if (response.code === TOKEN_EXPIRED) dropCached(current);
    }
    if (isReadOnlyDenial(response)) dropCached();
    return response;
  }

  return { getToken, invalidate, request };
}
