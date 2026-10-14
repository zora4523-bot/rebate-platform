// The request context of the admin token check (F1-06k; 08 BR-ID-34; 02 §12.1 admin_token): the
// verified admin session, attached by admin's request check at the pre-parsing registration point
// (./request-checks.ts) and copied onto the Fastify request for the admin entry's handlers. It is
// never filled from request headers: only a verified admin_token whose session is live sets it.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no `process.env`, no logging.

/** A verified admin session (admin_users.id, its app, the token's jti, super or not). */
export interface AdminPrincipal {
  readonly adminId: string;
  readonly appId: string;
  /** The jti of the admin_token: the session that logout revokes. */
  readonly sessionId: string;
  readonly isSuper: boolean;
}

/** Where the registration point keeps the admin principal (check input and Fastify request). */
export interface AdminPrincipalCarrier {
  adminPrincipal?: AdminPrincipal;
}

/**
 * Reads the admin principal attached by the admin token check: undefined for a request no admin
 * token was verified on (x-auth none, or any route of the other entries).
 */
export function adminPrincipal(request: object): AdminPrincipal | undefined {
  const principal = (request as AdminPrincipalCarrier).adminPrincipal;
  return typeof principal === 'object' && principal !== null ? principal : undefined;
}
