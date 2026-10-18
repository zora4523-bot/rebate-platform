// @vitest-environment jsdom
import { act, cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HOME, VERSIONS, createServer, noGray } from './fixtures.ts';
import {
  action,
  button,
  click,
  confirm,
  enabled,
  history,
  input,
  loaded,
  mainElement,
  message,
  modal,
  mount,
  noStepUp,
  settled,
  versionRow,
  FLOW_TIMEOUT,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  {
    id: 1,
    kind: 'adjust',
    label: /调整比例/,
    endpoint: 'gray',
    body: { gray_percent: 45, expected_revision: 19 },
  },
  {
    id: 2,
    kind: 'full',
    label: /转为全量/,
    endpoint: 'gray',
    body: { gray_percent: 100, expected_revision: 19 },
  },
  {
    id: 3,
    kind: 'stop',
    label: /停止灰度/,
    endpoint: 'rollback',
    body: { version: 7, expected_revision: 19 },
  },
  {
    id: 4,
    kind: 'rollback',
    label: /^回滚$/,
    endpoint: 'rollback',
    body: { version: 6, expected_revision: 19 },
  },
])(
  '[AC-F1-09l-GRAY#$id] $kind 用当前页 revision，重复点击仅一次且重读状态',
  async ({ kind, label, endpoint, body }) => {
    const server = createServer(kind === 'rollback' ? [noGray()] : undefined);
    await mount(server);
    await loaded();
    await history(server);
    const before = server.requests('GET', HOME).length;
    const beforeVersions = server.requests('GET', VERSIONS).length;
    const release = server.hold('POST', `${HOME}/${endpoint}`);
    try {
      if (kind === 'adjust') {
        await click(button(mainElement(), label));
        const dialog = await modal();
        await input(within(dialog).getByRole('spinbutton', { name: /比例/ }), '45');
        await confirm(dialog, true);
        expect(enabled(button(dialog, /^(确认|确定|保存|调整)/))).toBe(false);
      } else {
        const scope = kind === 'rollback' ? await versionRow(mainElement(), 6) : mainElement();
        await action(button(scope, label), true);
      }
      await waitFor(() => expect(server.requests('POST', `${HOME}/${endpoint}`)).toHaveLength(1));
      expect(server.requests('POST', `${HOME}/${endpoint}`)[0]!.body).toEqual(body);
      // All remaining destructive controls are blocked while this page write is in flight.
      expect(
        within(mainElement())
          .queryAllByRole('button', { name: /^(调整比例|转为全量|停止灰度|回滚|发布)$/ })
          .every((node) => !enabled(node)),
      ).toBe(true);
    } finally {
      await act(async () => release());
    }
    await waitFor(() => expect(server.requests('GET', HOME).length).toBeGreaterThan(before));
    await waitFor(() =>
      expect(server.requests('GET', VERSIONS).length).toBeGreaterThan(beforeVersions),
    );
    await settled(server);
    expect(server.requests('POST')).toHaveLength(1);
    noStepUp(server);
    if (kind === 'adjust') expect(mainElement().textContent).toContain('45%');
    if (kind === 'full' || kind === 'stop') expect(mainElement().textContent).toMatch(/无灰度/);
    if (kind === 'rollback') expect(server.pages[0]!.current_version).toBe(5);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-09l-GRAY#5] 无灰度时显示无灰度，不出现灰度操作；仅当前全量可回滚',
  async () => {
    const { server } = await mount(createServer([noGray()]));
    await loaded();
    await history(server);
    expect(mainElement().textContent).toMatch(/无灰度/);
    expect(
      within(mainElement()).queryAllByRole('button', { name: /调整比例|转为全量|停止灰度/ }),
    ).toEqual([]);
    expect(enabled(button(await versionRow(mainElement(), 6), /^回滚$/))).toBe(true);
    for (const n of [8, 7, 5, 4])
      expect(
        within(await versionRow(mainElement(), n)).queryAllByRole('button', { name: /回滚/ }),
      ).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-09l-ROLLBACK#1] 当前灰度版本行回滚传灰度版本号',
  async () => {
    const { server } = await mount();
    await loaded();
    await history(server);
    await action(button(await versionRow(mainElement(), 7), /^回滚$/));
    await settled(server);
    expect(server.requests('POST', `${HOME}/rollback`)).toHaveLength(1);
    expect(server.requests('POST', `${HOME}/rollback`)[0]!.body).toEqual({
      version: 7,
      expected_revision: 19,
    });
    expect(server.pages[0]!.current_version).toBe(6);
    await message(/无灰度/);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-09l-ROLLBACK#2] 有灰度时不能回滚全量：阻止操作或展示服务端 version 错误',
  async () => {
    const { server } = await mount();
    await loaded();
    await history(server);
    const controls = within(await versionRow(mainElement(), 6)).queryAllByRole('button', {
      name: /^回滚$/,
    });
    const control = controls.find(enabled);
    if (control) {
      await action(control);
      await message(/version|先.*灰度|灰度.*(停止|全量|回滚)/);
      expect(server.requests('POST', `${HOME}/rollback`)).toHaveLength(1);
    } else expect(controls.every((node) => !enabled(node))).toBe(true);
    expect(server.pages[0]!.current_version).toBe(6);
    expect(server.pages[0]!.gray_version).toBe(7);
  },
  FLOW_TIMEOUT,
);

it.each([
  { id: 6, value: '0' },
  { id: 7, value: '100' },
  { id: 8, value: '2.5' },
])(
  '[AC-F1-09l-GRAY#$id] 调整灰度对 $value 不作自动取整或静默转全量',
  async ({ value }) => {
    const { server } = await mount();
    await loaded();
    await history(server);
    await click(button(mainElement(), /调整比例/));
    const dialog = await modal();
    await input(within(dialog).getByRole('spinbutton', { name: /比例/ }), value);
    await confirm(dialog);
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    await message(/1.*99|整数/);
  },
  FLOW_TIMEOUT,
);
