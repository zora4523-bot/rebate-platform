// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EDITED, HOME, VERSIONS, createServer, failure, noGray } from './fixtures.ts';
import {
  action,
  button,
  click,
  confirm,
  editor,
  history,
  input,
  loaded,
  mainElement,
  message,
  modal,
  mount,
  publish,
  settled,
  versionRow,
  FLOW_TIMEOUT,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Operation = 'versions' | 'publish' | 'gray' | 'rollback' | 'preview-tokens';
async function perform(operation: Operation): Promise<void> {
  if (operation === 'versions') await click(button(mainElement(), /保存草稿/));
  if (operation === 'publish') {
    const dialog = await publish();
    await click(within(dialog).getByRole('radio', { name: /全量/ }));
    await confirm(dialog);
  }
  if (operation === 'gray') {
    await click(button(mainElement(), /调整比例/));
    const dialog = await modal();
    await input(within(dialog).getByRole('spinbutton', { name: /比例/ }), '30');
    await confirm(dialog);
  }
  if (operation === 'rollback') await action(button(await versionRow(mainElement(), 6), /^回滚$/));
  if (operation === 'preview-tokens') await action(button(mainElement(), /草稿预览/));
}

it.each([
  { id: 1, operation: 'versions' },
  { id: 2, operation: 'publish' },
  { id: 3, operation: 'gray' },
  { id: 4, operation: 'rollback' },
] as const)(
  '[AC-F1-09l-ERRORS#$id] $operation 的 20902 重读页详情、保留编辑、不自动重发',
  async ({ operation }) => {
    const server = createServer(operation === 'gray' ? undefined : [noGray()]);
    await mount(server);
    await loaded();
    await input(editor(), EDITED);
    if (operation === 'gray' || operation === 'rollback') await history(server);
    const before = server.requests('GET', HOME).length;
    server.once('POST', `${HOME}/${operation}`, () => {
      server.pages[0]!.revision = 41;
      server.pages[0]!.updated_by = 'another-editor';
      return failure(20902, { resource: 'page' });
    });
    await perform(operation);
    await message(/页面已被他人修改/);
    await waitFor(() => expect(server.requests('GET', HOME).length).toBeGreaterThan(before));
    await settled(server);
    expect(server.requests('POST')).toHaveLength(1);
    if (operation === 'gray' || operation === 'rollback')
      await click(button(mainElement(), /返回编辑器/));
    expect(editor().value).toBe(EDITED);
    // A fresh, explicit user action must use the reread page revision, never version 8 / stale 19.
    await click(button(mainElement(), /保存草稿/));
    await waitFor(() => expect(server.requests('POST')).toHaveLength(2));
    expect(server.requests('POST').at(-1)!.body).toEqual({
      sections: JSON.parse(EDITED),
      expected_revision: 41,
    });
  },
  FLOW_TIMEOUT,
);

it.each([
  { id: 5, operation: 'versions', kind: 'network' },
  { id: 6, operation: 'publish', kind: 'parse' },
  { id: 7, operation: 'gray', kind: 'network' },
  { id: 8, operation: 'rollback', kind: 'parse' },
  { id: 9, operation: 'preview-tokens', kind: 'network' },
] as const)(
  '[AC-F1-09l-ERRORS#$id] $operation $kind 异常显示结果未知并重读，不能当成功或自动重发',
  async ({ operation, kind }) => {
    const server = createServer(operation === 'gray' ? undefined : [noGray()]);
    await mount(server);
    await loaded();
    await input(editor(), EDITED);
    if (operation === 'gray' || operation === 'rollback') await history(server);
    const before = server.requests('GET', HOME).length;
    server.once('POST', `${HOME}/${operation}`, () => {
      if (kind === 'network') throw new Error('connection closed after request');
      return new Response('{invalid response', { status: 200 });
    });
    await perform(operation);
    await message(/结果未知|结果.*不确定|无法确认.*结果/);
    await waitFor(() => expect(server.requests('GET', HOME).length).toBeGreaterThan(before));
    await settled(server);
    expect(server.requests('POST')).toHaveLength(1);
    if (operation === 'gray' || operation === 'rollback')
      await click(button(mainElement(), /返回编辑器/));
    expect(editor().value).toBe(EDITED);
  },
  FLOW_TIMEOUT,
);

it('[AC-F1-09l-ERRORS#10] 选中页 30701 作为未存版本的空页，以 revision 0 存第一版', async () => {
  const server = createServer();
  server.once('GET', HOME, () => {
    server.pages.length = 0;
    server.history.clear();
    return failure(30701);
  });
  await mount(server);
  await waitFor(() => expect(editor().value.trim()).toBe('[]'));
  expect(mainElement().textContent).toMatch(/暂无|尚无|没有/);
  expect(server.requests('GET', `${VERSIONS}/8`)).toEqual([]);
  await click(button(mainElement(), /保存草稿/));
  await settled(server);
  expect(server.requests('POST', VERSIONS)[0]!.body).toEqual({
    sections: [],
    expected_revision: 0,
  });
});

it('[AC-F1-09l-ERRORS#11] 写时权限被撤销 10403 后裁掉写控件，不显示成功或继续提交', async () => {
  const server = createServer();
  server.once('POST', VERSIONS, () => failure(10403));
  await mount(server);
  await loaded();
  await click(button(mainElement(), /保存草稿/));
  await message(/无权限|没有权限/);
  expect(
    within(mainElement()).queryAllByRole('button', { name: /保存草稿|发布|预览|回滚/ }),
  ).toEqual([]);
  await settled(server);
  expect(server.requests('POST')).toHaveLength(1);
});
