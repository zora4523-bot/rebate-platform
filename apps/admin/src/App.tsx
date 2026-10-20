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
import { ConfigProvider, Layout, Typography, type ThemeConfig } from 'antd';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
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
import { AdminsPage } from './pages/admins/index.ts';
import { ClaimReviewPage, ClaimsPage } from './pages/claims/index.ts';
import { ConfigCenterPage } from './pages/config-center/index.ts';
import { DashboardPage, dashboardTargetOf } from './pages/dashboard/index.ts';
import { HomeConfigPage } from './pages/home-config/index.ts';
import { KillSwitchesPage } from './pages/kill-switches/index.ts';
import { PlatformIconsPage } from './pages/platform-icons/index.ts';
import { UsersPage } from './pages/users/index.ts';
import { UserDetailView } from './pages/users/UserDetailView.tsx';
import { LoginPage } from './pages/login/index.ts';
import {
  createAccessControl,
  type AccessControl,
  type PermissionSnapshot,
  type PermissionsProvider,
} from './providers/access-control/index.ts';
import { createRefineAccessControl } from './providers/access-control/refine.ts';
import { createAdminApi, createAdminDataProvider, type AdminApi } from './providers/admin-api.ts';
import type { AdminAuthProvider } from './providers/auth/index.ts';
import {
  DASHBOARD_MENU_ID,
  findMenuItem,
  getAdminMenuGroups,
  selectAdminMenuGroups,
  type AdminMenuGroup,
} from './resources/index.ts';
import type { AdminShellOptions } from './shell-options.ts';
import { claimsTexts } from './texts/claims.ts';
import { shellTexts } from './texts/shell.ts';
import { createAntdTheme, sameAntdTheme } from './theme.ts';

type PermissionState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly snapshot: PermissionSnapshot }
  | { readonly status: 'failed' };

const NO_GROUPS: readonly AdminMenuGroup[] = [];
const USERS_MENU_ID = 'users';
const CLAIMS_MENU_ID = 'claims';

/** The claim id of a review page address (/claims/<claim_id>), else undefined. */
function claimIdOf(path: string): string | undefined {
  const found = /^claims\/([^/]+)$/.exec(path);
  if (found === null) return undefined;
  try {
    return decodeURIComponent(found[1]!);
  } catch {
    return undefined;
  }
}

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

/** Router state of /users opened from the top-bar search: that user's detail, not the list. */
interface SearchUserState {
  readonly searchUser: string;
}

function searchUserOf(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null || !('searchUser' in state)) return undefined;
  return typeof state.searchUser === 'string' ? state.searchUser : undefined;
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

/** The browser entry's own guard and data provider against /admin/v1 on this origin. */
function defaultAdminApi(): AdminApi {
  return createAdminApi({
    baseUrl: window.location.origin,
    fetch: (input, init) => globalThis.fetch(input, init),
    manualStart: true,
  });
}

