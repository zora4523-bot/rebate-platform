import { on } from '@couli/bridge-sdk';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ApiProvider, createAppApi, type AppApiClient } from '../../shared/api/app-api.ts';
import { clearAccountData, createQueryClient, createQueryProvider } from '../../shared/query.ts';
import { createAppRoutes } from './routes.ts';

type AppRouter = ReturnType<typeof createBrowserRouter>;
type RouterLocation = AppRouter['state']['location'];

/** Nothing is drawn while the first lazy route loads; native shows its own loading state. */
function HydrateFallback() {
  return null;
}

interface AccountSession {
  /** Bumped on every auth.changed; the page tree is remounted under the new value. */
  epoch: number;
  /** After a logout: the location the page tree was taken down at (null while signed in). */
  parkedAt: RouterLocation | null;
}

interface AccountScopeProps {
  router: AppRouter;
  api: AppApiClient | null;
  client: QueryClient;
}

/**
 * The shell's single auth.changed subscription (account switch or logout in the same WebView),
 * mounted with the shell and independent of any page. On each event: drop the H5 token and any
 * acquisition in flight, cancel and clear the whole query cache, and remount the page tree so no
 * page keeps showing the previous account's data. A new login remounts at once and the page
 * fetches again with a new token; a logout leaves the page tree down (no automatic request or
 * token call) until native navigates elsewhere or signs in again.
 */
function AccountScope({ router, api, client }: AccountScopeProps): ReactElement | null {
  const [session, setSession] = useState<AccountSession>({ epoch: 0, parkedAt: null });
  useEffect(
    () =>
      on('auth.changed', ({ logged_in: loggedIn }) => {
        api?.invalidateToken();
        clearAccountData(client);
        const parkedAt = loggedIn ? null : router.state.location;
        setSession((current) => ({ epoch: current.epoch + 1, parkedAt }));
      }),
    [api, client, router],
  );
  // The router keeps tracking history while its provider is unmounted; any completed navigation
  // yields a new location object and brings the page tree back.
  const location = useSyncExternalStore(router.subscribe, () => router.state.location);
  if (session.parkedAt !== null && session.parkedAt === location) return null;
  return <RouterProvider key={session.epoch} router={router} />;
}

/**
 * Query provider, App API provider and React Router (lazy route modules), without an H5 title
 * bar. One API client per shell; it is null without bridge, app.getEnv, base URL or brand, and
 * pages then read null from useApi() and send nothing.
 */
export function createAppShell(): ReactElement {
  const router = createBrowserRouter([{ path: '/', HydrateFallback, children: createAppRoutes() }]);
  const api = createAppApi();
  const client = createQueryClient();
  return createQueryProvider(
    <ApiProvider api={api}>
      <AccountScope router={router} api={api} client={client} />
    </ApiProvider>,
    client,
  );
}
