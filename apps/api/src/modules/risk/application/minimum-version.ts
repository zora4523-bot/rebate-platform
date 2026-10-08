// Stage ④a of the request decision order (规划/08 BR-ID-01 判定顺序 ④a; 细则「最低支持版本的接口层
// 拦截」与「受限会话」; 04 §5 最低支持版本 / 受限会话; error 10405 of contracts/error-codes.yaml).
//
// Policy comes from the contract only: CONTRACT_MIN_VERSION_ROUTES (./min-version-routes.gen.ts,
// generated from x-min-version-gate, x-session-scopes and x-idempotent). The bodies that exempt a
// `conditional` operation are written in the operation descriptions; CONDITIONAL_EXEMPTIONS below
// carries them, and a conditional operation without an entry is judged like a true one.
//
// Decision for one request (route = method + Fastify route template):
// 1. Restricted session: a principal (stage ②, platform tokenPrincipal) with scp=deletion_only may
//    call only operations whose x-session-scopes lists deletion_only, and a conditional one only
//    with an exempting body (the two tables of BR-ID-01 coincide on these five operations). Any
//    other operation, GET included, and any route outside the contract gets 10405 whatever the
//    platform or version; data.min_supported_version is the current minimum of the request's
//    (app, platform, channel), null when the platform is not judged or no minimum is configured.
// 2. Version gate: gate true, or conditional without an exempting body; only X-Platform ios /
//    android / harmony with an X-Channel. The minimum of (app, platform, channel) comes from
//    MinimumVersionReader (content's cached reader of app_versions); null (no row, no minimum)
//    lets the request through. A missing or malformed X-App-Version counts as below
//    (platform/client-version compareClientVersions). Below → 10405 with that minimum.
// A reader failure rejects unchanged (50001 through the global filter), never as "no minimum";
// a malformed configured minimum throws as well (compareClientVersions).
//
// Position: non-idempotent operations are judged by the guard (a global Nest guard: after the
// pre-parsing request checks ① ② ③); idempotent ones are judged by the idempotency post-miss hook
// (platform/idempotency/post-miss.ts), so a completed key still replays and a processing one still
// answers 40901, and a 10405 writes no idempotency record. The hook gets the HTTP request through
// MINIMUM_VERSION_SCOPE, an AsyncLocalStorage that the risk interceptor opens around the handler.
// Connections: the hook runs inside the idempotency claim's transaction, which holds a pooled
// connection and the key's advisory lock. It must not borrow a second connection (a pool full of
// claims would wait on itself, the pool having no acquire timeout), so it reads the minimum with
// a reader built on that transaction (platform idempotencyPostMissTransaction(), the
// MinimumVersionReaderOn factory: uncached, one read on the claim's connection). The guard runs
// outside any transaction and keeps the cached pooled reader.
// Fail closed: the scope also records whether the IDEMPOTENCY instance received the request
// (entry observer: it then either ran the hook or replayed / refused it); a route marked
// idempotent whose handler succeeds without that (a private instance, a path that skipped
// execute) answers 50001 instead of a response stage ④a never judged.
//
// x-auth none operations (e.g. POST /v1/auth/sms-codes) never read Authorization, so they have
// no principal and the restricted-session check does not apply to them (a planning
// inconsistency under spec sync, B1-03c §11.3; not resolved here by parsing tokens).
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpException } from '@nestjs/common';
import type { ClientPlatform } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  compareClientVersions,
  idempotencyPostMissTransaction,
  isVersionGatedPlatform,
  tokenPrincipal,
  type IdempotencyEntryObserver,
  type IdempotencyPostMissCheck,
  type TokenPrincipal,
} from '../../platform/index.ts';
import { CONTRACT_MIN_VERSION_ROUTES } from './min-version-routes.gen.ts';

/** B1-03c: content implements this port; app.module supplies it. No content dependency here. */
export interface MinimumVersionReader {
  minSupportedVersion(
    appId: string,
    platform: ClientPlatform,
    channel: string,
  ): Promise<string | null>;
}

/**
 * A MinimumVersionReader reading through the given handle (a transaction included: a
 * Transaction<DB> is a Kysely<DB>). Used by the post-miss hook with the claim's transaction.
 */
export type MinimumVersionReaderOn = (db: Kysely<DB>) => MinimumVersionReader;