function defaultDataProvider(auth: AdminAuthProvider | undefined): DataProvider {
  return createAdminDataProvider({
    baseUrl: window.location.origin,
    fetch: (input, init) => globalThis.fetch(input, init),
    auth,
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

// The antd theme follows the CSS in effect: rebuilt when the system scheme changes or <html>
// data-theme changes, and only when the resulting theme differs. The tree is never remounted.
function useFollowColorScheme(setTheme: Dispatch<SetStateAction<ThemeConfig>>): void {
  useEffect(() => {
    const refresh = (): void =>
      setTheme((previous) => {
        const next = createAntdTheme();
        return sameAntdTheme(previous, next) ? previous : next;
      });
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : undefined;
    media?.addEventListener('change', refresh);
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    // The scheme may have changed between the first render and this effect.
    refresh();
    return () => {
      media?.removeEventListener('change', refresh);
      observer.disconnect();
    };
  }, [setTheme]);
}

function AdminApp({ options }: { readonly options: AdminAppOptions }) {
  const [theme, setTheme] = useState(() => createAntdTheme());
  useFollowColorScheme(setTheme);
  // The own guard is built without timers; only the instance React keeps starts them (effect) and
  // stops them on unmount, so a render React throws away (StrictMode) never clears the session.
  const [ownApi] = useState(() =>
    options.authProvider === undefined && options.router === 'browser'
      ? defaultAdminApi()
      : undefined,
  );
  const ownAuth = ownApi?.auth;
  useEffect(() => ownAuth?.start(), [ownAuth]);
  const auth = options.authProvider ?? ownAuth;
  const [dataProvider] = useState(
    () => options.dataProvider ?? ownApi?.data ?? defaultDataProvider(auth),
  );
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
    if (ownApi === undefined) return options.permissionsProvider;
    return async () => {
      // Every load (first render, 刷新权限) asks the server again, never the cached answer.
      const { snapshot, username } = await ownApi.loadPermissions();
      setSignedInName(username);
      return snapshot;
    };
  }, [ownApi, options.permissionsProvider]);
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

  // Returns the request so 【退出】 stays disabled while it is under way.
  const onLogout = useCallback(
    (): void | Promise<unknown> =>
      ownAuth !== undefined ? ownAuth.logout({}) : options.onLogout(),
    [ownAuth, options],
  );

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
    <ConfigProvider theme={theme} button={{ autoInsertSpace: false }}>
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
  readonly onLogout: () => void | Promise<unknown>;
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
  // A failed first load leaves the address at home and keeps landing pending: once 重试 succeeds,
  // the same rule as a first success picks the landing page.
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
    if (state.status === 'ready') onLanded();
  }, [landing, state, groups, navigate, onLanded, location.pathname]);

  // A user hit of the top-bar search: each opening is a new history entry (its own detail view).
  const openUser = useCallback(
    (userId: string) => {
      const target: SearchUserState = { searchUser: userId };
      void navigate(`/${USERS_MENU_ID}`, { state: target });
    },
    [navigate],
  );

  const menuId = location.pathname.replace(/^\/+/, '');
  const searchUser = menuId === USERS_MENU_ID ? searchUserOf(location.state) : undefined;
  // A claim's review page (/claims/<claim_id>) belongs to the claims menu (sidebar, crumbs).
  const claimId = claimIdOf(menuId);
  const match = findMenuItem(groups, claimId === undefined ? menuId : CLAIMS_MENU_ID);
  let subpage = match === undefined ? undefined : subpageOf(location.state);
  if (match !== undefined && claimId !== undefined) subpage = claimsTexts.review.crumb;
  // A workbench card opened a route whose page is not in the catalogue yet (e.g. /risk/appeals):
  // the placeholder shows under the card's page name instead of falling back home.
  const cardTarget =
    match === undefined && findMenuItem(getAdminMenuGroups(), menuId) === undefined
      ? dashboardTargetOf(location.state)
      : undefined;
  // First permitted menu after the workbench (sidebar order): where the workbench sends accounts
  // without dashboard.view.
  const firstOther = groups
    .flatMap((group) => group.items)
    .find((item) => item.id !== DASHBOARD_MENU_ID);
  const noPermission =
    state.status === 'ready' && !state.snapshot.isSuper && state.snapshot.permissions.length === 0;
  const fallback = noPermission || firstOther === undefined ? '/' : `/${firstOther.id}`;
  // The top-bar search is on every page of an account with permission keys (not 暂无权限).
  const showSearch = state.status === 'ready' && !noPermission && !landing;
  let crumbs: string[];
  if (match === undefined) crumbs = [cardTarget ?? shellTexts.welcomeCrumb];
  else if (match.group.key === DASHBOARD_MENU_ID) crumbs = [match.item.label];
  else crumbs = [match.group.label, match.item.label, ...(subpage === undefined ? [] : [subpage])];

  let content: ReactNode = (
    <Typography.Text type="secondary" role="status">
      {shellTexts.loading}
    </Typography.Text>
  );
  if (state.status === 'failed') {
    content = <LoadFailedPage onRetry={onRefresh} />;
  } else if (landing) {
    // Keep the loading line until the landing page is chosen (no flash of the old address).
  } else if (state.status === 'ready' && access !== undefined) {
    const { snapshot } = state;
    if (match !== undefined && claimId !== undefined) {
      content = <ClaimReviewPage key={claimId} access={access} claimId={claimId} />;
    } else if (match !== undefined && options.renderPage !== undefined) {
      content = options.renderPage(match.item.id, access);
    } else if (searchUser !== undefined && (snapshot.isSuper || snapshot.permissions.length > 0)) {
      // Opened from the top-bar search; 【返回】 goes to the users list.
      content = (
        <UserDetailView
          key={location.key}
          userId={searchUser}
          canReveal={access.can('pii.reveal_phone')}
          onBack={() => void navigate(`/${USERS_MENU_ID}`)}
          onOpenUser={openUser}
        />
      );
    } else if (match !== undefined && match.item.id === DASHBOARD_MENU_ID) {
      content = <DashboardPage access={access} fallback={fallback} />;
    } else if (match !== undefined && match.item.id === 'admins') {
      // Default page for the super-admin-only menu (the menu itself is hidden otherwise).
      content = <AdminsPage />;
    } else if (match !== undefined && match.item.id === 'platform-icons') {
      content = <PlatformIconsPage />;
    } else if (match !== undefined && match.item.id === 'switches') {
      content = <KillSwitchesPage access={access} />;
    } else if (match !== undefined && match.item.id === 'config') {
      content = <ConfigCenterPage access={access} />;
    } else if (match !== undefined && match.item.id === 'pages') {
      content = <HomeConfigPage access={access} />;
    } else if (match !== undefined && match.item.id === CLAIMS_MENU_ID) {
      // Keyed by the history entry: a new address (sidebar, 【返回】, ?status= link) reads its
      // conditions afresh.
      content = <ClaimsPage key={location.key} access={access} />;
    } else if (match !== undefined && match.item.id === 'users') {
      content = <UsersPage access={access} />;
    } else if (match !== undefined) {
      content = <PagePending title={match.item.label} />;
    } else if (menuId === 'users' && (snapshot.isSuper || snapshot.permissions.length > 0)) {
      // A direct address to the users page without user.list / user.lookup: the page itself says
      // so (and sends nothing) instead of silently landing on the home page.
      content = <UsersPage access={access} />;
    } else if (menuId === DASHBOARD_MENU_ID) {
      // The workbench without dashboard.view: the first permitted menu instead (never a request).
      content = <Navigate to={fallback} replace />;
    } else if (cardTarget !== undefined) {
      content = <PagePending title={cardTarget} />;
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
    <Layout hasSider className="admin-shell">
      <Sidebar groups={groups} activeId={match?.item.id} />
      <Layout className="admin-column">
        <TopBar
          crumbs={crumbs}
          environment={options.environment}
          displayName={account.displayName}
          onLogout={onLogout}
          onOpenUser={showSearch ? openUser : undefined}
        />
        <Layout.Content className="admin-content" aria-busy={state.status === 'loading'}>
          {content}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
