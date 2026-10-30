// B1-01zzq · Cache-Control: no-store on responses that carry a user's identity (orchestrator
// ruling D10-396 ③; 规划/03 §8.3).
//
// A request carries an identity when the request checks attached a verified one to it: the
// stage ② principal of an App access token or of an h5_token (`principal`, read with
// tokenPrincipal of ./token-context.ts) or a live admin session (`adminPrincipal`, read with
// adminPrincipal of ./admin-context.ts). Nothing else counts: an Authorization, X-User-Id or any
// other request header without a verified principal is an anonymous request.
//
// The response to a request that carries an identity answers `Cache-Control: no-store`, unless
// the route already set a Cache-Control of its own (any value, any letter case of the name):
// that value is kept as it is. The response to an anonymous request is left untouched.
// bootstrap's createHttpApp applies it from its existing global onSend hook, on every HTTP entry,
// so error envelopes and responses without a body are covered as well.
//
// B1-15y · the share page routes (BR-ATTR-10 细则「缓存」; contract NoStoreClientError /
// NoStoreServerError): every response of GET /v1/share-pages/:link_id and of
// POST /v1/share-pages/:link_id/tpwd answers `Cache-Control: no-store`, whoever asks, including the
// requests the route schema or a request check refuses before the controller runs. The route is
// told by the request's method and its Fastify route template (`request.method`,
// `request.routeOptions.url`), never by the concrete URL; a request without a template (unmatched,
// 404) is not one. On those routes a Cache-Control the route set is kept as for an identity (the
// handlers set no-store themselves). Every other anonymous response stays untouched, and the rule
// for requests that carry an identity is unchanged.
//
// The rule tests in test/spec/platform/http/no-store/** and
// test/spec/platform/http/share-page-no-store/** import this file by path; names,
// signatures and the semantics written here are the contract.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no `process.env`, no logging.
import { adminPrincipal } from './admin-context.ts';
import { tokenPrincipal } from './token-context.ts';

const CACHE_CONTROL = 'Cache-Control';
const NO_STORE = 'no-store';

/** The parts of the Fastify reply the onSend step reads and writes (names are case-insensitive). */
export interface NoStoreReply {
  hasHeader(name: string): boolean;
  getHeader(name: string): unknown;
  header(name: string, value: string): unknown;
}

/**
 * True when the request checks attached a verified identity to the request (a `principal` or an
 * `adminPrincipal` object); false for an anonymous request. Works on the Fastify request.
 */
export function carriesIdentity(request: object): boolean {
  return tokenPrincipal(request) !== undefined || adminPrincipal(request) !== undefined;
}

/**
 * B1-15y: true for the routes whose every response is no-store whoever asks — exactly
 * (`GET`, `/v1/share-pages/:link_id`) and (`POST`, `/v1/share-pages/:link_id/tpwd`), compared as
 * the method (upper case, as Fastify gives it) and the Fastify route template. Any other method or
 * template, a concrete URL, an empty or missing template is false.
 */
export function isNoStoreRoute(method: string, template: string | undefined): boolean {
  void method;
  void template;
  throw new Error('NotImplemented: isNoStoreRoute');
}

/**
 * The onSend step: on a request that carries an identity, or on a no-store route (isNoStoreRoute
 * of `request.method` and `request.routeOptions.url`), sets `Cache-Control: no-store` when the
 * reply has no Cache-Control yet; leaves a Cache-Control the route set, every other header and
 * every other anonymous reply unchanged.
 */
export function applyNoStore(request: object, reply: NoStoreReply): void {
  if (!carriesIdentity(request) || reply.hasHeader(CACHE_CONTROL)) return;
  reply.header(CACHE_CONTROL, NO_STORE);
}
