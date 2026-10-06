import { bridge } from '@couli/contracts-ts';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { RetryPage } from '../../components/retry/index.ts';

export interface H5Route {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  errorElement?: ReactNode;
  ErrorBoundary?: ComponentType;
  HydrateFallback?: ComponentType;
}

export interface AppRouteOptions {
  /** Retry action of the error page; defaults to reloading the current URL (tests inject one). */
  reload?: () => void;
}

/**
 * Lazy page module per route path. Business pages (F1-03 and later) add an entry keyed by the
 * generated path, e.g. `[bridge.routes.Rules.h5_path]: () => import('./pages/rules.tsx')`.
 */
const pages: Readonly<Partial<Record<string, H5Route['lazy']>>> = {};

/** Every route without its own page yet shares one lazily loaded placeholder chunk. */
const pagePending: H5Route['lazy'] = () => import('./pages/page-pending.tsx');

/**
 * Nothing is drawn while a route chunk loads (native shows its own loading state). Declared on
 * each route on purpose: a rejected `lazy` stays set on the route, and React Router then cuts the
 * render at the nearest HydrateFallback; with one here the route itself stays rendered, so its
 * errorElement shows instead of a blank page.
 */
function RouteFallback(): null {
  return null;
}

function reloadCurrentPage(): void {
  window.location.reload();
}

/**
 * Generated contract h5 routes only; each lazy module initially renders a placeholder. A failed
 * route chunk or a render error shows the H5 retry page (StateLoadFailed); retry reloads the
 * current route. Error details never reach the page.
 */
export function createAppRoutes(options: AppRouteOptions = {}): H5Route[] {
  const reload = options.reload ?? reloadCurrentPage;
  const errorElement = createElement(RetryPage, { onRetry: () => reload() });
  const result: H5Route[] = [];
  for (const route of Object.values(bridge.routes)) {
    if (route.kind !== 'h5' || route.h5_path === null) continue;
    result.push({
      path: route.h5_path,
      lazy: pages[route.h5_path] ?? pagePending,
      errorElement,
      HydrateFallback: RouteFallback,
    });
  }
  return result;
}
