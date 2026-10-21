/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { expect } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { BASE_URL, UID, createRelationsServer, invitees } from './relations-fixtures.ts';

export const FIRST = { timeout: 10_000 };
let root: Root | undefined;
export function unmount(): void {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
}
export async function showBrowser(): Promise<HTMLElement> {
  const server = createRelationsServer(invitees().slice(0, 12));
  const marker = document.createElement('span');
  marker.hidden = true;
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
      initialRoute: { menuId: 'users' },
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
  const detail = page.getByRole('main').getByRole('button', { name: `详情 ${UID}` });
  await expect.element(detail, FIRST).toBeVisible();
  await detail.click();
  await expect.element(page.getByRole('main'), FIRST).toMatchTextContent('K7QX2M');
  return marker;
}
export async function screenshot(name: string, marker: HTMLElement): Promise<void> {
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
  );
  const motion =
    /(?:^|\s)ant-(?:zoom|fade|move|slide)\b|-(?:appear|enter|leave)(?:-|\s|$)|-motion\b|-motion-/;
  for (const node of Array.from(document.querySelectorAll('[class]')).filter((node) =>
    motion.test(node.getAttribute('class') ?? ''),
  ))
    await expect.element(page.elementLocator(node), FIRST).not.toHaveClass(motion);
  const result = await page.screenshot({ base64: true, fullPage: true });
  const path = result.path.replace(/[^/]+$/, `${name}.png`);
  await commands.writeFile(path, result.base64, 'base64');
  if (path !== result.path) await commands.removeFile(result.path);
}
