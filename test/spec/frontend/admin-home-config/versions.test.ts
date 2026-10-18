// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EDITED, VERSIONS, createServer, version } from './fixtures.ts';
import {
  button,
  click,
  editor,
  expectText,
  history,
  input,
  loaded,
  mainElement,
  mount,
  settled,
  versionRow,
  FLOW_TIMEOUT,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function cell(row: HTMLElement, title: RegExp): Element {
  const table = row.closest('table');
  expect(table).not.toBeNull();
  const index = within(table!)
    .getAllByRole('columnheader')
    .findIndex((node) => title.test(node.textContent ?? ''));
  expect(index).toBeGreaterThanOrEqual(0);
  expect(row.children[index]).toBeDefined();
  return row.children[index]!;
}

it(
  '[AC-F1-09l-VERSIONS#1] 历史展示版本、状态、页详情推导的灰度比例、计数、发布人和时间',
  async () => {
    const { server } = await mount();
    await loaded();
    await history(server);
    const draft = await versionRow(mainElement(), 8);
    const gray = await versionRow(mainElement(), 7);
    const full = await versionRow(mainElement(), 6);
    expect(draft.compareDocumentPosition(gray) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expectText(cell(draft, /状态/), '草稿');
    expectText(cell(gray, /灰度比例|比例/), '15%');
    expectText(cell(full, /灰度比例|比例/), '100%');
    for (const row of [draft, gray, full]) {
      expect(cell(row, /渲染次数/).textContent?.trim()).toBe('0');
      expect(cell(row, /错误次数/).textContent?.trim()).toBe('0');
    }
    expectText(cell(gray, /发布人/), 'ops-publisher');
    expect(cell(gray, /发布时间/).textContent).toMatch(/2026[-/]10[-/]17/);
    expectText(cell(await versionRow(mainElement(), 4), /状态/), '回滚');
    expect(
      within(mainElement()).queryAllByRole('button', { name: /对比|复制为草稿|回滚到此版/ }),
    ).toEqual([]);
    expect(server.requests('GET', VERSIONS)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-09l-VERSIONS#2] 查看历史 sections 是只读 JSON，返回编辑器保留未保存内容',
  async () => {
    const server = createServer();
    const oldSections = [{ id: 'historical-only', type: 'future_card', version: 1 }];
    server.history.get('home')!.find((entry) => entry.version === 5)!.sections = oldSections;
    await mount(server);
    await loaded();
    await input(editor(), EDITED);
    await history(server);
    await click(button(await versionRow(mainElement(), 5), /查看/));
    await waitFor(() => expect(server.requests('GET', `${VERSIONS}/5`)).toHaveLength(1));
    await settled(server);
    const jsonNodes = Array.from(document.querySelectorAll('textarea, pre, code')).filter((node) =>
      (node instanceof HTMLTextAreaElement ? node.value : (node.textContent ?? '')).includes(
        'historical-only',
      ),
    );
    expect(jsonNodes.length).toBeGreaterThan(0);
    for (const node of jsonNodes) {
      if (node instanceof HTMLTextAreaElement) {
        expect(node.readOnly || node.disabled).toBe(true);
        expect(JSON.parse(node.value)).toEqual(oldSections);
      } else {
        expect(node.getAttribute('contenteditable')).not.toBe('true');
        expect(JSON.parse(node.textContent ?? '')).toEqual(oldSections);
      }
    }
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (dialog) await click(button(dialog, /关闭|返回|取消/));
    await click(button(mainElement(), /返回编辑器/));
    expect(editor().value).toBe(EDITED);
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-09l-VERSIONS#3] 版本历史按服务端 page/page_size 翻页，不把首屏当全部历史',
  async () => {
    const server = createServer();
    // >200 makes a second page necessary even at the maximum contract page size.
    server.pages[0]!.latest_version = 208;
    server.history.set(
      'home',
      Array.from({ length: 208 }, (_, i) =>
        version(208 - i, { status: i === 0 ? 'draft' : 'published' }),
      ),
    );
    await mount(server);
    await loaded();
    await click(button(mainElement(), /版本历史/));
    await versionRow(mainElement(), 208);
    await settled(server);
    const first = server.requests('GET', VERSIONS)[0]!;
    const size = Number(first.query['page_size'] ?? 20);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(200);
    const next = mainElement().querySelector<HTMLElement>(
      '[title="Next Page"], [title="下一页"], [aria-label="Next Page"], [aria-label="下一页"]',
    );
    expect(next).not.toBeNull();
    await click(next!);
    await waitFor(() => expect(server.requests('GET', VERSIONS)).toHaveLength(2));
    await settled(server);
    expect(server.requests('GET', VERSIONS)[1]!.query).toEqual({
      page: '2',
      page_size: String(size),
    });
    await versionRow(mainElement(), 208 - size);
    expect(
      within(mainElement())
        .queryAllByRole('row')
        .some((node) => within(node).queryByText(/^v?208$/) !== null),
    ).toBe(false);
  },
  FLOW_TIMEOUT,
);
