import type { ReactElement } from 'react';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { createQueryClient, createQueryProvider } from '../../shared/query.ts';
import { createAppRoutes } from './routes.ts';

/** Nothing is drawn while the first lazy route loads; native shows its own loading state. */
function HydrateFallback() {
  return null;
}

/** Query provider and React Router (lazy route modules), without an H5 title bar. */
export function createAppShell(): ReactElement {
  const router = createBrowserRouter([{ path: '/', HydrateFallback, children: createAppRoutes() }]);
  return createQueryProvider(<RouterProvider router={router} />, createQueryClient());
}