/** Parsed HTTP request after stages ①–③; principal is read through tokenPrincipal. */
export interface MinimumVersionRequest {
  readonly id: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly routeOptions: { readonly url?: string };
  readonly body?: unknown;
  readonly principal?: TokenPrincipal;
}

/**
 * Stage ④a for one request. `versions`, when given, replaces the check's own reader for this
 * request (the post-miss hook passes a reader on the claim's transaction).
 */
export type MinimumVersionCheck = (
  request: MinimumVersionRequest,
  versions?: MinimumVersionReader,
) => Promise<void>;

/** Build-time contract projection; paths use Fastify :parameter templates, GET gate is null. */
export interface MinimumVersionRoute {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly gate: boolean | 'conditional' | null;
  readonly sessionScopes: readonly ('full' | 'deletion_only')[];
  readonly idempotent: boolean;
}

/** Generated from openapi extensions, including planned operations; no runtime YAML parser. */
export function contractMinimumVersionRoutes(): readonly MinimumVersionRoute[] {
  return ROUTES;
}

const ROUTES: readonly MinimumVersionRoute[] = CONTRACT_MIN_VERSION_ROUTES;
const ROUTE_INDEX: ReadonlyMap<string, MinimumVersionRoute> = new Map(
  ROUTES.map((route) => [`${route.method} ${route.path}`, route]),
);

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)[name]
    : undefined;
}

/** Login, or the step-up of an account deletion: session recovery and deletion only. */
function loginOrDeletionStepUp(body: unknown): boolean {
  const purpose = field(body, 'purpose');
  return (
    purpose === 'login' || (purpose === 'step_up' && field(body, 'action') === 'account_deletion')
  );
}

/**
 * The exempting bodies of the conditional operations (BR-ID-01 接口表 and 受限会话表; the
 * operation descriptions of contracts/openapi.yaml). Keyed by `METHOD path-template`.
 */
export const CONDITIONAL_EXEMPTIONS: Readonly<Record<string, (body: unknown) => boolean>> =
  Object.freeze({
    'POST /v1/auth/sms-codes': loginOrDeletionStepUp,
    'POST /v1/auth/oauth-attempts': loginOrDeletionStepUp,
    'POST /v1/auth/step-up': (body: unknown) => field(body, 'action') === 'account_deletion',
    'POST /v1/idempotency-keys/abandon': (body: unknown) =>
      field(body, 'action') === 'account_deletion',
    'POST /v1/consents': (body: unknown) => {
      const type = field(body, 'type');
      return field(body, 'accepted') === false || type === 'privacy' || type === 'agreement';
    },
  });

