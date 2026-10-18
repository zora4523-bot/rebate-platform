// @vitest-environment jsdom
import { act, cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HOME, VERSIONS, config, createServer, noGray } from './fixtures.ts';
import {
  button,
  click,
  confirm,
  enabled,
  history,
  input,
  loaded,
  mainElement,
  message,
  mount,
  noStepUp,
  publish,
  settled,
  versionRow,
  FLOW_TIMEOUT,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  { id: 1, percent: 1 },
  { id: 2, percent: 99 },
  { id: 3, percent: 100 },
])(
  '[AC-F1-09l-PUBLISH#$id] 发布草稿 $percent%，只用契约字段、无二次验证，成功重读详情与版本表',
  async ({ percent }) => {
    const server = createServer([noGray()]);
    await mount(server);
    await loaded();
    const modal = await publish();
    expect(within(modal).queryAllByRole('textbox', { name: /发布说明/ })).toEqual([]);
    await click(within(modal).getByRole('radio', { name: percent === 100 ? /全量/ : /^灰度/ }));
    if (percent !== 100)
      await input(within(modal).getByRole('spinbutton', { name: /比例/ }), String(percent));
    const detailReads = server.requests('GET', HOME).length;
    const versionReads = server.requests('GET', VERSIONS).length;
    const release = server.hold('POST', `${HOME}/publish`);
    try {
      await confirm(modal, true);
      await waitFor(() => expect(server.requests('POST', `${HOME}/publish`)).toHaveLength(1));
      expect(server.requests('POST', `${HOME}/publish`)[0]!.body).toEqual({
        version: 8,
        gray_percent: percent,
        expected_revision: 19,
      });
      expect(enabled(button(modal, /^(确认|确定|发布)/))).toBe(false);
    } finally {
      await act(async () => release());
    }
    await waitFor(() => expect(server.requests('GET', HOME).length).toBeGreaterThan(detailReads));
    await waitFor(() =>
      expect(server.requests('GET', VERSIONS).length).toBeGreaterThan(versionReads),
    );
    await settled(server);
    expect(server.requests('POST')).toHaveLength(1);
    noStepUp(server);
    expect(mainElement().textContent).toMatch(percent === 100 ? /全量/ : new RegExp(`${percent}%`));
  },
  FLOW_TIMEOUT,
);

it.each([
  { id: 4, value: '0' },
  { id: 5, value: '100' },
  { id: 6, value: '1.5' },
  { id: 7, value: '' },
])(
  '[AC-F1-09l-PUBLISH#$id] 灰度输入 $value 不是 1–99 整数时不能提交',
  async ({ value }) => {
    const { server } = await mount(createServer([noGray()]));
    await loaded();
    const modal = await publish();
    await click(within(modal).getByRole('radio', { name: /^灰度/ }));
    await input(within(modal).getByRole('spinbutton', { name: /比例/ }), value);
    await confirm(modal);
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    await message(/1.*99|整数|比例.*必填|请输入.*比例/);
  },
  FLOW_TIMEOUT,
);

it('[AC-F1-09l-PUBLISH#8] 无全量版本只能发布全量 100', async () => {
  const server = createServer([
    config({ current_version: null, gray_version: null, gray_percent: 0 }),
  ]);
  await mount(server);
  await loaded();
  const modal = await publish();
  const gray = within(modal).queryByRole('radio', { name: /^灰度/ });
  expect(gray === null || !enabled(gray)).toBe(true);
  await click(within(modal).getByRole('radio', { name: /全量/ }));
  await confirm(modal);
  await settled(server);
  expect(server.requests('POST', `${HOME}/publish`)[0]!.body).toEqual({
    version: 8,
    gray_percent: 100,
    expected_revision: 19,
  });
});

it('[AC-F1-09l-PUBLISH#9] 取消发布不写入', async () => {
  const { server } = await mount(createServer([noGray()]));
  await loaded();
  await click(button(await publish(), /取消/));
  await settled(server);
  expect(server.requests('POST')).toEqual([]);
});

it(
  '[AC-F1-09l-PUBLISH#10] 历史中只允许草稿发布；已发布和已回滚版本不提供发布',
  async () => {
    const { server } = await mount(createServer([noGray()]));
    await loaded();
    await history(server);
    expect(enabled(button(await versionRow(mainElement(), 8), /^发布$/))).toBe(true);
    for (const n of [7, 6, 5, 4])
      expect(
        within(await versionRow(mainElement(), n)).queryAllByRole('button', { name: /^发布$/ }),
      ).toEqual([]);
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it('[AC-F1-09l-PUBLISH#11] 已有灰度时不能发另一草稿；由前端阻止或显示服务端 version 错误', async () => {
  const { server } = await mount();
  await loaded();
  const controls = within(mainElement()).queryAllByRole('button', { name: /^发布$/ });
  if (controls.some(enabled)) {
    const modal = await publish();
    await click(within(modal).getByRole('radio', { name: /全量/ }));
    await confirm(modal);
    await message(/version|先.*灰度|灰度.*(停止|全量|发布)/);
    expect(server.pages[0]!.current_version).toBe(6);
    expect(server.pages[0]!.gray_version).toBe(7);
    expect(server.requests('POST', `${HOME}/publish`)).toHaveLength(1);
  } else expect(controls.every((node) => !enabled(node))).toBe(true);
});

it('[AC-F1-09l-PUBLISH#12] 最新已存版本已经发布时编辑器不能再次发布它', async () => {
  const server = createServer([config({ latest_version: 6, gray_version: null, gray_percent: 0 })]);
  server.history.set(
    'home',
    server.history.get('home')!.filter((entry) => entry.version <= 6),
  );
  await mount(server);
  await loaded();
  const controls = within(mainElement()).queryAllByRole('button', { name: /^发布$/ });
  expect(controls.every((node) => !enabled(node))).toBe(true);
  expect(server.requests('POST')).toEqual([]);
});
