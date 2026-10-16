// Browser entry (index.html). The app signs in against /admin/v1 on its own origin and reads the
// account's permissions from /admin/v1/me/permissions (App's own guard). A development server
// without COULI_ADMIN_API_TARGET (no /admin/v1 proxy, see vite.config.ts) previews the shell with
// fixed accounts instead (`?preview=none` shows an account without permission keys).
// antd v5 officially supports React 16-18; this patch (F1-06t) must load before antd renders so
// that Modal / message / notification work under React 19.
import '@ant-design/v5-patch-for-react-19';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { PermissionSnapshot } from './providers/access-control/index.ts';
import { createAdminShell, type AdminEnvironment, type AdminShellOptions } from './shell.ts';
import { previewTexts } from './texts/shell.ts';

declare global {
  interface ImportMetaEnv {
    /** vite.config.ts `define`: the dev server proxies /admin/v1 to a local API. */
    readonly VITE_ADMIN_LIVE?: boolean;
  }
}

function previewOptions(): AdminShellOptions {
  const none = new URLSearchParams(window.location.search).get('preview') === 'none';
  const snapshot: PermissionSnapshot = { isSuper: !none, permissions: [] };
  return {
    permissionsProvider: () => Promise.resolve(snapshot),
    account: none
      ? { username: 'cs.xiaoli', displayName: previewTexts.noPermissionName }
      : { username: 'super.admin', displayName: previewTexts.superName },
    environment: 'development',
    router: 'browser',
    onLogout: () => window.location.reload(),
  };
}

/** No permission keys until the guard has read /me/permissions (the app reads them itself). */
const NO_PERMISSIONS: PermissionSnapshot = { isSuper: false, permissions: [] };

function liveOptions(environment: AdminEnvironment): AdminShellOptions {
  return {
    // Unused with the browser router: App's own guard loads permissions and the account name, and
    // 【退出】 goes through the guard.
    permissionsProvider: () => Promise.resolve(NO_PERMISSIONS),
    account: { username: '', displayName: '' },
    environment,
    router: 'browser',
    onLogout: () => undefined,
  };
}

function entryOptions(): AdminShellOptions {
  if (!import.meta.env.DEV) return liveOptions('production');
  return import.meta.env.VITE_ADMIN_LIVE === true ? liveOptions('development') : previewOptions();
}

const container = document.getElementById('root');
if (container === null) throw new Error('apps/admin entry: #root is missing');
createRoot(container).render(<StrictMode>{createAdminShell(entryOptions())}</StrictMode>);