function header(request: MinimumVersionRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function routeOf(request: MinimumVersionRequest): MinimumVersionRoute | undefined {
  const path = request.routeOptions.url;
  return path === undefined
    ? undefined
    : ROUTE_INDEX.get(`${String(request.method).toUpperCase()} ${path}`);
}

function exempt(route: MinimumVersionRoute, body: unknown): boolean {
  if (route.gate !== 'conditional') return false;
  const exemption = CONDITIONAL_EXEMPTIONS[`${route.method} ${route.path}`];
  return exemption !== undefined && exemption(body);
}

function refusal(request: MinimumVersionRequest, minimum: string | null): HttpException {
  return new HttpException(
    {
      code: 10405,
      msg: 'client version below the minimum supported version or outside the session scope',
      data: { min_supported_version: minimum },
      trace_id: request.id,
    },
    403,
  );
}

/**
 * Stage ④a. Resolve on permission; reject with an HTTP 403 HttpException whose contract
 * envelope has code 10405, this request's trace_id and data.min_supported_version (nullable).
 * Reuse platform's client version comparison. A reader failure must not become permission.
 */
export function createMinimumVersionCheck(versions: MinimumVersionReader): MinimumVersionCheck {
  /** The configured minimum of this request's (app, platform, channel); null when not judged. */
  async function minimumOf(
    request: MinimumVersionRequest,
    reader: MinimumVersionReader,
  ): Promise<string | null> {
    const platform = header(request, 'x-platform');
    const channel = header(request, 'x-channel');
    const appId = tokenPrincipal(request)?.app_id ?? header(request, 'x-app-id');
    if (platform === undefined || !isVersionGatedPlatform(platform)) return null;
    // A missing X-Channel or app reads as "no configured row", like identity's session scope.
    if (channel === undefined || appId === undefined) return null;
    return reader.minSupportedVersion(appId, platform as ClientPlatform, channel);
  }

  return async (request, override) => {
    const reader = override ?? versions;
    const route = routeOf(request);
    const bodyExempt = route !== undefined && exempt(route, request.body);
    if (tokenPrincipal(request)?.scp === 'deletion_only') {
      const allowed =
        route !== undefined &&
        route.sessionScopes.includes('deletion_only') &&
        (route.gate !== 'conditional' || bodyExempt);
      if (!allowed) throw refusal(request, await minimumOf(request, reader));
    }
    if (route === undefined) return;
    const gated = route.gate === true || (route.gate === 'conditional' && !bodyExempt);
    if (!gated) return;
    const minimum = await minimumOf(request, reader);
    if (minimum === null) return;
    const order = compareClientVersions(header(request, 'x-app-version'), minimum);
    if (order === null || order < 0) throw refusal(request, minimum);
  };
}

export interface MinimumVersionGuard {
  canActivate(context: {
    switchToHttp(): { getRequest(): MinimumVersionRequest };
  }): Promise<boolean>;
}

/**
 * Non-idempotent operations run the check here, after ③. Idempotent operations defer it to
 * platform's post-miss hook (including deletion_only checks), preserving replay and 40901.
 * AppModule/RiskModule must install the guard and the idempotency hook on the api entry.
 */
export function createMinimumVersionGuard(check: MinimumVersionCheck): MinimumVersionGuard {
  return {
    async canActivate(context) {
      const request = context.switchToHttp().getRequest();
      if (routeOf(request)?.idempotent === true) return true;
      await check(request);
      return true;
    },
  };
}

/**
 * The HTTP request being handled, for the idempotency post-miss hook (which only receives the
 * IdempotentRequest). Opened by the risk interceptor around the route handler; one store per
 * request, so simultaneous requests never see each other's.
 */
export const MINIMUM_VERSION_SCOPE = new AsyncLocalStorage<MinimumVersionScope>();

/** One HTTP request in MINIMUM_VERSION_SCOPE. */
export interface MinimumVersionScope {
  readonly request: MinimumVersionRequest;
  /** Set by the entry observer when the IDEMPOTENCY instance received this request. */
  idempotencyEntered: boolean;
}

/** Whether the contract marks the request's operation x-idempotent (judged by the hook). */
export function isIdempotentMinimumVersionRoute(request: MinimumVersionRequest): boolean {
  return routeOf(request)?.idempotent === true;
}

/**
 * Raised (→ 50001 with an `error` log line by the global filter) when an idempotent operation's
 * handler finished without the IDEMPOTENCY instance ever receiving the request, i.e. without
 * stage ④a: fail closed rather than let an unjudged response out.
 */
export class MinimumVersionUnjudgedError extends Error {
  constructor(method: string, path: string | undefined) {
    super(`idempotent operation ${method} ${path ?? '?'} finished without stage 4a`);
    this.name = 'MinimumVersionUnjudgedError';
  }
}

/** Entry observer of the IDEMPOTENCY instance: marks the current HTTP request as received. */
export function createMinimumVersionEntryObserver(): IdempotencyEntryObserver {
  return () => {
    const scope = MINIMUM_VERSION_SCOPE.getStore();
    if (scope !== undefined) scope.idempotencyEntered = true;
  };
}

/**
 * The post-miss hook of stage ④a: judges the HTTP request in MINIMUM_VERSION_SCOPE. Outside an
 * HTTP request (no store: not an app request, e.g. a job) there is nothing to judge.
 * With `readerOn`, the minimum is read on the claim's transaction (a fresh, uncached reader per
 * judgement), never through a second pooled connection; without it (no database: the check's
 * own reader fails closed) the check's reader is used.
 */
export function createMinimumVersionPostMissCheck(
  check: MinimumVersionCheck,
  readerOn?: MinimumVersionReaderOn,
): IdempotencyPostMissCheck {
  return async () => {
    const scope = MINIMUM_VERSION_SCOPE.getStore();
    if (scope === undefined) return;
    const trx = idempotencyPostMissTransaction();
    await check(
      scope.request,
      readerOn === undefined || trx === undefined ? undefined : readerOn(trx),
    );
  };
}
