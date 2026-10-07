// @vitest-environment jsdom
import { act, createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAdminShell, type AdminAppOptions } from '../../../../apps/admin/src/App.tsx';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { permissionsFromMe } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { AdminApiError } from '../../../../apps/admin/src/providers/data/index.ts';
import { CREDENTIALS, ME, NOW, TITLES, harness } from './fixtures.ts';

const providers: AdminAuthProvider[] = [];
beforeEach(() => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
});
afterEach(() => {
  cleanup();
  for (const auth of providers.splice(0)) auth.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

function mount(h = harness(), initial = '/') {
  const auth = h.create();
  providers.push(auth);
  window.history.replaceState(null, '', initial);
  const permissions = vi.fn(async () => {
    const identity = await auth.getIdentity();
    return identity === null ? { isSuper: false, permissions: [] } : permissionsFromMe(identity);
  });
  // Structural extension keeps the existing shell intact in the test phase. The implementation
  // must consume this authProvider in App.tsx; ignoring it fails the route assertions below.
  const options: AdminAppOptions & { authProvider: AdminAuthProvider } = {
    authProvider: auth,
    environment: 'test',
    router: 'browser',
    account: { username: 'ops-yi', displayName: 'ops-yi' },
    permissionsProvider: permissions,
    onLogout: async () => {
      await auth.logout({});
    },
    renderPage: (id) => createElement('div', null, `page:${id}`),
  };
  render(createAdminShell(options));
  return { ...h, auth, permissions, user: userEvent.setup() };
}

async function login(h: ReturnType<typeof mount>) {
  await screen.findByRole('heading', { name: TITLES.credentials });
  await h.user.type(screen.getByLabelText(/^账号/), CREDENTIALS.username);
  await h.user.type(screen.getByLabelText(/^密码/), CREDENTIALS.password);
  await h.user.click(screen.getByRole('button', { name: '下一步' }));
  await screen.findByRole('heading', { name: TITLES.totp });
  await h.user.type(screen.getByRole('textbox', { name: '动态码' }), '123456');
  await h.user.click(screen.getByRole('button', { name: '登录' }));
}

it('[AC-F1-06h-APP#1] 未登录直达业务路由只显示登录，不加载后台权限、不闪现菜单', async () => {
  const h = mount(harness(), '/withdrawals');
  expect(await screen.findByRole('heading', { name: TITLES.credentials })).toBeTruthy();
  expect(window.location.pathname).toBe('/login');
  expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull();
  expect(screen.queryByText('page:withdrawals')).toBeNull();
  expect(h.permissions).not.toHaveBeenCalled();
  expect(h.requests.some((r) => r.path.endsWith('/me/permissions'))).toBe(false);
});

for (const [name, me, destination] of [
  ['契约财务账号', ME, 'withdrawals'],
  [
    '只有资金流水权限',
    { ...ME, permissions: [{ key: 'fund.view', step_up_tier: null, step_up_operations: [] }] },
    'ledger',
  ],
  ['超管即使空权限数组', { ...ME, is_super: true, permissions: [] }, 'users'],
  ['普通零权限', { ...ME, is_super: false, permissions: [] }, null],
] as const) {
  it(`[AC-F1-06h-APP#2] ${name}完成登录后落到${destination ?? '暂无权限页'}`, async () => {
    const h = mount(
      harness('totp', {
        ...me,
        permissions: [...me.permissions].map((grant) => ({
          ...grant,
          step_up_operations: [...grant.step_up_operations],
        })),
      }),
    );
    await login(h);
    if (destination === null) {
      expect(await screen.findByText('还没有分配权限')).toBeTruthy();
      expect(screen.queryByText('page:reports')).toBeNull();
    } else {
      expect(await screen.findByText(`page:${destination}`)).toBeTruthy();
      expect(window.location.pathname).toBe(`/${destination}`);
    }
    expect(screen.queryByRole('heading', { name: TITLES.credentials })).toBeNull();
  });
}

it('[AC-F1-06h-APP#3] 已显示后台时收到 10001，主动返回登录并隐藏原页面', async () => {
  const h = mount();
  await login(h);
  await screen.findByText('page:withdrawals');
  await act(async () => {
    await h.auth.onError(
      new AdminApiError({
        code: 10001,
        msg: '请先登录',
        data: undefined,
        httpStatus: 401,
        kind: 'api',
      }),
    );
  });
  expect(await screen.findByRole('heading', { name: TITLES.credentials })).toBeTruthy();
  expect(window.location.pathname).toBe('/login');
  expect(screen.queryByText('page:withdrawals')).toBeNull();
  expect(h.auth.getToken()).toBeNull();
});

it('[AC-F1-06h-APP#4] 没有新请求时空闲到点也主动退出，鼠标键盘活动不延长会话', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const h = mount();
  await login(h);
  await screen.findByText('page:withdrawals');
  h.setNow(NOW + 29 * 60_000);
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  h.setNow(NOW + 30 * 60_000);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30 * 60_000);
  });
  await waitFor(() => expect(window.location.pathname).toBe('/login'));
  expect(screen.getByRole('heading', { name: TITLES.credentials })).toBeTruthy();
  expect(screen.queryByText('page:withdrawals')).toBeNull();
});

it('[AC-F1-06h-APP#5] 真实入口未注入 authProvider 时仍默认启用登录守卫', async () => {
  // main.tsx calls this entry without an authProvider. An injection-only demo must not pass.
  const h = harness();
  vi.stubGlobal('fetch', h.fetch);
  sessionStorage.clear();
  const permissions = vi.fn(async () => ({ isSuper: false, permissions: [] }));
  render(
    createAdminShell({
      environment: 'production',
      router: 'browser',
      permissionsProvider: permissions,
      account: { username: '', displayName: '' },
      onLogout: vi.fn(),
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('heading', { name: TITLES.credentials })).not.toBeNull(),
  );
  expect(window.location.pathname).toBe('/login');
  expect(permissions).not.toHaveBeenCalled();
  expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull();
});
