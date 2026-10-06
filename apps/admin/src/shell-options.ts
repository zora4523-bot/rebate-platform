import type { ReactNode } from 'react';
import type { PermissionsProvider } from './providers/access-control/index.ts';

export type AdminEnvironment = 'production' | 'staging' | 'development' | 'test';

export interface AdminShellOptions {
  readonly permissionsProvider: PermissionsProvider;
  readonly account: { readonly username: string; readonly displayName: string };
  readonly environment: AdminEnvironment;
  readonly onLogout: () => void | Promise<void>;
  readonly initialRoute?: { readonly menuId: string; readonly subpage?: string };
  readonly renderPage?: (menuId: string) => ReactNode;
}
