// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HOME, LIST, SECTIONS, VERSIONS, config, createServer, failure, ok } from './fixtures.ts';
import {
  button,
  choosePage,
  click,
  editor,
  enabled,
  expectText,
  loaded,
  mainElement,
  mount,
  settled,
  FLOW_TIMEOUT,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it(
  '[AC-F1-09l-LOAD#1] 优先 home，顺序读取列表、页详情和最新 sections；状态、修改人及只读区块摘要',
  async () => {
    const server = createServer([config({ page_key: 'custom:campaign' }), config()]);
    // Stale list metadata must not override the page detail's revision/latest version.
    server.once('GET', LIST, () =>
      ok({
        items: [
          config({ page_key: 'custom:campaign' }),
          config({ revision: 2, latest_version: 5 }),
        ],
        page: 1,
        page_size: 20,
        total: 2,
      }),
    );
    const { directFetch } = await mount(server);
    await loaded();
    await settled(server);
    expect(JSON.parse(editor().value)).toEqual(SECTIONS);
    for (const path of [LIST, HOME, `${VERSIONS}/8`])
      expect(server.requests('GET', path)).toHaveLength(1);
    expect(server.log.findIndex((entry) => entry.path === LIST)).toBeLessThan(
      server.log.findIndex((entry) => entry.path === HOME),
    );
    expect(server.log.findIndex((entry) => entry.path === HOME)).toBeLessThan(
      server.log.findIndex((entry) => entry.path === `${VERSIONS}/8`),
    );
    expect(server.requests('GET', `${VERSIONS}/5`)).toEqual([]);
    expectText(mainElement(), '草稿', 'v8', '全量', 'v6', '灰度', 'v7', '15%', 'ops-editor');
    expect(mainElement().textContent).toMatch(/2026[-/]10[-/]18/);
    // Remove JSON surfaces so editor text cannot stand in for the required left-hand list.
    const summary = mainElement().cloneNode(true) as HTMLElement;
    for (const node of summary.querySelectorAll('textarea, pre, code')) node.remove();
    expectText(
      summary,
      'banner',
      'hero',
      '全部用户',
      'product_grid',
      'member-grid',
      'login',
      'has_order',
    );
    const text = summary.textContent ?? '';
    expect(text.indexOf('hero')).toBeLessThan(text.indexOf('member-grid'));
    expect(within(mainElement()).queryAllByRole('button', { name: /添加区块|校验/ })).toEqual([]);
    expect(within(mainElement()).queryByRole('tab', { name: /表单/ })).toBeNull();
    expect(server.requests('POST')).toEqual([]);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-09l-LOAD#2] 没有 home 时选第一项，切页重新读取对应详情与最新内容',
  async () => {
    const server = createServer([
      config({ page_key: 'custom:first' }),
      config({ page_key: 'custom:second' }),
    ]);
    server.history.get('custom:second')![0]!.sections = [
      { id: 'second-page-card', type: 'future_card', version: 1 },
    ];
    await mount(server);
    await loaded();
    expect(
      server.requests('GET', `${LIST}/custom%3Afirst`).length +
        server.requests('GET', `${LIST}/custom:first`).length,
    ).toBe(1);
    await choosePage('custom:second');
    await waitFor(() => expect(editor().value).toContain('second-page-card'));
    expect(server.requests('GET', HOME)).toEqual([]);
    expect(editor().value).not.toContain('member-grid');
  },
  FLOW_TIMEOUT,
);

it('[AC-F1-09l-LOAD#3] 列表空时给空态与可保存的空数组', async () => {
  const { server } = await mount(createServer([]));
  await waitFor(() => expect(editor().value.trim()).toBe('[]'));
  expect(mainElement().textContent).toMatch(/暂无|尚无|没有/);
  expect(enabled(button(mainElement(), /保存草稿/))).toBe(true);
  expect(server.requests('GET').some((entry) => /versions\/0$/.test(entry.path))).toBe(false);
  expect(server.requests('POST')).toEqual([]);
});

it('[AC-F1-09l-LOAD#4] 列表在途显示加载态且不能写，完成后展示编辑器', async () => {
  const server = createServer();
  const release = server.hold('GET', LIST);
  try {
    await mount(server);
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(1));
    expect(
      /加载/.test(mainElement().textContent ?? '') ||
        mainElement().querySelector('[aria-busy="true"], .ant-spin-spinning') !== null,
    ).toBe(true);
    expect(
      within(mainElement())
        .queryAllByRole('button', { name: /保存草稿|发布/ })
        .every((node) => !enabled(node)),
    ).toBe(true);
  } finally {
    await act(async () => release());
  }
  await loaded();
  expect(server.requests('POST')).toEqual([]);
});

it('[AC-F1-09l-LOAD#5] 读取失败显式重试一次，不自行重试', async () => {
  const server = createServer();
  server.once('GET', LIST, () => {
    throw new Error('offline');
  });
  await mount(server);
  await waitFor(() => expect(button(mainElement(), /重试/)).toBeDefined());
  await settled(server);
  expect(server.requests('GET', LIST)).toHaveLength(1);
  await click(button(mainElement(), /重试/));
  await loaded();
  await settled(server);
  expect(server.requests('GET', LIST)).toHaveLength(2);
});

it('[AC-F1-09l-LOAD#6] 10403 显示无权限态并裁掉编辑与发布操作', async () => {
  const server = createServer();
  server.once('GET', HOME, () => failure(10403));
  await mount(server);
  await waitFor(() => expect(mainElement().textContent).toMatch(/无权限|没有权限/));
  expect(
    within(mainElement()).queryAllByRole('button', { name: /保存草稿|发布|预览|回滚/ }),
  ).toEqual([]);
  expect(server.requests('POST')).toEqual([]);
});

it('[AC-F1-09l-LOAD#7] 默认 pages 路由实际接入首页配置页，content.page 单权限可访问', async () => {
  const { server } = await mount(createServer(), undefined, true);
  await loaded();
  expect(enabled(button(mainElement(), /保存草稿/))).toBe(true);
  expect(server.requests('GET', LIST)).toHaveLength(1);
});

it('[AC-F1-09l-LOAD#8] 缺 content.page 的直接页面挂载也拒绝读写', async () => {
  const { server } = await mount(createServer(), {
    isSuper: false,
    permissions: ['config.general'],
  });
  await waitFor(() => expect(mainElement().textContent).toMatch(/无权限|没有权限/));
  expect(
    within(mainElement()).queryAllByRole('button', { name: /保存草稿|发布|预览|回滚/ }),
  ).toEqual([]);
  expect(server.log).toEqual([]);
  expect(screen.queryByRole('menuitem', { name: /首页配置/ })).toBeNull();
});
