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
import {
  BASE_URL,
  PERMITTED,
  TARGET,
  VERIFY,
  createServer,
  item,
  type Server,
} from './fixtures.ts';

export { button, click, mainElement };
configure({ asyncUtilTimeout: 10_000 });
export const FLOW_TIMEOUT = 40_000;
export { PERMITTED } from './fixtures.ts';
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
  const input = field(name);
  if (
    name === 'default_store' &&
    input.tagName !== 'SELECT' &&
    input.getAttribute('role') === 'combobox'
  ) {
    await act(async () => {
      fireEvent.mouseDown(input);
      fireEvent.click(input);
    });
    await click(await screen.findByRole('option', { name: value }));
  } else {
    await fill(input, value);
  }
}
export function expectDefaultStore(value: string): void {
  const input = field('default_store');
  if (input.tagName !== 'SELECT' && input.getAttribute('role') === 'combobox') {
    expect(input.closest('.ant-select')?.textContent ?? input.textContent).toContain(value);
  } else {
    expect(input.value).toBe(value);
  }
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
/** Accept either a list-level error or an error beside any store row. */
function storeRegion(): HTMLElement {
  const scope = within(editor());
  const labelled =
    scope.queryByRole('group', { name: labels.store_listings }) ??
    scope.queryByRole('region', { name: labels.store_listings });
  if (labelled) return labelled;
  const controls = [
    ...scope.getAllByLabelText(storeName),
    ...scope.getAllByLabelText(listedVersion),
  ];
  // The server/local error itself may also mention “商店列表”; prefer the area heading.
  const heading = scope
    .getAllByText(labels.store_listings)
    .find((node) => !node.closest('.ant-form-item-explain-error, [role="alert"]'));
  expect(heading, 'store registration heading').toBeDefined();
  let region: HTMLElement | null = heading!;
  while (region && !controls.every((control) => region!.contains(control)))
    region = region.parentElement;
  expect(region, 'store registration area').not.toBeNull();
  expect(region!.contains(field('latest_version')), 'not the whole editor').toBe(false);
  return region!;
}

/** Read error text only: a label or the current value must not count as a field error. */
export function fieldMessage(name: keyof typeof labels): string {
  const target = name === 'store_listings' ? storeRegion() : field(name);
  const group =
    name === 'store_listings'
      ? target
      : (target.closest('.ant-form-item, [role="group"], fieldset') ?? target.parentElement!);
  const references = [target, ...group.querySelectorAll('[aria-describedby], [aria-errormessage]')];
  const ids = references.flatMap((node) => {
    // Ordinary help text is not an error on an otherwise valid field.
    const description =
      node.getAttribute('aria-invalid') === 'true' ? node.getAttribute('aria-describedby') : '';
    return `${description ?? ''} ${node.getAttribute('aria-errormessage') ?? ''}`
      .split(/\s+/)
      .filter(Boolean);
  });
  const errors = [
    ...ids.map((id) => document.getElementById(id)),
    ...group.querySelectorAll('.ant-form-item-explain-error, [role="alert"]'),
  ];
  return [...new Set(errors)]
    .map((node) => node?.textContent?.trim() ?? '')
    .join(' ')
    .trim();
}

export async function expectFieldErrors(names: readonly (keyof typeof labels)[]): Promise<void> {
  await waitFor(() => {
    for (const name of Object.keys(labels) as (keyof typeof labels)[]) {
      if (names.includes(name)) expect(fieldMessage(name), `${name} error`).not.toBe('');
      else expect(fieldMessage(name), `${name} has no error`).toBe('');
    }
  });
}
