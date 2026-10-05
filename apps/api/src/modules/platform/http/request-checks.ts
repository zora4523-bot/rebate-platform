// Also compiled by the test project: erasable syntax only, import type for type-only
// imports, relative imports with .ts; no NestJS imports or decorators.
/** Verified by stage ①, before parsers, schema validation and later authentication stages. */
export interface VerifiedDevice {
  readonly deviceId: string;
  readonly appId: string;
}

export interface RequestCheckInput {
  readonly id: string;
  readonly method: string;
  /** Original origin-form URL, including the untouched query string. */
  readonly url: string;
  /** Fastify's matched route template; absent for an unmatched route. */
  readonly routeTemplate?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly rawBody: Buffer;
  verifiedDevice?: VerifiedDevice;
}

export type RequestCheck = (request: RequestCheckInput) => Promise<void>;
export interface CheckedRequest {
  verifiedDevice?: VerifiedDevice;
}

/**
 * Register before init/ready. Run checks in supplied order before body parsing; stop on error.
 * Bound raw-body buffering by the effective Fastify bodyLimit, replay identical bytes to the
 * parser, and copy verifiedDevice onto the request for subsequent authentication stages.
 * Overflow uses the existing 413/20001 body-error envelope, even for an invalid signature.
 */
export function installRequestChecks(server: object, checks: readonly RequestCheck[]): void {
  void server;
  void checks;
  throw new Error('NotImplemented: installRequestChecks');
}
