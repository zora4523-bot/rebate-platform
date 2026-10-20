/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/shell.ts';
import { CASES, labels, MENU, NO_PERMISSION_COPY, shellDataOptions } from './fixtures.ts';

let root: Root | undefined;

afterEach(() => {
  try {
    root?.unmount();
  } finally {
    root = undefined;
    document.body.replaceChildren();
    window.history.replaceState(null, '', '/');
  }
});

async function expectShellSample(
  sample: (typeof CASES)[number],
  screenshotName: string,
): Promise<void> {
  await page.viewport(1440, 900);
  // The factory throws before React schedules work during the skeleton phase, so red is
  // NotImplemented rather than an uncaught asynchronous React error or missing-module error.
  const element = createAdminShell({
    permissionsProvider: async () => sample.snapshot,
    account: {
      username: sample.snapshot.isSuper ? 'super.admin' : 'cs.xiaoli',
      displayName: sample.name,
    },
    environment: 'test',
    onLogout: () => {},
    ...shellDataOptions(),
  });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(element);

  const sidebar = page.getByRole('navigation', { name: '主导航' });
  await expect.element(sidebar).toBeVisible();
  await expect.element(page.getByText('凑狸管理后台', { exact: true })).toBeVisible();
  for (const group of sample.groups)
    await expect.element(sidebar.getByRole('heading', { name: group, exact: true })).toBeVisible();
  for (const label of labels(sample.ids))
    await expect.element(sidebar.getByRole('link', { name: label, exact: true })).toBeVisible();
  expect(
    sidebar
      .getByRole('heading')
      .elements()
      .map((node) => node.textContent?.trim()),
  ).toEqual(sample.groups);
  expect(
    sidebar
      .getByRole('link')
      .elements()
      .map((node) => node.textContent?.trim()),
  ).toEqual(labels(sample.ids));

  // Include group headings in the visual-order check, not just DOM order. Overflow may
  // scroll vertically: all entries must be reachable within the sidebar's scroll content.
  const ordered = sidebar.element().querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],a[href]');
  const expectedOrder = sample.groups.flatMap((group) => [
    group,
    ...MENU.filter((row) => row[0] === group && sample.ids.includes(row[1])).map((row) => row[2]),
  ]);
  expect(Array.from(ordered, (node) => node.textContent?.trim())).toEqual(expectedOrder);
  const bounds = Array.from(ordered, (node) => node.getBoundingClientRect());
  for (let index = 1; index < bounds.length; index++)
    expect(bounds[index]!.top).toBeGreaterThanOrEqual(bounds[index - 1]!.bottom);
  expect(sidebar.element().getBoundingClientRect().width).toBeCloseTo(220, 0);
  const banner = page.getByRole('banner');
  await expect.element(banner).toBeVisible();
  await expect.element(banner.getByText('测试环境', { exact: true })).toBeVisible();
  await expect.element(banner.getByText(sample.name, { exact: true })).toBeVisible();
  await expect.element(banner.getByRole('button', { name: '退出', exact: true })).toBeVisible();
  expect(banner.element().getBoundingClientRect().height).toBeCloseTo(56, 0);
  expect(banner.element().getBoundingClientRect().left).toBeCloseTo(220, 0);
  if (!sample.snapshot.isSuper) {
    await expect.element(page.getByText(NO_PERMISSION_COPY.title, { exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: '刷新权限', exact: true })).toBeVisible();
    await expect.element(page.getByRole('link', { name: '查看报表', exact: true })).toBeVisible();
  } else {
    await expect
      .element(page.getByText(NO_PERMISSION_COPY.title, { exact: true }))
      .not.toBeInTheDocument();
  }
  expect(window.innerWidth).toBe(1440);
  expect(window.innerHeight).toBe(900);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1440);
  await document.fonts.ready;
  // Take exactly one screenshot, using Vitest's configured export directory. Save its
  // bytes under the fixed artifact basename and remove the automatic test-title filename.
  const screenshot = await page.screenshot({
    base64: true,
    fullPage: false,
  });
  const fixedPath = screenshot.path.replace(/[^/]+$/, `${screenshotName}.png`);
  await commands.writeFile(fixedPath, screenshot.base64, 'base64');
  if (fixedPath !== screenshot.path) await commands.removeFile(screenshot.path);
  const saved = await commands.readFile(fixedPath, 'base64');
  expect(saved).toBe(screenshot.base64);
  const png = Uint8Array.from(atob(saved), (character) => character.charCodeAt(0));
  expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer);
  expect(view.getUint32(16)).toBe(1440);
  expect(view.getUint32(20)).toBe(900);
}

