// Admin app root (规划/03 §9.1): Ant Design theme, router, Refine (telemetry off) and the shell
// layout, wired to the /admin/v1 data provider and the CASL access control. Permissions come from
// the injected provider; menus are hidden by permission key and the server checks every action
// again.
import './styles/admin.css';
import {
  Refine,
  type AccessControlProvider,
  type AuthProvider,
  type DataProvider,
  type ResourceProps,
} from '@refinedev/core';
import routerProvider from '@refinedev/react-router';
import { ConfigProvider } from 'antd';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  BrowserRouter,
  MemoryRouter,
  Navigate,
  useLocation,
  useNavigate,
  type InitialEntry,
} from 'react-router';
import { LoadFailedPage, NoPermissionPage, PagePending, WelcomePage } from './layout/pages.tsx';
import { Sidebar } from './layout/Sidebar.tsx';
import { TopBar } from './layout/TopBar.tsx';
import { LoginPage } from './pages/login/index.ts';
import {
  createAccessControl,
  permissionsFromMe,
  type AccessControl,
  type PermissionSnapshot,
  type PermissionsProvider,
} from './providers/access-control/index.ts';
import { createRefineAccessControl } from './providers/access-control/refine.ts';
import { createAuthProvider, type AdminAuthProvider } from './providers/auth/index.ts';
import { createDataProvider } from './providers/data/index.ts';
import {
  findMenuItem,
  getAdminMenuGroups,
  selectAdminMenuGroups,
  type AdminMenuGroup,
} from './resources/index.ts';
import type { AdminShellOptions } from './shell-options.ts';
import { shellTexts } from './texts/shell.ts';
import { createAntdTheme } from './theme.ts';

type PermissionState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly snapshot: PermissionSnapshot }
  | { readonly status: 'failed' };

const NO_GROUPS: readonly AdminMenuGroup[] = [];

// Refine resources: one per menu, nested under its group (for later Refine menus and hooks).
const RESOURCES: ResourceProps[] = getAdminMenuGroups().flatMap((group) => [
  { name: group.key, meta: { label: group.label } },
  ...group.items.map((item) => ({
    name: item.id,
    list: `/${item.id}`,
    meta: { label: item.label, parent: group.key },
  })),
]);

function initialEntry(route: AdminShellOptions['initialRoute']): InitialEntry {
  if (route === undefined) return '/';
  return { pathname: `/${route.menuId}`, state: { subpage: route.subpage } };
}

function subpageOf(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null || !('subpage' in state)) return undefined;
  return typeof state.subpage === 'string' ? state.subpage : undefined;
}

/**
 * Shell options plus the REST data provider (providers/data) and the login guard
 * (providers/auth). Without a data provider, the app talks to /admin/v1 on its own origin with
 * the admin_token of the guard. Without an auth provider, the browser router (the real entry,
 * main.tsx) still gets one (sessionStorage session, permissions from /admin/v1/me/permissions);
 * the memory router (tests, embedding) then shows the shell for the injected account.
 */
export interface AdminAppOptions extends AdminShellOptions {
  readonly dataProvider?: DataProvider;
  readonly authProvider?: AdminAuthProvider;
}

function defaultAuthProvider(): AdminAuthProvider {
  return createAuthProvider({
    api: { baseUrl: window.location.origin, fetch: (input, init) => globalThis.fetch(input, init) },
  });
}

/** Success is HTTP 200 with code 0; only that extends the idle period (BR-ID-34). */
async function recordIfSucceeded(response: Response, auth: AdminAuthProvider): Promise<void> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'code' in body && body.code === 0)
      auth.recordSuccessfulRequest();
  } catch {
    // Not an envelope: the data provider reports it; the idle period is not extended.
  }
}

function defaultDataProvider(auth: AdminAuthProvider | undefined): DataProvider {
  return createDataProvider({
    baseUrl: window.location.origin,
    fetch: async (input, init) => {
      const response = await globalThis.fetch(input, init);
      if (auth !== undefined && response.status === 200)
        void recordIfSucceeded(response.clone(), auth);
      return response;
    },
    getToken: () => auth?.getToken() ?? null,
    onError: (error) => {
      // 10001 without a reason ends the session; the guard then shows the login page.
      void auth?.onError(error);
    },
  });
}

const subscribeNothing = (): (() => void) => () => undefined;

/** Memory router without a guard (tests, embedding): the host owns the account. */
const HOST_AUTH: AuthProvider = {
  login: () => Promise.resolve({ success: false }),
  logout: () => Promise.resolve({ success: true }),
  check: () => Promise.resolve({ authenticated: true }),
  onError: () => Promise.resolve({}),
};

