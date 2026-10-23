import { createElement, StrictMode } from 'react';
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import {
  UnionsPage,
  UnionOAuthCallbackPage,
} from '../../../../apps/admin/src/pages/unions/index.ts';
import {
  createAccessControl,
  type PermissionSnapshot,
} from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import {
  BASE_URL,
  NOW,
  LIST,
  VERIFY,
  createServer,
  type Server,
  type RequestLog,
} from './fixtures.ts';

configure({ asyncUtilTimeout: 5000 });
export const PERMITTED: PermissionSnapshot = {
  isSuper: false,
  permissions: ['union.account_auth'],
  stepUp: { 'union.account_auth': { tier: 'totp', operations: {} } },
};
export const FLOW_TIMEOUT = 30_000;
const providers: AdminAuthProvider[] = [];
afterEach(() => {
  cleanup();
  for (const provider of providers.splice(0)) provider.dispose();
  window.history.replaceState(null, '', '/');
});
export async function mount(
  server = createServer(),
  options: {
    route?: string;
    snapshot?: PermissionSnapshot;
    app?: boolean;
    strict?: boolean;
  } = {},
) {
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  const dataProvider = createDataProvider({
    baseUrl: BASE_URL,
    fetch: server.fetch,
    getToken: () => 'example-admin-token',
    onError: vi.fn(),
  });
  const snapshot = options.snapshot ?? PERMITTED;
  const route = options.route ?? '/unions';
  let now = NOW;
  const clock = { now: () => now };
  const callback = route.startsWith('/unions/oauth-callback');
  let authProvider: AdminAuthProvider | undefined;
  if (callback) {
    authProvider = harness().create();
    providers.push(authProvider);
    await signIn(authProvider);
    // The unit slot supplies the callback component under the existing menu route, with the
    // exact browser query. The browser suite separately verifies the real callback pathname.
    window.history.replaceState(null, '', `/unions${new URL(route, BASE_URL).search}`);
  }
  const element = createAdminShell({
    router: callback ? 'browser' : 'memory',
    initialRoute: { menuId: 'unions' },
    permissionsProvider: async () => (options.app ? snapshot : { isSuper: true, permissions: [] }),
    account: { username: 'ops-yi', displayName: '运营' },
    environment: 'test',
    onLogout: vi.fn(),
    dataProvider,
    clock,
    ...(authProvider === undefined ? {} : { authProvider }),
    ...(options.app
      ? {}
      : {
          renderPage: () =>
            createElement(callback ? UnionOAuthCallbackPage : UnionsPage, {
              access: createAccessControl(snapshot),
              clock,
            }),
        }),
  });
  // Catch skeleton throws in this test's act, not an unhandled asynchronous render.
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(options.strict ? createElement(StrictMode, null, element) : element);
  });
  return {
    server,
    directFetch,
    view: view!,
    setNow(value: number) {
      now = value;
    },
  };
}
export function main(): HTMLElement {
  return screen.getByRole('main');
}
export async function loaded(): Promise<void> {
  await waitFor(() => expect(main().textContent).toContain('测试 OAuth 账号'));
}
export function row(name: string): HTMLElement {
  const node = within(main()).getByText(name, { exact: true });
  const result = node.closest<HTMLElement>('tr, [role="row"], [role="listitem"]');
  expect(result, `semantic row for ${name}`).not.toBeNull();
  return result!;
}
export function button(container: HTMLElement, name: string | RegExp): HTMLElement {
  return within(container).getByRole('button', { name });
}
export async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(node);
  });
}
export async function fill(node: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(node, { target: { value } });
  });
}
export async function dialog(name: string | RegExp): Promise<HTMLElement> {
  return screen.findByRole('dialog', { name });
}
export async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1)
    await act(async () => {
      await Promise.resolve();
    });
}
export async function advance(milliseconds: number): Promise<void> {
  // Flush React between ticks: a chained timeout scheduled by an effect must see each tick.
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 1000) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(1000, milliseconds - elapsed));
    });
  }
}
export async function openOAuth(): Promise<HTMLElement> {
  await loaded();
  await click(button(row('测试 OAuth 账号'), '重新授权'));
  return dialog(/重新授权/);
}
export async function openManual(): Promise<HTMLElement> {
  await loaded();
  await click(button(row('测试手工账号'), '录入新凭据'));
  return dialog(/录入新凭据/);
}
export async function openPhones(server: Server): Promise<void> {
  await loaded();
  // Both an inline management block and a labelled management dialog are valid.
  if (!document.body.textContent?.includes('138****5678')) {
    const manage = within(main()).queryByRole('button', { name: /管理.*告警手机|告警手机.*管理/ });
    if (manage) await click(manage);
  }
  await waitFor(() =>
    expect(server.requests('GET', `${LIST}/alert-phones`).length).toBeGreaterThan(0),
  );
  await settle();
}
export async function openAdd(server: Server): Promise<HTMLElement> {
  await openPhones(server);
  await click(screen.getByRole('button', { name: /新增.*手机|添加.*手机/ }));
  return dialog(/新增.*手机|添加.*手机/);
}
export async function openRemove(server: Server, masked = '138****5678'): Promise<HTMLElement> {
  await openPhones(server);
  const text = screen.getByText(masked, { exact: true });
  const container = text.closest<HTMLElement>('tr, [role="row"], [role="listitem"], li');
  expect(container).not.toBeNull();
  await click(button(container!, /删除|移除/));
  return dialog(/删除|移除/);
}
export async function stepUp(form: HTMLElement): Promise<HTMLElement> {
  await click(button(form, /^(?:验证并.*|确认.*|提交.*|保存.*|开始授权)$/));
  return dialog('二次验证 · 动态码');
}
export async function verify(modal: HTMLElement): Promise<void> {
  await fill(within(modal).getByLabelText('动态码', { exact: true }), '123456');
  await click(button(modal, '验证并继续'));
  await settle();
}
export function assertWrite(request: RequestLog, token = 'test-totp-1'): void {
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(request.headers.get('X-Step-Up-Token')).toBe(token);
  expect(request.headers.has('Idempotency-Key')).toBe(false);
}
export function assertVerified(server: Server, count = 1): void {
  expect(server.requests('POST', VERIFY).map((r) => r.body)).toEqual(
    Array.from({ length: count }, () => ({ tier: 'totp', code: '123456' })),
  );
}
export function fieldError(input: HTMLElement): void {
  // Check association, not just a generic toast somewhere on the page.
  const ids = [input.getAttribute('aria-describedby'), input.getAttribute('aria-errormessage')]
    .filter(Boolean)
    .join(' ')
    .split(/\s+/);
  const messages = ids.map((id) => document.getElementById(id)).filter((node) => node !== null);
  const nearby = input
    .closest('.ant-form-item')
    ?.querySelector('[role="alert"], .ant-form-item-explain-error');
  expect(
    messages.some((node) => Boolean(node.textContent?.trim())) ||
      Boolean(nearby?.textContent?.trim()),
  ).toBe(true);
}
