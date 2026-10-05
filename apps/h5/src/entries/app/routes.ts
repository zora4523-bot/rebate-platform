import { bridge } from '@couli/contracts-ts';
import type { ComponentType } from 'react';

export interface H5Route {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
}

/**
 * Lazy page module per route path. Business pages (F1-03 and later) add an entry keyed by the
 * generated path, e.g. `[bridge.routes.Rules.h5_path]: () => import('./pages/rules.tsx')`.
 */
const pages: Readonly<Partial<Record<string, H5Route['lazy']>>> = {};

/** Every route without its own page yet shares one lazily loaded placeholder chunk. */
const pagePending: H5Route['lazy'] = () => import('./pages/page-pending.tsx');

/** Generated contract h5 routes only; each lazy module initially renders a placeholder. */
export function createAppRoutes(): H5Route[] {
  const result: H5Route[] = [];
  for (const route of Object.values(bridge.routes)) {
    if (route.kind !== 'h5' || route.h5_path === null) continue;
    result.push({ path: route.h5_path, lazy: pages[route.h5_path] ?? pagePending });
  }
  return result;
}
