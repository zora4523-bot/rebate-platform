import type { ComponentType } from 'react';

export interface H5Route {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
}

/** Generated contract h5 routes only; each lazy module initially renders a placeholder. */
export function createAppRoutes(): H5Route[] {
  throw new Error('NotImplemented: createAppRoutes');
}
