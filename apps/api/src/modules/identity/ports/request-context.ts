// Identity's implementations of the request-identity ports other modules define (B1-02m):
// catalog's ViewerContext, linking's CallerContext and linking's AttrCodeReader. They are written
// against structural shapes only, so identity never imports catalog or linking (规划/02 §4.1).
// Identity comes from what the request checks verified (BR-ATTR-05, BR-AI-03): stage ②'s token
// principal first, then stage ①'s verified device; request bodies, query strings and raw
// X-Device-Id / X-User-Id headers are never read.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { tokenPrincipal, type CheckedRequest } from '../../platform/index.ts';

/** Structural ports: identity does not depend on catalog or linking. */
export interface IdentityRequest extends CheckedRequest {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
}

export interface IdentityContext {
  current(): Promise<{
    readonly appId: string;
    readonly userId: string | null;
    readonly deviceId: string | null;
  }>;
}

export interface IdentityAttrCodeReader {
  attrCode(appId: string, userId: string): Promise<string | null>;
}

type Identity = Awaited<ReturnType<IdentityContext['current']>>;

/**
 * Resolved on every call from the request itself (never cached across requests):
 * - a verified token principal → its app_id, uid and device_id (another app's token was already
 *   refused by stage ③ with 10403; the principal's app_id is the only app scope read here);
 * - else a device verified by the signature check → a guest of that device's app;
 * - else a guest of the request's X-App-Id with no device; without an app scope it fails closed.
 */
function resolve(request: IdentityRequest): Promise<Identity> {
  const principal = tokenPrincipal(request);
  if (principal !== undefined) {
    return Promise.resolve({
      appId: principal.app_id,
      userId: principal.uid,
      deviceId: principal.device_id,
    });
  }
  const device = request.verifiedDevice;
  if (device !== undefined) {
    return Promise.resolve({ appId: device.appId, userId: null, deviceId: device.deviceId });
  }
  const appId = request.headers?.['x-app-id'];
  if (typeof appId === 'string' && appId !== '') {
    return Promise.resolve({ appId, userId: null, deviceId: null });
  }
  return Promise.reject(new Error('identity: request carries no app scope'));
}

function requestContext(request: IdentityRequest): IdentityContext {
  return { current: () => resolve(request) };
}

/** catalog's ViewerContext for one request. */
export function createIdentityViewerContext(request: IdentityRequest): IdentityContext {
  return requestContext(request);
}

/** linking's CallerContext for one request. */
export function createIdentityCallerContext(request: IdentityRequest): IdentityContext {
  return requestContext(request);
}

/** users.id is a uuid; anything else names no user (and must not reach PostgreSQL as 22P02). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * linking's AttrCodeReader (BR-ATTR-06): the user's attr_code in this app, read on every call
 * (no cache: a deleted account stops being attributable at once). A missing user, a user of
 * another app, a deleted account or an empty attr_code is unavailable (null) — never the user_id.
 * Database failures propagate unchanged.
 */
export function createIdentityAttrCodeReader(db: Kysely<DB>): IdentityAttrCodeReader {
  return {
    async attrCode(appId: string, userId: string): Promise<string | null> {
      if (!UUID.test(userId)) return null;
      const row = await db
        .withSchema('app')
        .selectFrom('users')
        .select('attr_code')
        .where('app_id', '=', appId)
        .where('id', '=', userId)
        .where('status', '<>', 'deleted')
        .executeTakeFirst();
      const code = row?.attr_code;
      return typeof code === 'string' && code !== '' && code !== userId ? code : null;
    },
  };
}
