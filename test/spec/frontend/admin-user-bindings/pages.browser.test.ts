/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import {
  BASE_URL,
  OTP,
  REASON,
  ROW_VERSION,
  UID,
  activeUser,
  bindingPath,
  createServer,
  type Server,
} from './bindings-fixtures.ts';

// The real users route of the admin app in Chromium: 【详情】 of the user, 【停用返利】 of the taobao
// row, its confirmation dialog with the reason, the totp step-up and the one disable POST; the row
// then shows 已停用 and offers 【恢复】. Only the reads, the step-up and that write go out.
const FIRST = { timeout: 10_000 };
const DISMISS = /^(?:取消|关闭|返回|Close|Cancel)$/i;
const MOTION =
  /(?:^|\s)ant-(?:zoom|fade|move|slide)\b|-(?:appear|enter|leave)(?:-|\s|$)|-motion\b|-motion-/;

let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

/** Renders the shell over `server`; the marker's data-pending counts requests in flight. */
function show(server: Server): HTMLElement {
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
  return marker;
}

async function screenshot(name: string, marker: HTMLElement): Promise<void> {
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  await document.fonts.ready;
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
  );
  for (const overlay of Array.from(
    document.querySelectorAll('.ant-modal, .ant-modal-mask, .ant-drawer'),
  ))
    await expect.element(page.elementLocator(overlay), FIRST).not.toHaveClass(MOTION);
  const image = await page.screenshot({ base64: true, fullPage: true });
  const path = image.path.replace(/[^/]+$/, `${name}.png`);
  await commands.writeFile(path, image.base64, 'base64');
  if (path !== image.path) await commands.removeFile(image.path);
}

/** The one button of `dialog` that does not dismiss it. */
function submitIn(dialog: Element): HTMLElement {
  const buttons = Array.from(dialog.querySelectorAll<HTMLElement>('button')).filter((node) => {
    const text = (node.textContent ?? '').replace(/\s+/g, '');
    return (
      node.closest('.ant-modal-close, .ant-select, label') === null &&
      text !== '' &&
      !DISMISS.test(text)
    );
  });
  expect(buttons, 'one submit button in the dialog').toHaveLength(1);
  return buttons[0]!;
}

it('[AC-F1-07jc-BROWSER#1] 1440 超管：联盟授权表有「操作」列，淘宝行【停用返利】→ 确认框（原因）→ 动态码 → 一次 POST …/taobao/disable，该行变已停用并出现【恢复】；只发读、动态码与这一个写', async () => {
  await page.viewport(1440, 1100);
  const server = createServer(activeUser(), { writes: ['taobao/disable'] });
  const marker = show(server);
  const main = page.getByRole('main');
  const open = main.getByRole('button', { name: `详情 ${UID}` });
  await expect.element(open, FIRST).toBeVisible();
  await open.click();

  const table = main.getByRole('table', { name: '联盟授权', exact: true });
  await expect.element(table, FIRST).toBeVisible();
  await expect
    .element(table.getByRole('columnheader', { name: '操作', exact: true }), FIRST)
    .toBeVisible();
  const taobao = table.getByRole('row').filter({ hasText: '淘宝' });
  const disable = taobao.getByRole('button', { name: /^停用返利/ });
  await expect.element(disable, FIRST).toBeVisible();
  await expect.element(taobao.getByRole('button', { name: /^重置授权/ }), FIRST).toBeVisible();
  for (const action of table.getByRole('button').elements())
    expect((action.textContent ?? '').replace(/\s+/g, '')).toMatch(/^(?:重置授权|停用返利|恢复)/);
  expect(server.requests('POST'), 'reading the detail sends no POST').toEqual([]);
  await disable.click();

  const dialog = page.getByRole('dialog');
  await expect.element(dialog, FIRST).toBeVisible();
  await expect.element(dialog).toMatchTextContent(/淘宝/);
  // Task wording (不再返利 / 停止返利) or the board's (只能无返利购买).
  await expect.element(dialog).toMatchTextContent(/(?:不再|停止|暂停|不).{0,4}返利|无返利/);
  await dialog.getByRole('textbox', { name: /原因/ }).fill(REASON);
  expect(server.requests('POST'), 'nothing sent when the dialog opens').toEqual([]);
  await screenshot('admin-user-union-disable', marker);
  await page.elementLocator(submitIn(dialog.element())).click();

  const verification = page.getByRole('dialog', { name: '二次验证 · 动态码' });
  await expect.element(verification, FIRST).toBeVisible();
  expect(server.writes(), 'no disable before the step-up').toEqual([]);
  await verification.getByLabelText('动态码', { exact: true }).fill(OTP);
  await verification.getByRole('button', { name: '验证并继续' }).click();

  await expect.element(taobao, FIRST).toMatchTextContent(/已停用|blocked/);
  await expect.element(taobao.getByRole('button', { name: /^恢复/ }), FIRST).toBeVisible();
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  expect(server.writes()).toHaveLength(1);
  const write = server.writes()[0]!;
  expect(write.path).toBe(bindingPath('taobao', 'disable'));
  expect(write.body).toEqual({ reason: REASON, expected_row_version: ROW_VERSION.taobao });
  expect(write.headers.get('X-Step-Up-Token')).toBe(server.issued[0]);
  expect(write.headers.has('Idempotency-Key')).toBe(false);
  expect(server.strays()).toEqual([]);
});
