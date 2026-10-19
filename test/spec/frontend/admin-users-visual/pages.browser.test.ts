/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { BASE_URL, LIST, UID, createServer, rows } from '../admin-users/fixtures.ts';

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

function show(server = createServer()): HTMLElement {
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
  // Let React's final update and CSS transitions reach the next painted frame first.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
  );
  for (const node of Array.from(document.querySelectorAll('[class]')).filter((node) =>
    MOTION.test(node.getAttribute('class') ?? ''),
  ))
    await expect.element(page.elementLocator(node), FIRST).not.toHaveClass(MOTION);
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  const image = await page.screenshot({ base64: true, fullPage: true });
  const path = image.path.replace(/[^/]+$/, `${name}.png`);
  await commands.writeFile(path, image.base64, 'base64');
  if (path !== image.path) await commands.removeFile(image.path);
}

async function chooseRisk(label: string): Promise<void> {
  const filter = page.getByRole('main').getByRole('combobox', { name: /风控状态/ });
  await expect.element(filter, FIRST).toBeVisible();
  await filter.click();
  await expect.element(filter, FIRST).toHaveAttribute('aria-expanded', 'true');
  const dropdown = document.querySelector<HTMLElement>(
    '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
  );
  await expect.element(dropdown, FIRST).toBeVisible();
  // Match the visible option content, as in the shared jsdom filterRisk helper:
  // table Tags and rc-select's virtual accessibility mirror are not click targets.
  const option = Array.from(
    dropdown!.querySelectorAll<HTMLElement>('.ant-select-item-option-content'),
  ).find((node) => node.textContent?.trim() === label);
  await expect.element(option ?? null, FIRST).toBeVisible();
  await page.elementLocator(option!).click();
}

it('[AC-F1-07j-BROWSER#1] 1440 定稿用户查询：上方标签、具名行操作、已应用条', async () => {
  await page.viewport(1440, 1040);
  const marker = show(createServer(rows().slice(0, 8)));
  const main = page.getByRole('main');
  await expect.element(main.getByText(UID, { exact: true }), FIRST).toBeVisible();
  await expect.element(main.getByText('用户查询列表', { exact: true })).toBeVisible();
  await expect.element(main.getByText('UID 或手机号', { exact: true })).toBeVisible();
  await expect
    .element(main.getByRole('button', { name: `详情 ${UID}`, exact: true }))
    .toBeVisible();
  await chooseRisk('正常');
  const bar = page.getByText('已应用', { exact: true });
  await expect.element(bar, FIRST).toBeVisible();
  const summary = page.elementLocator(
    bar.element().closest('[aria-live="polite"]') ?? bar.element(),
  );
  await expect.element(summary).toHaveAttribute('aria-live', 'polite');
  await expect.element(summary.getByRole('table', { includeHidden: true })).not.toBeInTheDocument();
  await expect
    .element(summary.element().querySelector<HTMLElement>('.ant-pagination'))
    .not.toBeInTheDocument();
  await expect.element(summary).toBeVisible();
  expect(summary.element().textContent).toContain('共 7 条');
  await expect
    .element(main.getByRole('button', { name: `详情 ${UID}`, exact: true }))
    .toBeVisible();
  await screenshot('admin-users-list-final', marker);
});

it('[AC-F1-07j-BROWSER#2] 1440 空态：当前条件、重置入口和空态图', async () => {
  await page.viewport(1440, 1040);
  const marker = show(createServer([]));
  const main = page.getByRole('main');
  await expect.element(main.getByText('没有符合条件的用户', { exact: true }), FIRST).toBeVisible();
  await expect.element(main.getByText('用户查询列表', { exact: true })).toBeVisible();
  await expect.element(main.getByText(/当前条件[：:]/)).toBeVisible();
  await expect.element(main.getByRole('button', { name: '重置条件', exact: true })).toBeVisible();
  await screenshot('admin-users-empty', marker);
});

it('[AC-F1-07j-BROWSER#3] 1440 出错态：保留输入、错误说明、重试入口', async () => {
  await page.viewport(1440, 1040);
  const server = createServer();
  server.once('GET', LIST, () => Promise.reject(new Error('synthetic offline')));
  const marker = show(server);
  const main = page.getByRole('main');
  await expect.element(main.getByText('列表加载失败', { exact: true }), FIRST).toBeVisible();
  const lookup = main.getByRole('textbox');
  await expect.element(lookup, FIRST).toBeVisible();
  await lookup.fill('13800005678');
  await expect
    .element(
      main.getByText('网络错误或服务异常；已填条件保留，点【重试】按同样条件重新请求。', {
        exact: true,
      }),
    )
    .toBeVisible();
  await expect.element(lookup).toHaveValue('13800005678');
  await expect.element(main.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await screenshot('admin-users-error', marker);
});

it('[AC-F1-07j-BROWSER#4] 1440 定稿详情：标题 UID 和状态、竖排信息、具名只读联盟表', async () => {
  await page.viewport(1440, 1160);
  const marker = show();
  const main = page.getByRole('main');
  const open = main.getByRole('button', { name: /^详情(?:\s|$)/ }).first();
  await expect.element(open, FIRST).toBeVisible();
  await open.click();
  await expect.element(main.getByText('K7QX2M', { exact: true }), FIRST).toBeVisible();
  const heading = main.getByRole('heading', { name: '用户详情', exact: true });
  await expect.element(heading).toBeVisible();
  const back = main.getByRole('button', { name: '返回用户查询', exact: true });
  await expect.element(back).toBeVisible();
  let header = heading.element().parentElement;
  while (header && header !== main.element() && !header.contains(back.element()))
    header = header.parentElement;
  await expect.element(header).toBeVisible();
  const titleRow = page.elementLocator(header!);
  await expect
    .element(titleRow.getByRole('button', { name: '返回用户查询', exact: true }))
    .toBeVisible();
  await expect.element(titleRow.getByText('基本信息', { exact: true })).not.toBeInTheDocument();
  await expect.element(titleRow.getByText(UID, { exact: true })).toBeVisible();
  await expect.element(titleRow.getByText('正常', { exact: true })).toBeVisible();
  await expect.element(main.getByText('基本信息', { exact: true })).toBeVisible();
  await expect
    .element(main.getByRole('button', { name: '返回用户查询', exact: true }))
    .toBeVisible();
  const bindings = main.getByRole('table', { name: '联盟授权', exact: true });
  await expect.element(bindings).toBeVisible();
  await expect.element(bindings.getByText('active', { exact: true })).toBeVisible();
  await expect.element(bindings.getByRole('button')).not.toBeInTheDocument();
  await screenshot('admin-user-detail-final', marker);
});
