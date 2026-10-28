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
// The rule tests in test/spec/platform/http/no-store/** import this file by path; names,
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
 * The onSend step: on a request that carries an identity, sets `Cache-Control: no-store` when the
 * reply has no Cache-Control yet; leaves a Cache-Control the route set, every other header and
 * every anonymous reply unchanged.
 */
export function applyNoStore(request: object, reply: NoStoreReply): void {
  if (!carriesIdentity(request) || reply.hasHeader(CACHE_CONTROL)) return;
  reply.header(CACHE_CONTROL, NO_STORE);
}
