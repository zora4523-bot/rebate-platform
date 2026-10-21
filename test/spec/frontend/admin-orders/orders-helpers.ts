import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import {
  button,
  click,
  fill,
  mainElement,
  nextPage,
  select,
  textbox,
} from '../admin-claims/claims-helpers.ts';
import { BASE_URL, LIST, NUMBER, createServer, type Server } from './orders-fixtures.ts';

export { button, click, fill, mainElement, nextPage, select, textbox };
configure({ asyncUtilTimeout: 10_000 });
export const FLOW_TIMEOUT = 40_000;
export const PERMITTED: PermissionSnapshot = { isSuper: false, permissions: ['order.view'] };
const sessions: AdminAuthProvider[] = [];
afterEach(() => {
  cleanup();
  for (const auth of sessions.splice(0)) auth.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});
export async function mount(server = createServer(), route = '/orders', snapshot = PERMITTED) {
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  const auth = harness().create();
  sessions.push(auth);
  await signIn(auth);
  window.history.replaceState(null, '', route);
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(
      createAdminShell({
        router: 'browser',
        authProvider: auth,
        permissionsProvider: async () => snapshot,
        account: { username: 'ops-yi', displayName: '客服小林' },
        environment: 'test',
        onLogout: vi.fn(),
        dataProvider: createDataProvider({
          baseUrl: BASE_URL,
          fetch: server.fetch,
          getToken: () => 'example-admin-token',
          onError: vi.fn(),
        }),
      }),
    );
  });
  return { server, directFetch, unmount: () => view!.unmount() };
}
export async function loaded(): Promise<void> {
  await waitFor(() => expect(mainElement().textContent).toContain(NUMBER));
}
export async function settled(server: Server): Promise<void> {
  await waitFor(() => expect(server.pending).toBe(0));
  await act(async () => {
    await Promise.resolve();
  });
}
export function queries(server: Server) {
  return server.requests('GET', LIST).map((request) => request.query);
}
export function row(number = NUMBER): HTMLElement {
  const found = within(mainElement())
    .queryAllByRole('row')
    .filter((node) => node.textContent?.includes(number));
  expect(found, `order row ${number}`).toHaveLength(1);
  return found[0]!;
}
export async function query(): Promise<void> {
  await click(button(mainElement(), /^查询$/));
}
export async function openDetail(): Promise<void> {
  await loaded();
  const action =
    within(row()).queryByRole('button', { name: `详情 ${NUMBER}` }) ??
    within(row()).queryByRole('link', { name: `详情 ${NUMBER}` });
  expect(action, 'accessible order detail action').not.toBeNull();
  await click(action!);
}
export async function time(label: RegExp, value: string): Promise<void> {
  const input = textbox(label);
  await act(async () => {
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.blur(input);
  });
}
/** Card scope prevents content from passing merely because another section has the same value. */
export function section(title: string): HTMLElement {
  const node = within(mainElement()).queryByText(title, { exact: true });
  expect(node, `section ${title}`).not.toBeNull();
  const card = node!.closest<HTMLElement>('.ant-card, section, [role="region"]');
  expect(card, `section container ${title}`).not.toBeNull();
  return card!;
}
export function readOnly(server: Server): void {
  const name =
    /手动同步|同步记录|导入维权|导入违规|同步此单|暂停结算|恢复结算|指定归属|导出|查看金额变更记录/;
  expect(within(mainElement()).queryAllByRole('button', { name })).toHaveLength(0);
  expect(within(mainElement()).queryAllByRole('link', { name })).toHaveLength(0);
  expect(mainElement().textContent).not.toContain('原始报文');
  expect(server.log.filter((request) => request.method !== 'GET')).toHaveLength(0);
}
