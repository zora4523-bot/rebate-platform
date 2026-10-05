// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import {
  createQueryClient,
  createQueryProvider,
  useQueryClient,
} from '../../../../apps/h5/src/shared/query.ts';
import { createAppShell } from '../../../../apps/h5/src/entries/app/shell.ts';
import * as appRoutes from '../../../../apps/h5/src/entries/app/routes.ts';
import { createLandingShell } from '../../../../apps/h5/src/entries/landing/shell.ts';
import { createConformanceShell } from '../../../../apps/h5/src/entries/conformance/shell.ts';
import { t } from '../../../../apps/h5/src/shared/texts.ts';
import { requiredText } from './kit.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('[AC-F1-01c-QUERY#1] TanStack Query 客户端可查询并读取缓存，每个壳拥有独立实例', async () => {
  const client = createQueryClient();
  const other = createQueryClient();
  try {
    const queryFn = vi.fn(async () => ({ fixture: 'value' }));
    expect(
      await client.fetchQuery({ queryKey: ['fixture'], queryFn, staleTime: Infinity }),
    ).toEqual({ fixture: 'value' });
    expect(
      await client.fetchQuery({ queryKey: ['fixture'], queryFn, staleTime: Infinity }),
    ).toEqual({ fixture: 'value' });
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(['fixture'])).toEqual({ fixture: 'value' });
    expect(other.getQueryData(['fixture'])).toBeUndefined();
  } finally {
    client.clear();
    other.clear();
  }
});

it('[AC-F1-01c-QUERY#2] Provider 子组件能获取传入的 TanStack Query 实例', () => {
  const client = createQueryClient();
  let observed: ReturnType<typeof createQueryClient> | undefined;
  function Probe() {
    observed = useQueryClient();
    return createElement('span', null, 'query-provider-fixture');
  }
  try {
    const page = render(createQueryProvider(createElement(Probe), client));
    expect(page.queryByText('query-provider-fixture')).not.toBeNull();
    expect(observed).toBe(client);
  } finally {
    cleanup();
    client.clear();
  }
});

it('[AC-F1-01c-SHELL#1] App 壳可在契约路径直接打开，渲染占位内容且不自绘标题栏', async () => {
  window.history.replaceState(null, '', '/rules');
  const element = createAppShell();
  const page = render(element);
  await waitFor(() => expect(page.container.textContent?.trim().length).toBeGreaterThan(0));
  expect(page.queryByRole('banner')).toBeNull();
  expect(page.queryByRole('navigation')).toBeNull();
});

it('[AC-F1-01c-SHELL#2] landing 壳可脱离桥渲染', () => {
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  const element = createLandingShell();
  const page = render(element);
  expect(page.container.childElementCount).toBeGreaterThan(0);
});

it('[AC-F1-01c-SHELL#4] 实际 App 壳挂载 Query Provider，且只加载当前匹配的路由', async () => {
  const clients: ReturnType<typeof createQueryClient>[] = [];
  function RulesProbe() {
    clients.push(useQueryClient());
    return createElement('span', null, 'rules-route-fixture');
  }
  function HelpProbe() {
    clients.push(useQueryClient());
    return createElement('span', null, 'help-route-fixture');
  }
  const loadRules = vi.fn(async () => ({ Component: RulesProbe }));
  const loadHelp = vi.fn(async () => ({ Component: HelpProbe }));
  vi.spyOn(appRoutes, 'createAppRoutes').mockReturnValue([
    { path: '/rules', lazy: loadRules },
    { path: '/help', lazy: loadHelp },
  ]);
  window.history.replaceState(null, '', '/rules');
  const element = createAppShell();
  try {
    const page = render(element);
    await waitFor(() => expect(page.queryByText('rules-route-fixture')).not.toBeNull());
    expect(loadRules).toHaveBeenCalledTimes(1);
    expect(loadHelp).not.toHaveBeenCalled();
    expect(clients.length).toBeGreaterThan(0);
    window.history.pushState(null, '', '/help');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(page.queryByText('help-route-fixture')).not.toBeNull());
    expect(page.queryByText('rules-route-fixture')).toBeNull();
    expect(loadHelp).toHaveBeenCalledTimes(1);
    expect(clients.every((client) => client === clients[0])).toBe(true);
  } finally {
    cleanup();
    for (const client of clients) client.clear();
  }
});

it('[AC-F1-01c-SHELL#3] conformance 提供独立的可渲染空壳', () => {
  const element = createConformanceShell();
  const page = render(element);
  expect(page.container.childElementCount).toBeGreaterThan(0);
});

it('[AC-F1-01c-TEXT#1] t(key) 读取契约正文与已有公共兜底，不返回字典键', () => {
  const dictionary = JSON.parse(requiredText('contracts/texts.default.json')) as {
    texts: Record<string, string>;
    fallbacks: Record<string, string>;
  };
  expect(t('error.10403')).toBe(dictionary.texts['error.10403']);
  expect(t('error.50001')).toBe(dictionary.fallbacks['error.50001']);
  expect(t('error.10403.h5_read_only')).toBe(dictionary.texts['error.10403.h5_read_only']);
});
