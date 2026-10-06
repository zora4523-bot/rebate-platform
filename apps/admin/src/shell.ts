import type { ReactElement, ReactNode } from 'react';
import type { PermissionsProvider } from './providers/access-control/index.ts';

export interface AdminShellOptions {
  readonly permissionsProvider: PermissionsProvider;
  readonly account: { readonly username: string; readonly displayName: string };
  readonly environment: 'production' | 'staging' | 'development' | 'test';
  readonly onLogout: () => void | Promise<void>;
  readonly initialRoute?: { readonly menuId: string; readonly subpage?: string };
  readonly renderPage?: (menuId: string) => ReactNode;
}

// The implementation re-exports its factory from App.tsx here. Navigation exposes links and
// group headings in a named landmark; breadcrumb items use an ordered list in another landmark.
export function createAdminShell(options: AdminShellOptions): ReactElement {
  void options;
  throw new Error('NotImplemented: createAdminShell');
}
