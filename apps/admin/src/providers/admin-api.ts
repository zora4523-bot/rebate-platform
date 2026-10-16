import type { PermissionSnapshot } from './access-control/index.ts';
import type { AdminAuthProvider, AuthClock, AuthStorage } from './auth/index.ts';
import type { AdminDataProvider } from './data/index.ts';

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

export function createAdminApi(options: AdminApiOptions): AdminApi {
  void options;
  throw new Error('NotImplemented: createAdminApi');
}
