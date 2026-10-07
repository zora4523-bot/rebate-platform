// Admin auth provider (BR-ID-34, CT-02f /admin/v1/auth/*). Login is a step machine:
// credentials → change_password? → bind_totp | totp → done. Before the last step the client only
// holds a login_ticket (memory only); the admin_token arrives after the dynamic code (or the
// binding) is accepted. The session (token, absolute expiry, idle timeout, last activity) lives in
// memory and the injected storage — sessionStorage by default, never localStorage. Idle time
// counts from the last successful authenticated request; input events do not extend it.
import type {
  AuthActionResponse,
  AuthProvider,
  CheckResponse,
  OnErrorResponse,
} from '@refinedev/core';
import type { Schema } from '@couli/contracts-ts';
import { AdminApiError, createDataProvider, type AdminDataProvider } from '../data/index.ts';

export type AdminIdentity = Schema<'AdminMe'>;
export type AdminSession = Schema<'AdminSession'>;
export type AdminBindingSecret = Schema<'AdminTotpSecretData'>;
export type AdminLoginStepData = Schema<'AdminLoginStepData'>;

export interface AuthClock {
  now(): number;
}

export type AuthStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface AuthOptions {
  readonly api: { readonly baseUrl: string; readonly fetch: typeof globalThis.fetch };
  /** Default: sessionStorage, with memory fallback. Never localStorage. */
  readonly storage?: AuthStorage;
  readonly clock?: AuthClock;
  /**
   * Timers wait for `start()` (React: called from an effect), so an instance built during a render
   * that React discards never runs the idle timer. Default: timers run from creation.
   */
  readonly manualStart?: boolean;
}

export type LoginInput =
  | { readonly step: 'credentials'; readonly username: string; readonly password: string }
  | { readonly step: 'change_password'; readonly newPassword: string }
  | { readonly step: 'totp' | 'bind_totp'; readonly code: string };

export interface LoginError {
  /** Key in texts/login.ts (BR-TEXT-14 error.<code>[.<reason>] or a local key). */
  readonly key: string;
  readonly lockedUntil?: string;
  readonly retryAfterSeconds?: number;
  readonly traceId?: string;
  /** Server msg, only shown for codes the dictionary does not know. */
  readonly serverMessage?: string;
  /** 20001: request fields the server rejected (`data.fields`), marked beside their inputs. */
  readonly fields?: readonly string[];
}

export interface LoginSnapshot {
  readonly step: 'credentials' | 'change_password' | 'totp' | 'bind_totp' | 'done';
  readonly username: string;
  readonly secret?: Schema<'AdminTotpSecretData'>;
  /** bind_totp only: the binding secret is being fetched (the step is already entered). */
  readonly secretLoading?: boolean;
  /** done only: the login finished by binding the authenticator (shows the binding-done page). */
  readonly bound?: boolean;
  readonly error?: LoginError;
}

export interface AdminAuthProvider extends AuthProvider {
  login(input: LoginInput): Promise<AuthActionResponse>;
  logout(params?: unknown): Promise<AuthActionResponse>;
  check(params?: unknown): Promise<CheckResponse>;
  onError(error: unknown): Promise<OnErrorResponse>;
  /** `refresh: true` asks /me/permissions again instead of answering from the cache. */
  getIdentity(params?: { readonly refresh?: boolean }): Promise<Schema<'AdminMe'> | null>;
  getSnapshot(): LoginSnapshot;
  subscribe(listener: () => void): () => void;
  getToken(): string | null;
  /** Called only after a successful authenticated request, never on input or failed requests. */
  recordSuccessfulRequest(): void;
  /** Discard the pending login ticket and binding secret when leaving or switching account. */
  resetLogin(): void;
  /** bind_totp: fetch the binding secret again with the same ticket (after a failed fetch). */
  retryBindingSecret(): Promise<AuthActionResponse>;
  /** Starts the session timers (see `manualStart`); the returned function stops them again. */
  start(): () => void;
  dispose(): void;
}

const STORAGE_KEY = 'couli.admin.session';
const LOGIN_PATH = '/login';
const MAX_TIMER_MS = 2_147_483_647;

