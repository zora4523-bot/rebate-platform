import { createElement } from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import {
  AppVersionEditor,
  AppVersionsPage,
  type AppVersionEditorProps,
} from '../../../../apps/admin/src/pages/app-versions/index.ts';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { button, click, mainElement } from '../admin-platform-icons/helpers.ts';
import { BASE_URL, TARGET, VERIFY, createServer, item, type Server } from './fixtures.ts';

export { button, click, mainElement };
configure({ asyncUtilTimeout: 10_000 });
export const FLOW_TIMEOUT = 40_000;
export const PERMITTED: PermissionSnapshot = {
  isSuper: false,
  permissions: ['content.app_version'],
};
// Semantic field labels, not board wording. Store row labels may carry a position suffix.
export const labels = {
  latest_version: /最新版本/,
  min_supported_version: /最低支持版本/,
  recommended_version: /推荐版本/,
  update_title: /更新标题|更新文案.*标题/,
  update_notes: /更新说明|更新文案.*说明/,
  store_url: /商店.*(?:地址|链接)|store_url/,
  default_store: /默认商店/,
  channel: /渠道/,
  store_listings: /商店登记|商店列表|各商店|已上架商店/,
};
export const storeName = /^商店(?:编码|标识|键|名称)?(?:\s*\d+)?$/;
export const listedVersion = /^已上架版本(?:\s*\d+)?$/;

/** Direct editor is a component seam for missing-row coverage; no route shape is imposed. */
export async function mount(
  server = createServer(),
  options: {
    snapshot?: PermissionSnapshot;
    editor?: boolean;
    defaultRoute?: boolean;
    target?: Pick<AppVersionEditorProps, 'platform' | 'channel'>;
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
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        initialRoute: { menuId: 'app-versions' },
        permissionsProvider: async () => options.snapshot ?? PERMITTED,
        account: { username: 'operator', displayName: '运营' },
        environment: 'test',
        onLogout: vi.fn(),
        dataProvider,
        ...(options.defaultRoute
          ? {}
          : {
              renderPage: (_menu, access) =>
                options.editor
                  ? createElement(AppVersionEditor, {
                      access,
                      platform: 'android',
                      channel: 'official',
                      ...options.target,
                    })
                  : createElement(AppVersionsPage, { access }),
            }),
      }),
    );
  });
  return { server, directFetch };
}
export function row(latest = item().latest_version): HTMLElement {
  const nodes = within(mainElement()).getAllByText(latest, { exact: true });
  const result = nodes[0]!.closest<HTMLElement>('tr, [role="row"], [role="listitem"]');
  expect(result, `semantic row for ${latest}`).not.toBeNull();
  return result!;
}
export async function loaded(latest = item().latest_version): Promise<void> {
  await waitFor(() =>
    expect(within(mainElement()).queryAllByText(latest, { exact: true }).length).toBeGreaterThan(0),
  );
}
export function field(
  name: keyof typeof labels,
  scope: HTMLElement = document.body,
): HTMLInputElement {
  return within(scope).getByLabelText(labels[name]) as HTMLInputElement;
}
export async function change(name: keyof typeof labels, value: string): Promise<void> {
  await fill(field(name), value);
}
export async function fill(input: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}
export function editor(): HTMLElement {
  const input = field('latest_version');
  return input.closest<HTMLElement>('[role="dialog"], main') ?? mainElement();
}
export async function edit(): Promise<void> {
  await loaded();
  const current = row();
  const trigger =
    within(current).queryByRole('button', { name: /编辑/ }) ??
    within(current).getByRole('link', { name: /编辑/ });
  await click(trigger);
  await waitFor(() => expect(field('latest_version').value).toBe(item().latest_version));
}
export async function save(): Promise<void> {
  await click(button(editor(), /保存/));
}
export async function settled(server: Server): Promise<void> {
  await waitFor(() => expect(server.pending).toBe(0));
  await act(async () => {
    await Promise.resolve();
  });
}
export async function saved(server: Server, count = 1): Promise<void> {
  await waitFor(() => expect(server.requests('PUT', TARGET)).toHaveLength(count));
  await settled(server);
}
export async function verify(): Promise<void> {
  const modal = await screen.findByRole('dialog', { name: /二次验证.*动态码/ });
  await fill(within(modal).getByLabelText('动态码', { exact: true }), '123456');
  await click(button(modal, '验证并继续'));
}
export function assertNoStepUp(server: Server): void {
  expect(server.requests('POST', VERIFY)).toEqual([]);
  for (const request of server.requests('PUT')) {
    expect(request.headers.has('X-Step-Up-Token')).toBe(false);
    expect(request.headers.has('Idempotency-Key')).toBe(false);
  }
}
/** A field error must be adjacent/associated, not only a toast at the top of the page. */
export function fieldMessage(name: keyof typeof labels): string {
  const target =
    name === 'store_listings' ? within(editor()).getAllByLabelText(listedVersion)[0]! : field(name);
  const ids = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  const associated = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  const group = target.closest('.ant-form-item, [role="group"], fieldset');
  return `${associated} ${group?.textContent ?? ''}`;
}
