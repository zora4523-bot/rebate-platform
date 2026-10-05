export interface SigningRoute {
  readonly method: string;
  /** Fastify template, e.g. /v1/links/:link_id/open. */
  readonly path: string;
  readonly signed: boolean;
}

/**
 * Build-time contract table, from the same dereferenced document as route schemas. Includes
 * all operations, including planned ones; missing x-signed means false. The implementation
 * must extend the existing codegen/check entry, never parse openapi at request time.
 */
export function contractSigningRoutes(): readonly SigningRoute[] {
  throw new Error('NotImplemented: contractSigningRoutes');
}