const CODE_NOT_SIGNED_IN = 10001;
const CODE_BAD_PASSWORD = 10008;
const CODE_LOCKED = 10009;
const CODE_FORBIDDEN = 10403;
const CODE_INVALID_FIELDS = 20001;
const CODE_BAD_CODE = 20002;
const CODE_RATE_LIMITED = 42901;

/** Reasons with their own line in texts/login.ts (BR-TEXT-14 table B). */
const KNOWN_REASONS: Readonly<Record<number, readonly string[]>> = {
  [CODE_NOT_SIGNED_IN]: ['login_ticket_expired'],
  [CODE_FORBIDDEN]: ['admin_ip_not_allowed', 'admin_permission_denied'],
  [CODE_BAD_CODE]: ['totp_invalid', 'totp_bind_invalid'],
};

interface StoredSession {
  readonly token: string;
  readonly expiresAt: number;
  readonly idleMs: number;
  readonly lastActive: number;
}

interface PendingLogin {
  readonly step: 'change_password' | 'totp' | 'bind_totp';
  readonly ticket: string;
}

function reasonOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || !('reason' in data)) return undefined;
  return typeof data.reason === 'string' ? data.reason : undefined;
}

function fieldsOf(data: unknown): readonly string[] | undefined {
  if (typeof data !== 'object' || data === null || !('fields' in data)) return undefined;
  const fields: unknown = data.fields;
  if (!Array.isArray(fields)) return undefined;
  const names = fields.filter((field): field is string => typeof field === 'string');
  return names.length === 0 ? undefined : names;
}

function lockedUntilOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || !('locked_until' in data)) return undefined;
  return typeof data.locked_until === 'string' ? data.locked_until : undefined;
}

/** sessionStorage when the browser allows it, plus an in-memory copy; never localStorage. */
function defaultStorage(): AuthStorage {
  const memory = new Map<string, string>();
  const session = (): Storage | undefined => {
    try {
      return globalThis.sessionStorage;
    } catch {
      return undefined;
    }
  };
  return {
    getItem(key) {
      try {
        const value = session()?.getItem(key);
        if (value !== null && value !== undefined) return value;
      } catch {
        // Blocked storage: fall back to memory.
      }
      return memory.get(key) ?? null;
    },
    setItem(key, value) {
      memory.set(key, value);
      try {
        session()?.setItem(key, value);
      } catch {
        // Quota or blocked storage: the memory copy still serves this page.
      }
    },
    removeItem(key) {
      memory.delete(key);
      try {
        session()?.removeItem(key);
      } catch {
        // Nothing stored there.
      }
    },
  };
}

function parseStored(raw: string | null): StoredSession | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    const token = record['admin_token'];
    const expiresAt =
      typeof record['expires_at'] === 'string' ? Date.parse(record['expires_at']) : NaN;
    const idle = record['idle_timeout_sec'];
    const lastActive =
      typeof record['last_active_at'] === 'string' ? Date.parse(record['last_active_at']) : NaN;
    if (
      typeof token !== 'string' ||
      token === '' ||
      Number.isNaN(expiresAt) ||
      typeof idle !== 'number' ||
      !(idle > 0) ||
      Number.isNaN(lastActive)
    )
      return null;
    return { token, expiresAt, idleMs: idle * 1000, lastActive };
  } catch {
    return null;
  }
}

function serialize(session: StoredSession): string {
  return JSON.stringify({
    admin_token: session.token,
    expires_at: new Date(session.expiresAt).toISOString(),
    idle_timeout_sec: session.idleMs / 1000,
    last_active_at: new Date(session.lastActive).toISOString(),
  });
}

