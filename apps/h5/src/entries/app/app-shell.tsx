import type { ReactElement } from 'react';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ApiProvider, createAppApi } from '../../shared/api/app-api.ts';
import { createQueryClient, createQueryProvider } from '../../shared/query.ts';
import { createAppRoutes } from './routes.ts';

/** Nothing is drawn while the first lazy route loads; native shows its own loading state. */
function HydrateFallback() {
  return null;
}

/**
 * Query provider, App API provider and React Router (lazy route modules), without an H5 title
 * bar. One API client per shell; it is null without bridge, app.getEnv, base URL or brand, and
 * pages then read null from useApi() and send nothing.
 */
export function createAppShell(): ReactElement {
  const router = createBrowserRouter([{ path: '/', HydrateFallback, children: createAppRoutes() }]);
  const api = createAppApi();
  return createQueryProvider(
    <ApiProvider api={api}>
      <RouterProvider router={router} />
    </ApiProvider>,
    createQueryClient(),
  );
}
