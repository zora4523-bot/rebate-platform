/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { BASE_URL, GROUPS, TARGET, createServer } from './fixtures.ts';

const FIRST = { timeout: 10_000 };
const MOTION =
  /(?:^|\s)ant-(?:zoom|fade|move|slide)\b|-(?:appear|enter|leave)(?:-|\s|$)|-motion\b|-motion-/;
let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

function show(): void {
  const server = createServer();
  const marker = document.createElement('span');
  marker.hidden = true;
  marker.id = 'switch-requests';
  marker.dataset['pending'] = '0';
  document.body.append(marker);
  let pending = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    pending += 1;
    marker.dataset['pending'] = String(pending);
    try {
      return await server.fetch(input, init);
    } finally {
      pending -= 1;
      marker.dataset['pending'] = String(pending);
    }
  };
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'memory',
      initialRoute: { menuId: 'switches' },
      permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
      account: { username: 'ops-yi', displayName: '超管' },
      environment: 'test',
      onLogout: () => {},
      dataProvider: createDataProvider({
        baseUrl: BASE_URL,
        fetch,
        getToken: () => 'example-admin-token',
        onError: () => {},
      }),
    }),
  );
}

/** Fixtures show contract rows; the board's extra paired-key write is not in this PUT contract. */
async function screenshot(name: string): Promise<void> {
  await document.fonts.ready;
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
  );
  const image = await page.screenshot({ base64: true, fullPage: true });
  const path = image.path.replace(/[^/]+$/, `${name}.png`);
  await commands.writeFile(path, image.base64, 'base64');
  if (path !== image.path) await commands.removeFile(image.path);
}

it('[AC-F1-06zf-BROWSER#1] AdmSwitches：1440 宽四组列表、权限列、差异标签和只读开关可见', async () => {
  await page.viewport(1440, 2810);
  show();
  for (const name of GROUPS)
    await expect.element(page.getByRole('heading', { name, exact: true }), FIRST).toBeVisible();
  await expect
    .element(page.getByRole('switch', { name: TARGET, exact: true }), FIRST)
    .toBeVisible();
  await expect.element(page.getByText('权限点', { exact: true }).first()).toBeVisible();
  await expect.element(page.getByText('与默认不同', { exact: true }).first()).toBeVisible();
  await expect
    .element(page.getByRole('switch', { name: 'agent.whitelist_only', exact: true }))
    .toBeDisabled();
  await expect.element(page.getByText('agent.model_route', { exact: true })).toBeVisible();
  await expect
    .element(page.elementLocator(document.getElementById('switch-requests')!), FIRST)
    .toHaveAttribute('data-pending', '0');
  await screenshot('admin-kill-switches-list');
});

it('[AC-F1-06zf-BROWSER#2] AdmSwitchOff：1440 宽关闭确认，影响、权限和动态码档可见', async () => {
  await page.viewport(1440, 1000);
  show();
  const toggle = page.getByRole('switch', { name: TARGET, exact: true });
  await expect.element(toggle, FIRST).toBeVisible();
  await toggle.click();
  const modal = page.getByRole('dialog');
  await expect.element(modal, FIRST).toBeVisible();
  await expect.element(modal.getByText(TARGET, { exact: true })).toBeVisible();
  await expect.element(modal.getByText(/10\s*秒/)).toBeVisible();
  await expect.element(modal.getByText(/switch\.all/)).toBeVisible();
  await expect.element(modal.getByText(/动态码|totp/).first()).toBeVisible();
  await expect.element(modal.getByRole('button', { name: '取消', exact: true })).toBeVisible();
  await expect.element(modal.getByRole('button', { name: /验证并|确认/ })).toBeVisible();
  await expect
    .element(page.elementLocator(document.getElementById('switch-requests')!), FIRST)
    .toHaveAttribute('data-pending', '0');
  for (const overlay of Array.from(document.querySelectorAll('.ant-modal, .ant-modal-mask')))
    await expect.element(page.elementLocator(overlay), FIRST).not.toHaveClass(MOTION);
  await screenshot('admin-kill-switches-off-confirm');
});
