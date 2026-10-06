/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/shell.ts';
import { CASES, labels, MENU, NO_PERMISSION_COPY } from './fixtures.ts';

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

for (const sample of [CASES[0]!, CASES[4]!]) {
  const screenshotName = sample.snapshot.isSuper ? 'admin-shell-super' : 'admin-home-no-perm';
  it(`[AC-F1-06e-BROWSER#1] ${screenshotName}`, async () => {
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
    });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    root.render(element);

    const sidebar = page.getByRole('navigation', { name: '主导航' });
    await expect.element(sidebar).toBeVisible();
    await expect.element(page.getByText('凑狸管理后台', { exact: true })).toBeVisible();
    for (const group of sample.groups)
      await expect
        .element(sidebar.getByRole('heading', { name: group, exact: true }))
        .toBeVisible();
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
    const ordered = sidebar
      .element()
      .querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],a[href]');
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
      await expect
        .element(page.getByRole('button', { name: '刷新权限', exact: true }))
        .toBeVisible();
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
}
