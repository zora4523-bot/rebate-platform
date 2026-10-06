import type { ComponentType, ReactNode } from 'react';

export interface H5Route {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  errorElement?: ReactNode;
  ErrorBoundary?: ComponentType;
}

export interface AppRouteOptions {
  reload?: () => void;
}

/** Generated contract h5 routes only; each lazy module initially renders a placeholder. */
export function createAppRoutes(options?: AppRouteOptions): H5Route[] {
  void options;
  throw new Error('NotImplemented: createAppRoutes');
}
