import type { ReactNode } from 'react';
import type { AccessControl, PermissionsProvider } from './providers/access-control/index.ts';

export type AdminEnvironment = 'production' | 'staging' | 'development' | 'test';

export interface AdminShellOptions {
  readonly permissionsProvider: PermissionsProvider;
  readonly account: { readonly username: string; readonly displayName: string };
  readonly environment: AdminEnvironment;
  readonly onLogout: () => void | Promise<void>;
  /**
   * `browser` (main.tsx): the address bar and history follow the menus, one path per menu under
   * Vite's base URL. `memory` (default; tests and embedding): routes live in memory and start at
   * `initialRoute`, which `browser` ignores (the URL decides).
   */
  readonly router?: 'browser' | 'memory';
  readonly initialRoute?: { readonly menuId: string; readonly subpage?: string };
  /** Page for a permitted menu; `access` answers button-level permission checks. */
  readonly renderPage?: (menuId: string, access: AccessControl) => ReactNode;
}
