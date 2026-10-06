// The request context of stage ② (规划/08 BR-ID-01 判定顺序 ② 令牌, BR-ID-07): the verified
// claims of the access token, attached by identity's token check at the pre-parsing registration
// point (./request-checks.ts) and copied onto the Fastify request for the handler and every later
// stage. Modules that need the caller (identity's handlers, B1-02g, risk) read it here, so they
// never import identity. Identity levels (phone / realname) are never part of it: they are judged
// from the database's current state by their own stages (BR-ID-01).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no `process.env`, no logging.
import type { SessionScope } from '@couli/contracts-ts';

/** Verified stage ② context; never populate this from request headers or JWT identity levels. */
export interface TokenPrincipal {
  readonly uid: string;
  readonly app_id: string;
  readonly sid: string;
  readonly device_id: string;
  readonly scp: SessionScope;
}

/** Where the registration point keeps the principal (RequestCheckInput and the Fastify request). */
export interface PrincipalCarrier {
  principal?: TokenPrincipal;
}

/**
 * Reads the principal attached by the existing preParsing request-check registration point:
 * undefined for an anonymous request (x-auth none, optional without a token, or a route outside
 * the contract). Works on the check input as well as on the Fastify request.
 */
export function tokenPrincipal(request: object): TokenPrincipal | undefined {
  const principal = (request as PrincipalCarrier).principal;
  return typeof principal === 'object' && principal !== null ? principal : undefined;
}
