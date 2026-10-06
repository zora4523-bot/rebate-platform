// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BridgeContract } from '@couli/bridge-sdk';
import * as appRoutes from '../../../../apps/h5/src/entries/app/routes.ts';
import { createAppShell } from '../../../../apps/h5/src/entries/app/shell.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

it('[AC-F1-01e-ROUTE#1] 每条契约 H5 路由都配置错误边界，路径集合不变', () => {
  const routes = appRoutes.createAppRoutes({ reload: vi.fn() });
  const paths = Object.values(BridgeContract.routes)
    .filter((route) => route.kind === 'h5')
    .map((route) => route.h5_path)
    .sort();
  expect(routes.map((route) => route.path).sort()).toEqual(paths);
  expect(routes.length).toBeGreaterThan(0);
  for (const route of routes) {
    expect(
      route.errorElement != null || typeof route.ErrorBoundary === 'function',
      route.path,
    ).toBe(true);
    expect(typeof route.lazy).toBe('function');
  }
});

it.each(['lazy', 'render'] as const)(
  '[AC-F1-01e-ROUTE#2] %s 失败由真实 App 路由器显示重试页，点击调用注入的 reload',
  async (failure) => {
    const reload = vi.fn();
    // 先调用真实工厂，再只替换懒加载模块；保留待验证的真实错误边界。
    const routes = appRoutes.createAppRoutes({ reload });
    expect(routes.length).toBeGreaterThan(0);
    function BrokenPage(): never {
      throw new Error('fixture-render-failure: private-response-body');
    }
    for (const route of routes) {
      const lazy = vi.fn(async () => {
        if (failure === 'lazy') throw new Error('fixture-chunk-failure: private-token');
        return { Component: BrokenPage };
      });
      vi.spyOn(appRoutes, 'createAppRoutes').mockReturnValue([{ ...route, lazy }]);
      window.history.replaceState(null, '', `${route.path}?fixture=keep#position`);
      const beforeRetryUrl = window.location.href;
      const page = render(createAppShell());
      await waitFor(() => expect(page.queryByRole('alert')).not.toBeNull());
      expect(page.getByRole('heading').textContent).toBe('页面加载失败，请重试');
      expect(page.container.textContent).not.toContain('private-response-body');
      expect(page.container.textContent).not.toContain('private-token');
      expect(lazy).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
      fireEvent.click(page.getByRole('button', { name: '重试' }));
      expect(reload).toHaveBeenCalledTimes(1);
      expect(window.location.href).toBe(beforeRetryUrl);
      reload.mockClear();
      cleanup();
    }
  },
);

it('[AC-F1-01e-ROUTE#3] 正常路由仍渲染页面，不显示错误页或自动 reload', async () => {
  const reload = vi.fn();
  const routes = appRoutes.createAppRoutes({ reload });
  expect(routes.length).toBeGreaterThan(0);
  const route = routes[0]!;
  function HealthyPage() {
    return createElement('article', null, 'healthy route');
  }
  vi.spyOn(appRoutes, 'createAppRoutes').mockReturnValue([
    { ...route, lazy: async () => ({ Component: HealthyPage }) },
  ]);
  window.history.replaceState(null, '', route.path);
  const page = render(createAppShell());
  await waitFor(() => expect(page.queryByText('healthy route')).not.toBeNull());
  expect(page.queryByRole('alert')).toBeNull();
  expect(reload).not.toHaveBeenCalled();
});