// Literal titles, one case per sample (bodies unchanged, moved into the helper above) so the
// guard can tell the cases apart: a later change to one account's case leaves the others
// unchanged (F1-06zm, D10-92).
it('[AC-F1-06e-BROWSER#1] admin-shell-super', async () => {
  const { createDataProvider } = await import('../../../../apps/admin/src/providers/data/index.ts');
  const { BASE_URL, createServer } = await import('../admin-dashboard/dashboard-fixtures.ts');
  const sample = CASES[0]!;
  const screenshotName = 'admin-shell-super';
  await page.viewport(1440, 900);
  // The factory throws before React schedules work during the skeleton phase, so red is
  // NotImplemented rather than an uncaught asynchronous React error or missing-module error.
  const element = createAdminShell({
    permissionsProvider: async () => sample.snapshot,
    account: {
      username: sample.snapshot.isSuper ? 'super.admin' : 'cs.xiaoli',
      displayName: sample.name,
    },
    environment: 'test',
    onLogout: () => {},
    // F-ADM-26: the super admin lands on the workbench, which reads GET /admin/v1/dashboard.
    dataProvider: createDataProvider({
      baseUrl: BASE_URL,
      fetch: createServer().fetch,
      getToken: () => 'example-admin-token',
      onError: () => {},
    }),
  });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(element);

  const sidebar = page.getByRole('navigation', { name: '主导航' });
  await expect.element(sidebar).toBeVisible();
  await expect.element(sidebar.getByRole('link').first()).toHaveTextContent('工作台');
  await expect.element(page.getByText('凑狸管理后台', { exact: true })).toBeVisible();
  for (const group of sample.groups)
    await expect.element(sidebar.getByRole('heading', { name: group, exact: true })).toBeVisible();
  for (const label of labels(sample.ids))
    await expect.element(sidebar.getByRole('link', { name: label, exact: true })).toBeVisible();
  expect(
    sidebar
      .getByRole('heading')
      .elements()
      .map((node) => node.textContent?.trim())
      .filter((label) => label !== '工作台'),
  ).toEqual(sample.groups);
  expect(
    sidebar
      .getByRole('link')
      .elements()
      .map((node) => node.textContent?.trim()),
  ).toEqual(['工作台', ...labels(sample.ids)]);

  // Include group headings in the visual-order check, not just DOM order. Overflow may
  // scroll vertically: all entries must be reachable within the sidebar's scroll content.
  const ordered = Array.from(
    sidebar.element().querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],a[href]'),
  ).filter((node) => node.tagName === 'A' || node.textContent?.trim() !== '工作台');
  const expectedOrder = sample.groups.flatMap((group) => [
    group,
    ...MENU.filter((row) => row[0] === group && sample.ids.includes(row[1])).map((row) => row[2]),
  ]);
  expect(Array.from(ordered, (node) => node.textContent?.trim())).toEqual([
    '工作台',
    ...expectedOrder,
  ]);
  const bounds = Array.from(ordered, (node) => node.getBoundingClientRect());
  for (let index = 1; index < bounds.length; index++)
    expect(bounds[index]!.top).toBeGreaterThanOrEqual(bounds[index - 1]!.bottom);
  expect(sidebar.element().getBoundingClientRect().width).toBeCloseTo(220, 0);
  const banner = page.getByRole('banner');
  await expect.element(banner).toBeVisible();
  await expect.element(banner.getByText('测试环境', { exact: true })).toBeVisible();
  await expect.element(banner.getByText(sample.name, { exact: true })).toBeVisible();
  await expect.element(banner.getByRole('button', { name: '退出', exact: true })).toBeVisible();
  expect(banner.element().getBoundingClientRect().height).toBeCloseTo(56, 0);
  expect(banner.element().getBoundingClientRect().left).toBeCloseTo(220, 0);
  if (!sample.snapshot.isSuper) {
    await expect.element(page.getByText(NO_PERMISSION_COPY.title, { exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: '刷新权限', exact: true })).toBeVisible();
    await expect.element(page.getByRole('link', { name: '查看报表', exact: true })).toBeVisible();
  } else {
    await expect
      .element(page.getByText(NO_PERMISSION_COPY.title, { exact: true }))
      .not.toBeInTheDocument();
  }
  expect(window.innerWidth).toBe(1440);
  expect(window.innerHeight).toBe(900);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1440);
  await document.fonts.ready;
  // Take exactly one screenshot, using Vitest's configured export directory. Save its
  // bytes under the fixed artifact basename and remove the automatic test-title filename.
  const screenshot = await page.screenshot({
    base64: true,
    fullPage: false,
  });
  const fixedPath = screenshot.path.replace(/[^/]+$/, `${screenshotName}.png`);
  await commands.writeFile(fixedPath, screenshot.base64, 'base64');
  if (fixedPath !== screenshot.path) await commands.removeFile(screenshot.path);
  const saved = await commands.readFile(fixedPath, 'base64');
  expect(saved).toBe(screenshot.base64);
  const png = Uint8Array.from(atob(saved), (character) => character.charCodeAt(0));
  expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer);
  expect(view.getUint32(16)).toBe(1440);
  expect(view.getUint32(20)).toBe(900);
});

it('[AC-F1-06e-BROWSER#1] admin-home-no-perm', async () => {
  await expectShellSample(CASES[4]!, 'admin-home-no-perm');
});