/** Maps a failed call to the dictionary key and the values the page needs. */
function loginErrorOf(cause: unknown): LoginError {
  if (!(cause instanceof AdminApiError)) return { key: 'error.unknown' };
  if (cause.kind === 'network') return { key: 'error.network' };
  if (cause.kind !== 'api') return { key: 'error.unknown' };
  const reason = reasonOf(cause.data);
  const withTrace = cause.traceId === undefined ? {} : { traceId: cause.traceId };
  switch (cause.code) {
    case CODE_LOCKED: {
      const lockedUntil = lockedUntilOf(cause.data);
      return lockedUntil === undefined
        ? { key: 'error.10009.no_time' }
        : { key: 'error.10009', lockedUntil };
    }
    case CODE_RATE_LIMITED:
      return { key: 'error.42901', retryAfterSeconds: cause.retryAfterSeconds ?? 5 };
    case CODE_NOT_SIGNED_IN:
    case CODE_FORBIDDEN:
    case CODE_BAD_CODE:
      return {
        key:
          reason !== undefined && KNOWN_REASONS[cause.code]?.includes(reason)
            ? `error.${cause.code}.${reason}`
            : `error.${cause.code}`,
      };
    case CODE_INVALID_FIELDS: {
      const fields = fieldsOf(cause.data);
      return { key: 'error.20001', ...(fields === undefined ? {} : { fields }) };
    }
    case CODE_BAD_PASSWORD:
      return { key: `error.${cause.code}` };
    default:
      if (cause.code >= 50000 && cause.code < 60000) return { key: 'error.5xxxx', ...withTrace };
      return { key: 'error.unknown', ...(cause.msg === '' ? {} : { serverMessage: cause.msg }) };
  }
}

