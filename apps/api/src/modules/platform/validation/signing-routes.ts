// Which contract operations require the request signature headers (contracts/openapi.yaml
// `x-signed: true`; 04 §5 签名; 规划/08 BR-ID-09). The table is generated from the dereferenced
// contract by ./scripts/generate-signing-routes.ts (the same document ./scripts/
// generate-route-schemas.ts reads) and covers every operation, planned ones included; no openapi is
// parsed at run time. signing-routes.test.ts fails when the generated file drifts from the contract.
// The risk module's stage ① looks the matched Fastify route up here (through the platform index).
//
// This file is also compiled by the `test` project: erasable syntax only (no parameter properties,
// enums, namespaces or decorators), `import type` for type-only imports, relative imports with the
// `.ts` extension, no NestJS, no package import, no `process.env`.
import { CONTRACT_SIGNING_ROUTES } from './signing-routes.gen.ts';

export interface SigningRoute {
  readonly method: string;
  /** Fastify template, e.g. /v1/links/:link_id/open. */
  readonly path: string;
  readonly signed: boolean;
}

const ROUTES: readonly SigningRoute[] = Object.freeze(
  CONTRACT_SIGNING_ROUTES.map((route) => Object.freeze({ ...route })),
);
const routeKey = (method: string, path: string): string => `${method} ${path}`;
const DECLARED = new Set(ROUTES.map((route) => routeKey(route.method, route.path)));
const SIGNED = new Set(
  ROUTES.filter((route) => route.signed).map((route) => routeKey(route.method, route.path)),
);

/**
 * Build-time contract table, from the same dereferenced document as route schemas. Includes
 * all operations, including planned ones; missing x-signed means false. Frozen; never parses
 * openapi at request time.
 */
export function contractSigningRoutes(): readonly SigningRoute[] {
  return ROUTES;
}

/**
 * True when the contract operation of a matched route (request method + Fastify route template)
 * is `x-signed: true`. Fastify answers HEAD on a GET route with the GET handler
 * (exposeHeadRoutes), so a HEAD without its own operation is judged as that GET. An unmatched
 * route (no template) or a route outside the contract is not signed: contract.test.ts keeps every
 * registered route declared in the contract.
 */
export function isContractSignedRoute(method: string, routeTemplate: string | undefined): boolean {
  if (routeTemplate === undefined) return false;
  const upper = method.toUpperCase();
  if (DECLARED.has(routeKey(upper, routeTemplate))) {
    return SIGNED.has(routeKey(upper, routeTemplate));
  }
  return upper === 'HEAD' && SIGNED.has(routeKey('GET', routeTemplate));
}
