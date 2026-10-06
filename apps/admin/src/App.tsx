// Admin app root (规划/03 §9.1): Ant Design theme, router, Refine (telemetry off) and the shell
// layout, wired to the /admin/v1 data provider and the CASL access control. Permissions come from
// the injected provider; menus are hidden by permission key and the server checks every action
// again.
import './styles/admin.css';
import {
  Refine,
  type AccessControlProvider,
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
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  BrowserRouter,
  MemoryRouter,
  Navigate,
  useLocation,
  type InitialEntry,
} from 'react-router';
import { LoadFailedPage, NoPermissionPage, PagePending, WelcomePage } from './layout/pages.tsx';
import { Sidebar } from './layout/Sidebar.tsx';
import { TopBar } from './layout/TopBar.tsx';
import {
  createAccessControl,
  type AccessControl,
  type PermissionSnapshot,
} from './providers/access-control/index.ts';
import { createRefineAccessControl } from './providers/access-control/refine.ts';
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
 * Shell options plus the REST data provider (providers/data). Without one, the app talks to
 * /admin/v1 on its own origin without a token until the login flow supplies one.
 */
export interface AdminAppOptions extends AdminShellOptions {
  readonly dataProvider?: DataProvider;
}

function defaultDataProvider(): DataProvider {
  return createDataProvider({
    baseUrl: window.location.origin,
    fetch: (input, init) => globalThis.fetch(input, init),
    getToken: () => null,
    onError: () => undefined,
  });
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
  const { permissionsProvider } = options;
  const [theme] = useState(() => createAntdTheme());
  const [dataProvider] = useState(() => options.dataProvider ?? defaultDataProvider());
  const [state, setState] = useState<PermissionState>({ status: 'loading' });
  const latestRequest = useRef(0);

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

  useEffect(() => {
    loadPermissions();
  }, [loadPermissions]);

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
          options={{ disableTelemetry: true }}
        >
          <ShellFrame
            options={options}
            state={state}
            access={access}
            groups={groups}
            onRefresh={loadPermissions}
          />
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
  readonly onRefresh: () => void;
}

function ShellFrame({ options, state, access, groups, onRefresh }: ShellFrameProps) {
  const location = useLocation();
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
  if (state.status === 'failed') {
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
          username={options.account.username}
          displayName={options.account.displayName}
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
          displayName={options.account.displayName}
          onLogout={() => void options.onLogout()}
        />
        <main className="admin-content" aria-busy={state.status === 'loading'}>
          {content}
        </main>
      </div>
    </div>
  );
}