export function createAuthProvider(options: AuthOptions): AdminAuthProvider {
  const storage = options.storage ?? defaultStorage();
  const clock = options.clock ?? { now: () => Date.now() };
  // Login calls never carry a Bearer token; session calls (me, logout) read the current one.
  const anonymous: AdminDataProvider = createDataProvider({
    baseUrl: options.api.baseUrl,
    fetch: options.api.fetch,
    getToken: () => null,
    onError: () => undefined,
  });
  const authed: AdminDataProvider = createDataProvider({
    baseUrl: options.api.baseUrl,
    fetch: options.api.fetch,
    getToken: () => session?.token ?? null,
    onError: () => undefined,
  });

  const listeners = new Set<() => void>();
  let session: StoredSession | null = parseStored(storage.getItem(STORAGE_KEY));
  let pending: PendingLogin | null = null;
  let snapshot: LoginSnapshot = { step: 'credentials', username: '' };
  let identity: AdminIdentity | null = null;
  // Bumped whenever the login flow or the session is abandoned; late responses compare it.
  let epoch = 0;
  // Bumped whenever a session starts or ends; session calls compare it instead of the object
  // (recording activity replaces the object without changing the session).
  let generation = 0;
  let logoutRequest: Promise<AuthActionResponse> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = options.manualStart !== true;

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function setSnapshot(next: LoginSnapshot): void {
    snapshot = next;
    notify();
  }

  function valid(current: StoredSession | null, now = clock.now()): current is StoredSession {
    return current !== null && now < current.expiresAt && now < current.lastActive + current.idleMs;
  }

  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function schedule(): void {
    clearTimer();
    if (session === null || !started) return;
    const deadline = Math.min(session.expiresAt, session.lastActive + session.idleMs);
    const delay = Math.min(Math.max(deadline - clock.now(), 0), MAX_TIMER_MS);
    timer = setTimeout(() => {
      timer = undefined;
      if (valid(session)) schedule();
      else endSession();
    }, delay);
  }

  /**
   * Drops the session. A login page still on the done step (e.g. the binding-done page left idle)
   * goes back to the first step, so 「进入后台」 never leads to a dead session.
   */
  function endSession(): void {
    clearTimer();
    const had = session !== null || identity !== null;
    if (had) generation += 1;
    session = null;
    identity = null;
    storage.removeItem(STORAGE_KEY);
    if (snapshot.step === 'done') {
      epoch += 1;
      pending = null;
      snapshot = { step: 'credentials', username: '', error: { key: 'error.10001' } };
      notify();
      return;
    }
    if (had) notify();
  }

  function startSession(data: AdminSession): void {
    const now = clock.now();
    const expiresAt = Date.parse(data.expires_at);
    session = {
      token: data.admin_token,
      expiresAt: Number.isNaN(expiresAt) ? now : expiresAt,
      idleMs: data.idle_timeout_sec * 1000,
      lastActive: now,
    };
    identity = null;
    generation += 1;
    storage.setItem(STORAGE_KEY, serialize(session));
    schedule();
  }

  /** Back to the first step (ticket and secret dropped), keeping the username shown. */
  function toCredentials(error?: LoginError): void {
    pending = null;
    setSnapshot({
      step: 'credentials',
      username: snapshot.username,
      ...(error === undefined ? {} : { error }),
    });
  }

  function failed(error: LoginError): AuthActionResponse {
    return { success: false, error: new Error(error.key) };
  }

  /** Error during an intermediate step: expired ticket or lock → first step; otherwise stay. */
  function stepFailure(cause: unknown, username: string): AuthActionResponse {
    const error = loginErrorOf(cause);
    if (
      cause instanceof AdminApiError &&
      cause.kind === 'api' &&
      (cause.code === CODE_NOT_SIGNED_IN || cause.code === CODE_LOCKED)
    ) {
      toCredentials(error);
    } else {
      const { secretLoading: _loading, ...rest } = snapshot;
      void _loading;
      setSnapshot({ ...rest, username, error });
    }
    return failed(error);
  }

  async function post<T>(path: string, payload: unknown): Promise<T> {
    const response = await anonymous.custom({
      url: `/admin/v1/auth/${path}`,
      method: 'post',
      payload,
    });
    return response.data as T;
  }

  /** Moves to the step the server named; a binding step first fetches its secret. */
  async function enterStep(
    data: AdminLoginStepData,
    username: string,
    mine: number,
  ): Promise<AuthActionResponse> {
    // The previous ticket is spent: keep the new one before anything else can fail.
    pending = { step: data.next, ticket: data.login_ticket };
    if (data.next === 'bind_totp') {
      setSnapshot({ step: 'bind_totp', username, secretLoading: true });
      return fetchSecret(data.login_ticket, username, mine);
    }
    setSnapshot({ step: data.next, username });
    return { success: true };
  }

  /** Fetches the binding secret; a failure stays on the binding step and offers a retry. */
  async function fetchSecret(
    ticket: string,
    username: string,
    mine: number,
  ): Promise<AuthActionResponse> {
    let secret: AdminBindingSecret;
    try {
      secret = await post<AdminBindingSecret>('totp/secret', { login_ticket: ticket });
    } catch (cause) {
      if (mine !== epoch) return { success: false };
      return stepFailure(cause, username);
    }
    if (mine !== epoch) return { success: false };
    setSnapshot({ step: 'bind_totp', username, secret });
    return { success: true };
  }

  async function retryBindingSecret(): Promise<AuthActionResponse> {
    const current = pending;
    if (current === null || current.step !== 'bind_totp') {
      const error: LoginError = { key: 'error.10001.login_ticket_expired' };
      toCredentials(error);
      return failed(error);
    }
    if (snapshot.secretLoading === true || snapshot.secret !== undefined) return { success: true };
    const username = snapshot.username;
    setSnapshot({ step: 'bind_totp', username, secretLoading: true });
    return fetchSecret(current.ticket, username, epoch);
  }

  async function login(input: LoginInput): Promise<AuthActionResponse> {
    if (input.step === 'credentials') {
      epoch += 1;
      const mine = epoch;
      pending = null;
      const username = input.username;
      setSnapshot({ step: 'credentials', username });
      let data: AdminLoginStepData;
      try {
        data = await post<AdminLoginStepData>('login', { username, password: input.password });
      } catch (cause) {
        if (mine !== epoch) return { success: false };
        const error = loginErrorOf(cause);
        setSnapshot({ step: 'credentials', username, error });
        return failed(error);
      }
      if (mine !== epoch) return { success: false };
      return enterStep(data, username, mine);
    }

    const current = pending;
    if (current === null || current.step !== input.step) {
      const error: LoginError = { key: 'error.10001.login_ticket_expired' };
      toCredentials(error);
      return failed(error);
    }
    const mine = epoch;
    const username = snapshot.username;
    if (snapshot.error !== undefined) setSnapshot(stripError(snapshot));

    if (input.step === 'change_password') {
      let data: AdminLoginStepData;
      try {
        data = await post<AdminLoginStepData>('password', {
          login_ticket: current.ticket,
          new_password: input.newPassword,
        });
      } catch (cause) {
        if (mine !== epoch) return { success: false };
        return stepFailure(cause, username);
      }
      if (mine !== epoch) return { success: false };
      return enterStep(data, username, mine);
    }

    let data: AdminSession;
    try {
      data = await post<AdminSession>(input.step === 'totp' ? 'totp' : 'totp/bind', {
        login_ticket: current.ticket,
        code: input.code,
      });
    } catch (cause) {
      if (mine !== epoch) return { success: false };
      return stepFailure(cause, username);
    }
    if (mine !== epoch) return { success: false };
    pending = null;
    startSession(data);
    setSnapshot({ step: 'done', username, ...(input.step === 'bind_totp' ? { bound: true } : {}) });
    return { success: true };
  }

  function stripError(value: LoginSnapshot): LoginSnapshot {
    if (value.error === undefined) return value;
    const { error: _error, ...rest } = value;
    void _error;
    return rest;
  }

  function resetLogin(): void {
    epoch += 1;
    pending = null;
    setSnapshot({ step: 'credentials', username: '' });
  }

  function getToken(): string | null {
    return valid(session) ? session.token : null;
  }

  async function check(): Promise<CheckResponse> {
    if (valid(session)) return { authenticated: true };
    endSession();
    return { authenticated: false, logout: true, redirectTo: LOGIN_PATH };
  }

  function recordSuccessfulRequest(): void {
    if (!valid(session)) return;
    session = { ...session, lastActive: clock.now() };
    storage.setItem(STORAGE_KEY, serialize(session));
    schedule();
  }

  async function onError(error: unknown): Promise<OnErrorResponse> {
    if (
      error instanceof AdminApiError &&
      error.kind === 'api' &&
      error.code === CODE_NOT_SIGNED_IN &&
      reasonOf(error.data) === undefined
    ) {
      epoch += 1;
      pending = null;
      endSession();
      return { logout: true, redirectTo: LOGIN_PATH, error };
    }
    return {};
  }

  async function getIdentity(params?: {
    readonly refresh?: boolean;
  }): Promise<AdminIdentity | null> {
    if (!valid(session)) return null;
    if (identity !== null && params?.refresh !== true) return identity;
    const mine = generation;
    let data: AdminIdentity;
    try {
      const response = await authed.custom({ url: '/admin/v1/me/permissions', method: 'get' });
      data = response.data as AdminIdentity;
    } catch (cause) {
      if (generation === mine) await onError(cause);
      throw cause;
    }
    // Another session started or this one ended meanwhile: the answer belongs to neither.
    if (generation !== mine || !valid(session)) return null;
    recordSuccessfulRequest();
    identity = data;
    return data;
  }

  /**
   * Drops the local session at once, then revokes its token on the server. A second call while
   * the first is under way joins it; the late answer never touches a session started afterwards.
   */
  function logout(): Promise<AuthActionResponse> {
    if (logoutRequest !== null) return logoutRequest;
    epoch += 1;
    pending = null;
    const token = session?.token ?? null;
    setSnapshot({ step: 'credentials', username: '' });
    endSession();
    if (token === null) return Promise.resolve({ success: true, redirectTo: LOGIN_PATH });
    const revoke = createDataProvider({
      baseUrl: options.api.baseUrl,
      fetch: options.api.fetch,
      getToken: () => token,
      onError: () => undefined,
    });
    const request = (async (): Promise<AuthActionResponse> => {
      try {
        await revoke.custom({ url: '/admin/v1/auth/logout', method: 'post' });
      } catch {
        // Already expired or unreachable: the local session is gone either way.
      } finally {
        logoutRequest = null;
      }
      return { success: true, redirectTo: LOGIN_PATH };
    })();
    logoutRequest = request;
    return request;
  }

  if (session !== null) {
    if (valid(session)) schedule();
    else endSession();
  }

  return {
    login,
    logout,
    check,
    onError,
    getIdentity,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getToken,
    recordSuccessfulRequest,
    resetLogin,
    retryBindingSecret,
    start() {
      started = true;
      if (session !== null) {
        if (valid(session)) schedule();
        else endSession();
      }
      return () => {
        started = false;
        clearTimer();
      };
    },
    dispose() {
      clearTimer();
      listeners.clear();
      epoch += 1;
    },
  };
}
