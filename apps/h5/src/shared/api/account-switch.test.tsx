import type { BridgeEvent, BridgeRequest, BridgeTransport } from '@couli/bridge-sdk';
import { bridge } from '@couli/contracts-ts';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createAppShell } from '../../entries/app/app-shell.tsx';

// 单元测试（壳层 app-shell.tsx 的换号行为，放在 shared/api 下）：路由换成两个夹具页（一个匿名、一个需登录），原生边界用假的 __REBATE_BRIDGE__，不联网。

vi.mock('../../entries/app/routes.ts', () => ({
  createAppRoutes: () => [
    {
      path: bridge.routes.Help.h5_path,
      lazy: async () => ({ Component: () => <p>fixture-anonymous-page</p> }),
    },
    {
      path: bridge.routes.Ledger.h5_path,
      lazy: async () => ({ Component: () => <p>fixture-login-page</p> }),
    },
  ],
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.history.replaceState(null, '', '/');
});

function nativeBridge() {
  const listeners = new Set<(event: BridgeEvent) => void>();
  const transport: BridgeTransport = {
    version: 1,
    methods: ['app.getEnv', 'auth.getH5Token'],
    postMessage: (request: BridgeRequest) => ({
      id: request.id,
      code: 90500,
      msg: 'not used by the fixture pages',
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  vi.stubGlobal('__REBATE_BRIDGE__', transport);
  return {
    async change(loggedIn: boolean) {
      await act(async () => {
        for (const listener of listeners) {
          listener({ event: 'auth.changed', data: { logged_in: loggedIn } });
        }
      });
    },
  };
}

async function mount(path: string) {
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.fixture.invalid');
  vi.stubEnv('VITE_APP_ID', 'fixture_brand');
  const native = nativeBridge();
  window.history.replaceState(null, '', path);
  const view = render(createAppShell());
  return { native, view };
}

it('logout on an anonymous contract page keeps that page on screen', async () => {
  const { native } = await mount(bridge.routes.Help.h5_path!);
  await screen.findByText('fixture-anonymous-page');
  await native.change(false);
  expect(await screen.findByText('fixture-anonymous-page')).not.toBeNull();
});

it('logout on a login page takes it down; logging in again brings it back', async () => {
  const { native, view } = await mount(bridge.routes.Ledger.h5_path!);
  await screen.findByText('fixture-login-page');
  await native.change(false);
  expect(view.container.textContent).not.toContain('fixture-login-page');
  await native.change(true);
  expect(await screen.findByText('fixture-login-page')).not.toBeNull();
});
