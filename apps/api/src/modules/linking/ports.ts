// The three ports linking defines (B1-06c). Each abstract class is both the type and the Nest
// injection token.
//   CallerContext       identity implements, wired by B1-02m; until then every caller is a guest
//                       of the server-side app and device scope (BR-ATTR-05: identity comes only
//                       from the server, never from request fields).
//   AttrCodeReader      identity implements, wired by B1-02m; until then attr_code is unavailable
//                       for every app and user. null is never replaced by a user_id (BR-ATTR-06).
//   LinkingConfigReader content's ContentReader (F1-02b), wired in app.module.ts so linking never
//                       imports content.
import type { DB } from '@couli/db';

export interface Caller {
  readonly appId: string;
  readonly userId: string | null;
  readonly deviceId: string | null;
}

export abstract class CallerContext {
  abstract current(): Promise<Caller>;
}

/** null means unavailable; it must never be replaced with a user ID. */
export abstract class AttrCodeReader {
  abstract attrCode(appId: string, userId: string): Promise<string | null>;
}

/** Structural match for content's configValue port, wired at the composition root. */
export abstract class LinkingConfigReader {
  abstract configValue(
    appId: string,
    key: string,
  ): Promise<{ readonly value: DB['config_items']['value']; readonly version: number } | null>;
}

class GuestCallerContext extends CallerContext {
  readonly #caller: Caller;

  constructor(appId: string, deviceId: string | null) {
    super();
    this.#caller = Object.freeze({ appId, userId: null, deviceId });
  }

  current(): Promise<Caller> {
    return Promise.resolve({ ...this.#caller });
  }
}

/**
 * The default until identity is wired (B1-02m): always a guest (userId null) of the app and device
 * scope captured here. Any user id the scope carries, now or later, is ignored.
 */
export function createGuestCallerContext(scope: {
  readonly appId: string;
  readonly deviceId: string | null;
}): CallerContext {
  return new GuestCallerContext(scope.appId, scope.deviceId);
}

class UnavailableAttrCodeReader extends AttrCodeReader {
  attrCode(appId: string, userId: string): Promise<string | null> {
    void appId;
    void userId;
    return Promise.resolve(null);
  }
}

/** The default until identity is wired: attr_code is unavailable for every app and user. */
export function createUnavailableAttrCodeReader(): AttrCodeReader {
  return new UnavailableAttrCodeReader();
}
