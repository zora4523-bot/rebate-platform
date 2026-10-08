// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { ME, harness, rejected } from '../admin-auth/fixtures.ts';
import { click, code, credentials, installMediaQuery, mountShell } from './helpers.ts';

const providers: AdminAuthProvider[] = [];
beforeEach(installMediaQuery);
afterEach(() => {
  cleanup();
  for (const auth of providers.splice(0)) auth.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

it('[AC-F1-06j-PERMISSION#1] 首次权限加载失败可重试，成功后按菜单顺序进入首个页面，零权限进入暂无权限', async () => {
  // One acceptance journey matrix: the nonempty cases expose the welcome-page regression;
  // the zero-permission branch protects the existing fallback after that repair.
  for (const [me, destination] of [
    [ME, 'withdrawals'],
    [
      { ...ME, permissions: [{ key: 'fund.view', step_up_tier: null, step_up_operations: [] }] },
      'ledger',
    ],
    [{ ...ME, is_super: true, permissions: [] }, 'users'],
    [{ ...ME, is_super: false, permissions: [] }, null],
  ] as const) {
    const h0 = harness('totp', {
      ...me,
      permissions: me.permissions.map((grant) => ({
        ...grant,
        step_up_operations: [...grant.step_up_operations],
      })),
    });
    h0.queue('/admin/v1/me/permissions', () => rejected(50001));
    const h = mountShell(providers, h0);
    await credentials();
    await code();
    await click('登录');
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: '权限加载失败' })).not.toBeNull(),
    );
    expect(screen.queryByText(/^page:/)).toBeNull();
    expect(h.auth.getToken()).not.toBeNull();
    await click('重试');
    if (destination === null) {
      await waitFor(() => expect(screen.queryByText('还没有分配权限')).not.toBeNull());
      expect(window.location.pathname).toBe('/');
      expect(screen.queryByText(/^page:/)).toBeNull();
    } else {
      await waitFor(() => expect(screen.queryByText(`page:${destination}`)).not.toBeNull());
      expect(window.location.pathname).toBe(`/${destination}`);
    }
    expect(
      h.requests.filter((request) => request.path === '/admin/v1/me/permissions'),
    ).toHaveLength(2);
    expect(screen.queryByRole('heading', { name: '权限加载失败' })).toBeNull();
    h.view.unmount();
    h.auth.dispose();
  }
});