/** Login route: any other address while signed out shows the login page at /login. */
function LoginRoute({
  auth,
  environment,
  onComplete,
}: {
  readonly auth: AdminAuthProvider;
  readonly environment: AdminShellOptions['environment'];
  readonly onComplete: () => void;
}) {
  const location = useLocation();
  return (
    <>
      {location.pathname === '/login' ? null : <Navigate to="/login" replace />}
      <LoginPage authProvider={auth} environment={environment} onComplete={onComplete} />
    </>
  );
}

/** Builds the admin app element; the caller mounts it (main.tsx, tests). */
export function createAdminShell(options: AdminAppOptions): ReactElement {
  return <AdminApp options={options} />;
}

interface ShellRouterProps {
  readonly kind: NonNullable<AdminShellOptions['router']>;
  readonly initialRoute: AdminShellOptions['initialRoute'];
  readonly children: ReactNode;
}

// BrowserRouter rather than HashRouter: plain paths (/withdrawals) for deep links and the
// audit log; the admin host serves index.html for unknown paths (Vite dev server does already).
function ShellRouter({ kind, initialRoute, children }: ShellRouterProps) {
  const [initialEntries] = useState(() => [initialEntry(initialRoute)]);
  if (kind === 'browser') {
    return <BrowserRouter basename={import.meta.env.BASE_URL}>{children}</BrowserRouter>;
  }
  return <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>;
}

function AdminApp({ options }: { readonly options: AdminAppOptions }) {
  const [theme] = useState(() => createAntdTheme());
  const [ownAuth] = useState(() =>
    options.authProvider === undefined && options.router === 'browser'
      ? defaultAuthProvider()
      : undefined,
  );
  const auth = options.authProvider ?? ownAuth;
  const [dataProvider] = useState(() => options.dataProvider ?? defaultDataProvider(auth));
  const [state, setState] = useState<PermissionState>({ status: 'loading' });
  const [signedInName, setSignedInName] = useState<string | undefined>(undefined);
  const latestRequest = useRef(0);

  // Guard: the shell shows only with a live session that finished the login steps here (the
  // binding page keeps its 「进入后台」 step) or was restored from this tab's session.
  const subscribe = useMemo(() => auth?.subscribe ?? subscribeNothing, [auth]);
  const authenticated = useSyncExternalStore(
    subscribe,
    () => auth === undefined || auth.getToken() !== null,
    () => auth === undefined,
  );
  const [entered, setEntered] = useState(authenticated);
  const [landing, setLanding] = useState(false);
  if (!authenticated && entered) setEntered(false);
  const signedIn = auth === undefined || (authenticated && entered);

  // With its own guard the app reads permissions (and the account name) from /me/permissions.
  const permissionsProvider = useMemo<PermissionsProvider>(() => {
    if (ownAuth === undefined) return options.permissionsProvider;
    return async () => {
      const me = await ownAuth.getIdentity();
      if (me === null) throw new Error('admin session ended');
      setSignedInName(me.username);
      return permissionsFromMe(me);
    };
  }, [ownAuth, options.permissionsProvider]);
  const account =
    signedInName === undefined
      ? options.account
      : { username: signedInName, displayName: signedInName };

  // Each load (first render, 刷新权限) asks the provider again; only the latest answer counts.
  const loadPermissions = useCallback(() => {
    latestRequest.current += 1;
    const request = latestRequest.current;
    void permissionsProvider().then(
      (snapshot) => {
        if (request === latestRequest.current) setState({ status: 'ready', snapshot });
      },
      () => {
        // A failed refresh keeps the menus already shown; a failed first load shows a retry.
        if (request !== latestRequest.current) return;
        setState((previous) => (previous.status === 'ready' ? previous : { status: 'failed' }));
      },
    );
  }, [permissionsProvider]);

  // Permissions load only for a signed-in account; signing out drops the old answer.
  const [wasSignedIn, setWasSignedIn] = useState(signedIn);
  if (wasSignedIn !== signedIn) {
    setWasSignedIn(signedIn);
    if (!signedIn) {
      setState({ status: 'loading' });
      setSignedInName(undefined);
    }
  }
  useEffect(() => {
    if (signedIn) loadPermissions();
    else latestRequest.current += 1;
  }, [signedIn, loadPermissions]);

  const onLogout = useCallback(() => {
    if (ownAuth !== undefined) void ownAuth.logout({});
    else void options.onLogout();
  }, [ownAuth, options]);

  const access = useMemo(
    () => (state.status === 'ready' ? createAccessControl(state.snapshot) : undefined),
    [state],
  );
  const groups = useMemo(
    () => (state.status === 'ready' ? selectAdminMenuGroups(state.snapshot) : NO_GROUPS),
    [state],
  );
  const accessControlProvider = useMemo<AccessControlProvider>(
    () => createRefineAccessControl(access, groups),
    [access, groups],
  );

  return (
    <ConfigProvider theme={theme}>
      <ShellRouter kind={options.router ?? 'memory'} initialRoute={options.initialRoute}>
        <Refine
          routerProvider={routerProvider}
          resources={RESOURCES}
          dataProvider={dataProvider}
          accessControlProvider={accessControlProvider}
          authProvider={auth ?? HOST_AUTH}
          options={{ disableTelemetry: true }}
        >
          {signedIn || auth === undefined ? (
            <ShellFrame
              options={options}
              account={account}
              state={state}
              access={access}
              groups={groups}
              landing={landing}
              onLanded={() => setLanding(false)}
              onRefresh={loadPermissions}
              onLogout={onLogout}
            />
          ) : (
            <LoginRoute
              auth={auth}
              environment={options.environment}
              onComplete={() => {
                setLanding(true);
                setEntered(true);
              }}
            />
          )}
        </Refine>
      </ShellRouter>
    </ConfigProvider>
  );
}

