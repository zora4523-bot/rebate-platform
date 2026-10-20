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
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { button, click, mainElement } from '../admin-platform-icons/helpers.ts';
import {
  BASE_URL,
  CID,
  LIST,
  ROUTE,
  createServer,
  detail,
  type Server,
} from './claims-fixtures.ts';

export { button, click, mainElement };
configure({ asyncUtilTimeout: 10_000 });
export const FLOW_TIMEOUT = 40_000;
export const PERMITTED: PermissionSnapshot = { isSuper: false, permissions: ['order.claim'] };
const sessions: AdminAuthProvider[] = [];
afterEach(() => {
  cleanup();
  for (const auth of sessions.splice(0)) auth.dispose();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});
export async function mount(server = createServer(), route = '/claims', snapshot = PERMITTED) {
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
export async function loaded(id = CID): Promise<void> {
  await waitFor(() => expect(mainElement().textContent).toContain(id));
}
export async function review(server = createServer()) {
  const result = await mount(server, ROUTE);
  await loaded();
  await waitFor(() =>
    expect(mainElement().textContent).toContain(server.claim.items[0]!.sub_order_id),
  );
  return result;
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
export function row(id = CID): HTMLElement {
  const found = within(mainElement()).queryByText(id, { exact: true });
  expect(found, `claim row ${id}`).not.toBeNull();
  const result = found!.closest<HTMLElement>('tr');
  expect(result).not.toBeNull();
  return result!;
}
export function textbox(name: RegExp, scope = mainElement()): HTMLElement {
  const found = within(scope).queryByRole('textbox', { name });
  expect(found, `labelled textbox ${name}`).not.toBeNull();
  return found!;
}
export async function fill(node: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(node, { target: { value } });
  });
}
export async function openSelect(name: RegExp, scope = mainElement()): Promise<HTMLElement[]> {
  const input = within(scope).queryByRole('combobox', { name });
  expect(input, `labelled Select ${name}`).not.toBeNull();
  await act(async () => {
    fireEvent.mouseDown(input!);
  });
  const options = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content',
      ),
    );
  await waitFor(() => expect(options().length).toBeGreaterThan(0));
  return options();
}
export async function select(
  name: RegExp,
  label: string | RegExp,
  scope = mainElement(),
): Promise<void> {
  const options = await openSelect(name, scope);
  const option = options.find((node) =>
    typeof label === 'string'
      ? node.textContent?.includes(label)
      : label.test(node.textContent ?? ''),
  );
  expect(option, `option ${String(label)}`).toBeDefined();
  await click(option!);
}
/** Find the smallest ancestor of the child number with its own review controls, independent of Card markup. */
export function panel(index = 0): HTMLElement {
  const child = detail().items[index]!.sub_order_id;
  const nodes = within(mainElement()).queryAllByText(child, { exact: true });
  for (const node of nodes) {
    let current: HTMLElement | null = node;
    while (current && current !== mainElement()) {
      if (
        within(current).queryAllByRole('button', { name: /^通过$/ }).length === 1 &&
        !detail().items.some(
          (item) =>
            item.sub_order_id !== child && current!.textContent?.includes(item.sub_order_id),
        )
      )
        return current;
      current = current.parentElement;
    }
  }
  expect.fail(`missing independent review controls for ${child}`);
}
export async function note(value: string, index = 0): Promise<void> {
  await fill(textbox(/说明/, panel(index)), value);
}
export async function rejectForm(index = 0): Promise<HTMLElement> {
  const scope = panel(index);
  await click(button(scope, /^驳回$/));
  await waitFor(() =>
    expect(screen.queryAllByRole('combobox', { name: /驳回原因/ }).length).toBeGreaterThan(0),
  );
  return screen.queryByRole('dialog') ?? scope;
}
export async function nextPage(): Promise<void> {
  const next = mainElement().querySelector<HTMLElement>(
    '[title="Next Page"], [title="下一页"], [aria-label="Next Page"], [aria-label="下一页"]',
  );
  expect(next).not.toBeNull();
  await click(next!);
}
