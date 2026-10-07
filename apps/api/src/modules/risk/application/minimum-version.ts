import type { ClientPlatform } from '@couli/contracts-ts';
import type { TokenPrincipal } from '../../platform/index.ts';

/** B1-03c: content implements this port; app.module supplies it. No content dependency here. */
export interface MinimumVersionReader {
  minSupportedVersion(
    appId: string,
    platform: ClientPlatform,
    channel: string,
  ): Promise<string | null>;
}

/** Parsed HTTP request after stages ①–③; principal is read through tokenPrincipal. */
export interface MinimumVersionRequest {
  readonly id: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly routeOptions: { readonly url?: string };
  readonly body?: unknown;
  readonly principal?: TokenPrincipal;
}

export type MinimumVersionCheck = (request: MinimumVersionRequest) => Promise<void>;

/**
 * Stage ④a. Resolve on permission; reject with an HTTP 403 HttpException whose contract
 * envelope has code 10405, this request's trace_id and data.min_supported_version (nullable).
 * Reuse platform's client version comparison. A reader failure must not become permission.
 */
export function createMinimumVersionCheck(versions: MinimumVersionReader): MinimumVersionCheck {
  void versions;
  throw new Error('NotImplemented: createMinimumVersionCheck');
}

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
  throw new Error('NotImplemented: contractMinimumVersionRoutes');
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
  void check;
  throw new Error('NotImplemented: createMinimumVersionGuard');
}