interface ShellFrameProps {
  readonly options: AdminShellOptions;
  readonly state: PermissionState;
  readonly access: AccessControl | undefined;
  readonly groups: readonly AdminMenuGroup[];
  readonly account: AdminShellOptions['account'];
  /** Just signed in: open the first permitted menu, or the home page without permission keys. */
  readonly landing: boolean;
  readonly onLanded: () => void;
  readonly onRefresh: () => void;
  readonly onLogout: () => void;
}

function ShellFrame({
  options,
  state,
  access,
  groups,
  account,
  landing,
  onLanded,
  onRefresh,
  onLogout,
}: ShellFrameProps) {
  const location = useLocation();
  const navigate = useNavigate();

  // The router may apply the navigation in a transition: landing ends only once the address is the
  // landing page, so the old address (/login) never renders and redirects home in the meantime.
  useEffect(() => {
    if (!landing || state.status === 'loading') return;
    let target = '/';
    if (state.status === 'ready') {
      const { snapshot } = state;
      const first = groups[0]?.items[0];
      const empty = !snapshot.isSuper && snapshot.permissions.length === 0;
      if (!empty && first !== undefined) target = `/${first.id}`;
    }
    if (location.pathname !== target) {
      void navigate(target, { replace: true });
      return;
    }
    onLanded();
  }, [landing, state, groups, navigate, onLanded, location.pathname]);

  const menuId = location.pathname.replace(/^\/+/, '');
  const match = findMenuItem(groups, menuId);
  const subpage = match === undefined ? undefined : subpageOf(location.state);
  const crumbs =
    match === undefined
      ? [shellTexts.welcomeCrumb]
      : [match.group.label, match.item.label, ...(subpage === undefined ? [] : [subpage])];

  let content: ReactNode = (
    <p className="admin-secondary" role="status">
      {shellTexts.loading}
    </p>
  );
  if (landing) {
    // Keep the loading line until the landing page is chosen (no flash of the old address).
  } else if (state.status === 'failed') {
    content = <LoadFailedPage onRetry={onRefresh} />;
  } else if (state.status === 'ready' && access !== undefined) {
    const { snapshot } = state;
    if (match !== undefined && options.renderPage !== undefined) {
      content = options.renderPage(match.item.id, access);
    } else if (match !== undefined) {
      content = <PagePending title={match.item.label} />;
    } else if (menuId !== '') {
      // Unknown or no longer permitted menu (e.g. after 刷新权限): back to the home page.
      content = <Navigate to="/" replace />;
    } else if (!snapshot.isSuper && snapshot.permissions.length === 0) {
      content = (
        <NoPermissionPage
          username={account.username}
          displayName={account.displayName}
          permissionCount={snapshot.permissions.length}
          onRefresh={onRefresh}
        />
      );
    } else {
      content = <WelcomePage />;
    }
  }

  return (
    <div className="admin-shell">
      <Sidebar groups={groups} activeId={match?.item.id} />
      <div className="admin-column">
        <TopBar
          crumbs={crumbs}
          environment={options.environment}
          displayName={account.displayName}
          onLogout={onLogout}
        />
        <main className="admin-content" aria-busy={state.status === 'loading'}>
          {content}
        </main>
      </div>
    </div>
  );
}
