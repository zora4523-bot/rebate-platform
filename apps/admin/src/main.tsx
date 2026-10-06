// Browser entry (index.html). /admin/v1/me/permissions is not in the contract yet (CT-02f), so
// development builds preview the shell with fixed accounts (`?preview=none` shows an account
// without permission keys) and other builds report that permissions cannot be loaded.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { PermissionSnapshot, PermissionsProvider } from './providers/access-control/index.ts';
import { createAdminShell, type AdminShellOptions } from './shell.ts';
import { previewTexts } from './texts/shell.ts';

function previewOptions(): AdminShellOptions {
  const none = new URLSearchParams(window.location.search).get('preview') === 'none';
  const snapshot: PermissionSnapshot = { isSuper: !none, permissions: [] };
  return {
    permissionsProvider: () => Promise.resolve(snapshot),
    account: none
      ? { username: 'cs.xiaoli', displayName: previewTexts.noPermissionName }
      : { username: 'super.admin', displayName: previewTexts.superName },
    environment: 'development',
    onLogout: () => window.location.reload(),
  };
}

const unavailable: PermissionsProvider = () =>
  Promise.reject(new Error('admin permissions endpoint is not wired yet (CT-02f)'));

function productionOptions(): AdminShellOptions {
  return {
    permissionsProvider: unavailable,
    account: { username: '', displayName: '' },
    environment: 'production',
    onLogout: () => window.location.reload(),
  };
}

const container = document.getElementById('root');
if (container === null) throw new Error('apps/admin entry: #root is missing');
createRoot(container).render(
  <StrictMode>
    {createAdminShell(import.meta.env.DEV ? previewOptions() : productionOptions())}
  </StrictMode>,
);
