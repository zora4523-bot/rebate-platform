// Which identity level each contract operation requires (contracts/openapi.yaml `x-auth`; 04 §5
// 鉴权级别; 规划/08 BR-ID-01). The table is generated from the dereferenced contract by
// ./scripts/generate-auth-routes.ts and covers every operation, planned ones included; no openapi
// is parsed at run time. auth-routes.test.ts fails when the generated file drifts from the
// contract. Identity's token stages ② ③ look the matched Fastify route up here (through the
// platform index): login / phone / realname need a token, optional reads one when sent, none
// never reads Authorization, and a route outside the contract (undefined) is left alone.
// admin / super are the admin console levels (contract info.description, admin_auth_level; an
// admin_token, not an app token). They belong to an admin token check, which does not exist yet:
// the app's stages ② ③ refuse them always (10001), and bootstrap refuses to register them.
//
// This file is also compiled by the `test` project: erasable syntax only (no parameter properties,
// enums, namespaces or decorators), `import type` for type-only imports, relative imports with the
// `.ts` extension, no NestJS, no package import, no `process.env`.
import { CONTRACT_AUTH_ROUTES } from './auth-routes.gen.ts';

export type ContractAuth = 'none' | 'optional' | 'login' | 'phone' | 'realname' | 'admin' | 'super';

export interface AuthRoute {
  readonly method: string;
  readonly path: string;
  readonly auth: ContractAuth;
}

const ROUTES: readonly AuthRoute[] = Object.freeze(
  CONTRACT_AUTH_ROUTES.map((route): AuthRoute => Object.freeze({ ...route })),
);
const routeKey = (method: string, path: string): string => `${method} ${path}`;
const AUTH: ReadonlyMap<string, ContractAuth> = new Map(
  ROUTES.map((route) => [routeKey(route.method, route.path), route.auth]),
);

/** Build-time generated from every OpenAPI operation, including planned operations. */
export function contractAuthRoutes(): readonly AuthRoute[] {
  return ROUTES;
}

/** HEAD falls back to GET only when HEAD has no explicit contract operation. */
export function contractAuthOf(method: string, template: string): ContractAuth | undefined {
  if (typeof method !== 'string' || typeof template !== 'string') return undefined;
  const upper = method.toUpperCase();
  const declared = AUTH.get(routeKey(upper, template));
  if (declared !== undefined) return declared;
  // Fastify answers HEAD on a GET route with the GET handler (exposeHeadRoutes).
  return upper === 'HEAD' ? AUTH.get(routeKey('GET', template)) : undefined;
}
