// Admin app root (规划/03 §9.1): Ant Design theme, router, Refine (telemetry off) and the shell
// layout. Permissions come from the injected provider; menus are hidden by permission key and
// the server checks every action again.
import './styles/admin.css';
import { Refine, type AccessControlProvider, type ResourceProps } from '@refinedev/core';
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
import { MemoryRouter, Navigate, useLocation, type InitialEntry } from 'react-router';
import { LoadFailedPage, NoPermissionPage, PagePending, WelcomePage } from './layout/pages.tsx';
import { Sidebar } from './layout/Sidebar.tsx';
import { TopBar } from './layout/TopBar.tsx';
import type { PermissionSnapshot } from './providers/access-control/index.ts';
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

/** Builds the admin app element; the caller mounts it (main.tsx, tests). */
export function createAdminShell(options: AdminShellOptions): ReactElement {
  return <AdminApp options={options} />;
}

function AdminApp({ options }: { readonly options: AdminShellOptions }) {
  const { permissionsProvider, initialRoute } = options;
  const [theme] = useState(() => createAntdTheme());
  const [initialEntries] = useState(() => [initialEntry(initialRoute)]);
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

  const groups = useMemo(
    () => (state.status === 'ready' ? selectAdminMenuGroups(state.snapshot) : NO_GROUPS),
    [state],
  );
  const accessControlProvider = useMemo<AccessControlProvider>(() => {
    const visible = new Set<string>(
      groups.flatMap((group) => [group.key, ...group.items.map((item) => item.id)]),
    );
    const can = (resource: string | undefined): boolean =>
      resource !== undefined && visible.has(resource);
    return { can: ({ resource }) => Promise.resolve({ can: can(resource) }) };
  }, [groups]);

  return (
    <ConfigProvider theme={theme}>
      <MemoryRouter initialEntries={initialEntries}>
        <Refine
          routerProvider={routerProvider}
          resources={RESOURCES}
          accessControlProvider={accessControlProvider}
          options={{ disableTelemetry: true }}
        >
          <ShellFrame options={options} state={state} groups={groups} onRefresh={loadPermissions} />
        </Refine>
      </MemoryRouter>
    </ConfigProvider>
  );
}

interface ShellFrameProps {
  readonly options: AdminShellOptions;
  readonly state: PermissionState;
  readonly groups: readonly AdminMenuGroup[];
  readonly onRefresh: () => void;
}

function ShellFrame({ options, state, groups, onRefresh }: ShellFrameProps) {
  const location = useLocation();
  const menuId = location.pathname.replace(/^\/+/, '');
  const match = findMenuItem(groups, menuId);
  const subpage = match === undefined ? undefined : subpageOf(location.state);
  const crumbs =
    match === undefined
      ? [shellTexts.welcomeCrumb]
      : [match.group.label, match.item.label, ...(subpage === undefined ? [] : [subpage])];

  let content: ReactNode = null;
  if (state.status === 'failed') {
    content = <LoadFailedPage onRetry={onRefresh} />;
  } else if (state.status === 'ready') {
    const { snapshot } = state;
    if (match !== undefined && options.renderPage !== undefined) {
      content = options.renderPage(match.item.id);
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
