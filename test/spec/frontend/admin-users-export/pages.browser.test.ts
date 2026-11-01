/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { BASE_URL, UID, createServer, type Server } from './export-fixtures.ts';

// The real users route of the admin app in Chromium: the title row's 【导出】 (and its confirmation,
// if the page asks), one masked POST /admin/v1/exports, the created notice, then 【导出记录】 and
// the new task on the existing 导出记录 page. Only the list, that POST and the tasks are requested.
const FIRST = { timeout: 10_000 };
/** 「已创建导出任务」 and the like (a 「未创建成功」 or a word about 导出记录 is not). */
const SUCCESS =
  /(?<![未没不非有])(?:已|成功)(?:创建|提交|发起)[^，。；,;！!]{0,6}导出(?!记录)|导出(?!记录)[^，。；,;！!]{0,6}?(?<![未没不非])(?:已创建|创建成功|已提交|提交成功|已发起|发起成功)/;
const DISMISS = /^(?:取消|关闭|返回|Close|Cancel)$/i;
const FIELD_PARTS =
  '.ant-modal-close, .ant-select, .ant-checkbox-wrapper, .ant-switch, [role="switch"], .ant-radio-group, .ant-radio-wrapper, [role="radiogroup"], label';
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
    document.querySelectorAll('.ant-modal, .ant-modal-mask, .ant-message-notice'),
  ))
    await expect.element(page.elementLocator(overlay), FIRST).not.toHaveClass(MOTION);
  const image = await page.screenshot({ base64: true, fullPage: true });
  const path = image.path.replace(/[^/]+$/, `${name}.png`);
  await commands.writeFile(path, image.base64, 'base64');
  if (path !== image.path) await commands.removeFile(image.path);
}

function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}

/** The export confirmation shown outside the main area (a dialog or a pop-confirm), if any. */
function openConfirmation(): HTMLElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"], .ant-popconfirm'),
  ).find((node) => node.closest('main') === null && node.getClientRects().length > 0);
}

/** The one button of `layer` that does not dismiss it (field controls left out). */
function submitIn(layer: Element): HTMLElement {
  const buttons = Array.from(layer.querySelectorAll<HTMLElement>('button')).filter((node) => {
    const text = squash(node.textContent);
    return (
      node.closest(FIELD_PARTS) === null &&
      text !== '' &&
      !/导出记录/.test(text) &&
      !DISMISS.test(text)
    );
  });
  expect(buttons, 'one submit button in the export confirmation').toHaveLength(1);
  return buttons[0]!;
}

it('[AC-F1-07je-BROWSER#1] 1440 超管在用户查询标题行点【导出】（若先确认则确认）→ 一次脱敏 POST /admin/v1/exports（无令牌、无 Idempotency-Key、不弹动态码），提示已创建导出任务并指向导出记录；【导出记录】进入导出记录页并列出新任务；只发列表、这次导出与导出记录的请求', async () => {
  await page.viewport(1440, 1100);
  const server = createServer({ exports: true, records: true });
  const marker = show(server);
  const main = page.getByRole('main');
  await expect.element(main.getByRole('button', { name: `详情 ${UID}` }), FIRST).toBeVisible();
  const exportButton = main.getByRole('button', { name: /^导\s*出$/ });
  const records = main
    .getByRole('link', { name: '导出记录', exact: true })
    .or(main.getByRole('button', { name: '导出记录', exact: true }));
  await expect.element(exportButton, FIRST).toBeVisible();
  await expect.element(records, FIRST).toBeVisible();
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  expect(server.nonReads(), 'opening the list sends no POST').toEqual([]);

  await exportButton.click();
  const created = page.getByText(SUCCESS).first();
  await expect
    .element(created.or(page.getByRole('dialog')).or(page.getByRole('tooltip')).first(), FIRST)
    .toBeVisible();
  if (server.exportPosts().length === 0) {
    // The page asks first: confirm it (the full-number choice, if any, left as it is).
    const layer = openConfirmation();
    expect(layer, 'a POST or an export confirmation after 【导出】').toBeDefined();
    await page.elementLocator(submitIn(layer!)).click();
  }
  await expect.element(created, FIRST).toBeVisible();
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  expect(page.getByRole('dialog', { name: /二次验证|动态码/ }).elements()).toEqual([]);
  expect(server.exportPosts(), 'one POST /admin/v1/exports').toHaveLength(1);
  const post = server.exportPosts()[0]!;
  const body = post.body as Record<string, unknown>;
  const { filters, ...rest } = body;
  expect(rest, 'only resource besides filters').toStrictEqual({ resource: 'users' });
  expect(filters ?? {}, 'no filter applied').toStrictEqual({});
  expect(post.headers.has('X-Step-Up-Token')).toBe(false);
  expect(post.headers.has('Idempotency-Key')).toBe(false);
  expect(server.verifies()).toEqual([]);
  expect(server.tasks).toHaveLength(1);
  await screenshot('admin-users-export', marker);

  const recordsHeading = main.getByRole('heading', { name: '导出记录', exact: true });
  // Unless the page went to 导出记录 by itself, the title row's entry leads there.
  if (recordsHeading.elements().length === 0) await records.first().click();
  await expect.element(recordsHeading, FIRST).toBeVisible();
  await expect
    .element(main.getByRole('cell', { name: server.tasks[0]!.id, exact: true }), FIRST)
    .toBeVisible();
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  expect(server.exportPosts(), 'looking at 导出记录 creates no other task').toHaveLength(1);
  expect(server.strays()).toEqual([]);
}, 60_000);
