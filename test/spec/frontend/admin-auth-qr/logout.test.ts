// @vitest-environment jsdom
import { act, createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { permissionsFromMe } from '../../../../apps/admin/src/providers/access-control/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { ME, TITLES, harness, ok, rejected, signIn } from '../admin-auth/fixtures.ts';
import { click, disabled, installMediaQuery } from './helpers.ts';

const providers: AdminAuthProvider[] = [];
beforeEach(installMediaQuery);
afterEach(() => {
  cleanup();
  for (const auth of providers.splice(0)) auth.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

for (const outcome of ['成功', '失败', '超时'] as const) {
  it(`[AC-F1-06j-LOGOUT#1] 退出${outcome}：在途按钮禁用并忽略重复点击，结束后回登录页`, async () => {
    const h = harness();
    const auth = h.create();
    providers.push(auth);
    const response = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    h.queue('/admin/v1/auth/logout', () => {
      started.resolve();
      return response.promise;
    });
    let finished = false;
    const onLogout = vi.fn(async () => {
      await auth.logout();
      finished = true;
    });
    // Embedding mode keeps TopBar mounted while its real logout callback is pending. In the
    // guarded browser shell the provider clears the token immediately, unmounting TopBar;
    // checking only that shell would let an always-enabled button escape this requirement.
    const view = render(
      createAdminShell({
        router: 'memory',
        environment: 'test',
        account: { username: ME.username, displayName: ME.username },
        permissionsProvider: async () => permissionsFromMe(ME),
        initialRoute: { menuId: 'withdrawals' },
        renderPage: (id) => createElement('div', null, `page:${id}`),
        onLogout,
      }),
    );
    await waitFor(() => expect(screen.queryByText('page:withdrawals')).not.toBeNull());
    vi.useFakeTimers();
    await signIn(auth);
    await click('退出');
    await started.promise;
    const button = screen.getByRole('button', { name: '退出' });
    expect(disabled(button)).toBe(true);
    expect(finished).toBe(false);
    await click('退出');
    await click('退出');
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(h.requests.filter((request) => request.path.endsWith('/auth/logout'))).toHaveLength(1);
    await act(async () => {
      if (outcome === '超时') await vi.advanceTimersByTimeAsync(10_000);
      else response.resolve(outcome === '成功' ? ok({}) : rejected(50001));
    });
    expect(finished).toBe(true);
    expect(auth.getToken()).toBeNull();
    expect(h.storage.values.size).toBe(0);
    view.unmount();
    // The browser entry with that same signed-out provider must show the login route for all
    // three outcomes, even if the old route was a business page.
    vi.useRealTimers();
    window.history.replaceState(null, '', '/withdrawals');
    render(
      createAdminShell({
        authProvider: auth,
        router: 'browser',
        environment: 'test',
        account: { username: ME.username, displayName: ME.username },
        permissionsProvider: async () => permissionsFromMe(ME),
        onLogout,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: TITLES.credentials })).not.toBeNull(),
    );
    expect(window.location.pathname).toBe('/login');
    expect(screen.queryByRole('button', { name: '退出' })).toBeNull();
    if (outcome === '超时') {
      await act(async () => {
        response.resolve(ok({}));
      });
      expect(auth.getToken()).toBeNull();
      expect(window.location.pathname).toBe('/login');
    }
  });
}
