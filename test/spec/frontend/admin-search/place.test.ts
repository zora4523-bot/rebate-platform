// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MENU } from '../admin-shell/fixtures.ts';
import { EMPTY, PLACEHOLDER, createServer } from './search-fixtures.ts';
import { FLOW_TIMEOUT, input, mount, region, submit, settled } from './search-helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it(
  '[AC-F1-07h-PLACE#1] 工作台与各有权限菜单共用顶栏搜索区域和占位文案',
  async () => {
    // Freeze the expected menu list independently of the implementation's menu registry.
    for (const menuId of ['dashboard', ...MENU.map((row) => row[1])]) {
      const { server } = await mount(createServer(), {
        initialRoute: { menuId },
        renderPage: (id) => createElement('div', null, `page:${id}`),
      });
      await waitFor(() => expect(screen.queryByText(`page:${menuId}`)).not.toBeNull());
      expect(within(await region()).queryAllByRole('textbox')).toHaveLength(1);
      expect((await input()).placeholder).toContain(PLACEHOLDER);
      expect(server.log).toHaveLength(0);
      cleanup();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-PLACE#2] 有权限页有搜索框，零权限账号的暂无权限页没有搜索框',
  async () => {
    // The positive half keeps this test red before the feature exists.
    await mount();
    expect(await input()).toBeDefined();
    cleanup();
    const server = createServer();
    await mount(server, {
      initialRoute: { menuId: '' },
      permissionsProvider: async () => ({ isSuper: false, permissions: [] }),
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: /刷新权限/ })).not.toBeNull());
    expect(screen.queryByRole('search')).toBeNull();
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();
    expect(server.log).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-PLACE#3] 仅有非搜索权限的登录账号仍可提交，由服务端返回裁剪后的空结果',
  async () => {
    const server = createServer(EMPTY);
    await mount(server, {
      permissionsProvider: async () => ({ isSuper: false, permissions: ['content.article'] }),
      initialRoute: { menuId: 'content' },
    });
    await submit('13800005678');
    await settled(server);
    expect(server.log).toHaveLength(1);
    expect(server.log[0]!.query).toEqual({ q: '13800005678' });
    await waitFor(() => expect(screen.queryByText(/没有找到/)).not.toBeNull());
  },
  FLOW_TIMEOUT,
);
