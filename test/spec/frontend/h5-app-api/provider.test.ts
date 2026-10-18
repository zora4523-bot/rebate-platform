// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { ApiProvider, createAppApi, useApi } from '../../../../apps/h5/src/shared/api/app-api.ts';
import type { H5ApiClient } from '../../../../apps/h5/src/shared/api/index.ts';
import { createAppShell } from '../../../../apps/h5/src/entries/app/shell.ts';
import * as appRoutes from '../../../../apps/h5/src/entries/app/routes.ts';
import { ENV, buildEnv, nativeBridge, envelope, transport } from './kit.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.history.replaceState(null, '', '/');
});

it('[AC-F1-01q-PROVIDER#1] Provider 提供传入的实例，重渲染不替换客户端，null 能清除它', () => {
  const native = nativeBridge();
  const wire = transport();
  const api = createAppApi({ env: ENV, bridge: native.bridge, fetch: wire.fetch });
  expect(api).not.toBeNull();
  let observed: H5ApiClient | null | undefined;
  function Probe() {
    observed = useApi();
    return createElement('span', null, 'provider-probe');
  }
  const view = render(createElement(ApiProvider, { api }, createElement(Probe)));
  expect(view.queryByText('provider-probe')).not.toBeNull();
  expect(observed).toBe(api);
  view.rerender(createElement(ApiProvider, { api }, createElement(Probe)));
  expect(observed).toBe(api);
  view.rerender(createElement(ApiProvider, { api: null }, createElement(Probe)));
  expect(observed).toBeNull();
  expect(wire.fetch).not.toHaveBeenCalled();
});

it('[AC-F1-01q-PROVIDER#2] 未挂 Provider 时 hook 返回 null，组件可显示占位', () => {
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  const wire = transport();
  vi.stubGlobal('fetch', wire.fetch);
  function Probe() {
    const api = useApi();
    return createElement('span', null, api === null ? 'page-pending' : 'unexpected-client');
  }
  expect(render(createElement(Probe)).queryByText('page-pending')).not.toBeNull();
  expect(wire.fetch).not.toHaveBeenCalled();
});

it('[AC-F1-01q-PROVIDER#3] 真实 shell 的不同懒加载路由经 hook 获取同一个可用客户端', async () => {
  buildEnv();
  const native = nativeBridge();
  const wire = transport({ body: envelope({ id: 'me' }) });
  vi.stubGlobal('fetch', wire.fetch);
  const observed: (H5ApiClient | null)[] = [];
  function Rules() {
    observed.push(useApi());
    return createElement('span', null, 'rules-route');
  }
  function Help() {
    observed.push(useApi());
    return createElement('span', null, 'help-route');
  }
  const loadRules = vi.fn(async () => ({ Component: Rules }));
  const loadHelp = vi.fn(async () => ({ Component: Help }));
  vi.spyOn(appRoutes, 'createAppRoutes').mockReturnValue([
    { path: '/rules', lazy: loadRules },
    { path: '/help', lazy: loadHelp },
  ]);
  window.history.replaceState(null, '', '/rules');
  const view = render(createAppShell());
  await waitFor(() => expect(view.queryByText('rules-route')).not.toBeNull());
  expect(loadHelp).not.toHaveBeenCalled();
  expect(observed.length).toBeGreaterThan(0);
  expect(observed[0]).not.toBeNull();
  window.history.pushState(null, '', '/help');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await waitFor(() => expect(view.queryByText('help-route')).not.toBeNull());
  expect(view.queryByText('rules-route')).toBeNull();
  expect(observed.length).toBeGreaterThan(1);
  expect(observed.every((api) => api === observed[0])).toBe(true);
  expect(await observed[0]!.request('GET', '/v1/me', {})).toEqual({ id: 'me' });
  expect(wire.requests[0]!.headers.get('X-App-Id')).toBe(ENV.appId);
  expect(wire.requests[0]!.headers.get('Authorization')).toBe('Bearer fixture-memory-token-1');
  expect(native.tokenCalls()).toBe(1);
  expect(view.queryByRole('banner')).toBeNull();
  expect(view.queryByRole('navigation')).toBeNull();
});

it('[AC-F1-01q-PROVIDER#4] 有构建配置但无 bridge 的真实 shell 仍可打开 rules，hook 为 null 且不请求', async () => {
  buildEnv();
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  const wire = transport();
  vi.stubGlobal('fetch', wire.fetch);
  let observed: H5ApiClient | null | undefined;
  // Retain the real route table and page module, adding only an observer to /rules.
  const routes = appRoutes.createAppRoutes();
  const rules = routes.find((route) => route.path === '/rules');
  expect(rules).toBeDefined();
  const loadRules = rules!.lazy;
  rules!.lazy = async () => {
    const { Component } = await loadRules();
    return {
      Component: function ObservedRules() {
        observed = useApi();
        return createElement(Component);
      },
    };
  };
  vi.spyOn(appRoutes, 'createAppRoutes').mockReturnValue(routes);
  window.history.replaceState(null, '', '/rules');
  const view = render(createAppShell());
  await waitFor(() => expect(observed).toBeNull());
  expect(view.container.textContent?.trim().length).toBeGreaterThan(0);
  expect(view.queryByRole('alert')).toBeNull();
  expect(wire.fetch).not.toHaveBeenCalled();
});

it('[AC-F1-01q-PROVIDER#5] 工厂无 bridge 时直接返回 null，不调用桥或请求网络', () => {
  const native = nativeBridge();
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  const wire = transport();
  expect(createAppApi({ env: ENV, bridge: native.bridge, fetch: wire.fetch })).toBeNull();
  expect(native.bridge.isInApp).toHaveBeenCalled();
  expect(native.bridge.call).not.toHaveBeenCalled();
  expect(native.postMessage).not.toHaveBeenCalled();
  expect(wire.fetch).not.toHaveBeenCalled();
});
