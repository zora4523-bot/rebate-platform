// One place that wires the admin console to /admin/v1 (CT-02f): the login guard (providers/auth),
// the REST data provider (providers/data) carrying the guard's admin_token, and the permission
// load from /admin/v1/me/permissions. Only HTTP 200 with code 0 extends the idle period
// (BR-ID-34); a data error goes to the guard, which ends the session on 10001 without a reason.
import { permissionsFromMe, type PermissionSnapshot } from './access-control/index.ts';
import {
  createAuthProvider,
  type AdminAuthProvider,
  type AuthClock,
  type AuthStorage,
} from './auth/index.ts';
import { createDataProvider, type AdminDataProvider } from './data/index.ts';

export interface AdminApiOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly storage?: AuthStorage;
  readonly clock?: AuthClock;
  readonly manualStart?: boolean;
}

export interface AdminApi {
  readonly auth: AdminAuthProvider;
  readonly data: AdminDataProvider;
  loadPermissions(): Promise<{ snapshot: PermissionSnapshot; username: string }>;
}

export interface AdminDataOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  /** The guard whose token the requests carry; without one, requests go unauthenticated. */
  readonly auth?: AdminAuthProvider | undefined;
}

/** Success is HTTP 200 with code 0; only that extends the idle period (BR-ID-34). */
async function recordIfSucceeded(response: Response, auth: AdminAuthProvider): Promise<void> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'code' in body && body.code === 0)
      auth.recordSuccessfulRequest();
  } catch {
    // Not an envelope: the data provider reports it; the idle period is not extended.
  }
}

/** The REST data provider for /admin/v1, tied to the guard's token and error handling. */
export function createAdminDataProvider(options: AdminDataOptions): AdminDataProvider {
  const { auth } = options;
  return createDataProvider({
    baseUrl: options.baseUrl,
    fetch: async (input, init) => {
      const response = await options.fetch(input, init);
      // Read from a copy before handing the response on, so the idle period is extended by the
      // time the caller sees the answer.
      if (auth !== undefined && response.status === 200)
        await recordIfSucceeded(response.clone(), auth);
      return response;
    },
    getToken: () => auth?.getToken() ?? null,
    onError: (error) => {
      // 10001 without a reason ends the session; the guard then shows the login page.
      void auth?.onError(error);
    },
  });
}

export function createAdminApi(options: AdminApiOptions): AdminApi {
  const auth = createAuthProvider({
    api: { baseUrl: options.baseUrl, fetch: options.fetch },
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.manualStart === undefined ? {} : { manualStart: options.manualStart }),
  });
  const data = createAdminDataProvider({ baseUrl: options.baseUrl, fetch: options.fetch, auth });
  return {
    auth,
    data,
    async loadPermissions() {
      // Every load (first render, 刷新权限) asks the server again, never the cached answer.
      const me = await auth.getIdentity({ refresh: true });
      if (me === null) throw new Error('admin session ended');
      return { snapshot: permissionsFromMe(me), username: me.username };
    },
  };
}
