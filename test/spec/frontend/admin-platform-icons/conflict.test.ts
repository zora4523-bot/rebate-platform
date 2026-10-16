// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { jsonResponse } from '../admin-data/fixtures.ts';
import {
  ALIPAY_V1,
  isList,
  isVersions,
  isWrite,
  publishState,
  SOURCE_MISSING,
  VERSION_INVALID,
  type FakeServer,
} from './fixtures.ts';
import {
  button,
  cardsShown,
  cell,
  clean,
  click,
  dialog,
  dialogClosed,
  dialogs,
  expectText,
  FLOW_TIMEOUT,
  listTable,
  mainElement,
  mount,
  noButton,
  openHistory,
  settle,
  versionCards,
  writes,
} from './helpers.ts';

beforeEach(() => {
  installMediaQuery();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:30:00+08:00'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Another admin (ops-er) restored alipay's built-in image at 10-12 10:31 (sample-data §15). */
function restoredBehind(server: FakeServer): void {
  server.change('alipay', {
    current_version: null,
    current: null,
    revision: 4,
    updated_by: 'ops-er',
    updated_at: '2026-10-12T02:31:00Z',
  });
}

/** Opens 【回滚到此版】 of alipay version 1 in the history drawer. */
async function openRollback(): Promise<{ drawer: HTMLElement; modal: HTMLElement }> {
  await listTable();
  const drawer = await openHistory('alipay', '支付宝');
  const cards = await cardsShown(drawer, '支付宝', [3, 2, 1]);
  await click(button(cards.get(1)!, '回滚 支付宝 到版本 1'));
  return { drawer, modal: await dialog('回滚 支付宝 到版本 1') };
}

/** The open dialog titled `title`, looked up again (the error state may re-render it). */
function opened(title: string): HTMLElement {
  const found = dialogs(title);
  expect(found, `dialog 「${title}」`).toHaveLength(1);
  return found[0]!;
}

function alertIn(title: string): HTMLElement {
  const found = within(opened(title)).queryAllByRole('alert');
  expect(found, 'error bar (role=alert) at the top of the dialog').toHaveLength(1);
  return found[0]!;
}

it(
  '[AC-F1-06zd-CONFLICT#1] 回滚遇 20902：显示未生效与重读到的最新状态，不重发；【刷新版本历史】回到刷新后的抽屉',
  async () => {
    const h = mount();
    const { modal } = await openRollback();
    restoredBehind(h.server);
    await click(button(modal, '确认回滚'));

    await waitFor(() => expectText(alertIn('回滚 支付宝 到版本 1'), '回滚未生效'));
    const posted = h.server.log.findIndex(isWrite);
    expect(writes(h.server)).toEqual([
      {
        method: 'POST',
        path: '/admin/v1/platform-icons/alipay/publish',
        query: {},
        body: { version: 1, expected_revision: 3 },
      },
    ]);
    // 「最新状态」 comes from GET /admin/v1/platform-icons read after the 20902.
    await waitFor(() =>
      expectText(
        alertIn('回滚 支付宝 到版本 1'),
        '已重新读取最新状态：当前生效 内置图，最近变更 2026-10-12 10:31 ops-er。',
      ),
    );
    expect(h.server.log.slice(posted + 1).some(isList)).toBe(true);
    expectText(
      alertIn('回滚 支付宝 到版本 1'),
      '支付宝的标识在你打开后已被修改，本次没有做任何修改（20902）。',
      '请刷新版本历史后重新核对，再决定是否回滚到版本 1。',
    );
    expectText(opened('回滚 支付宝 到版本 1'), '你打开时的情况');
    noButton(opened('回滚 支付宝 到版本 1'), '确认回滚');
    expect(button(opened('回滚 支付宝 到版本 1'), '查看操作日志')).toBeTruthy();
    expect(mainElement().querySelectorAll('.ant-alert-success')).toHaveLength(0);

    const versionsBefore = h.server.log.filter(isVersions('alipay')).length;
    await click(button(opened('回滚 支付宝 到版本 1'), '刷新版本历史'));
    await dialogClosed('回滚 支付宝 到版本 1');
    await waitFor(() =>
      expect(h.server.log.filter(isVersions('alipay')).length).toBeGreaterThan(versionsBefore),
    );
    const drawer = await dialog('版本历史 · 支付宝');
    await waitFor(() => expectText(drawer, '10-12 10:31 · ops-er'));
    const cards = await cardsShown(drawer, '支付宝', [3, 2, 1]);
    // Built-in now: version 2 is no longer live and both published versions offer 【发布】.
    expect(cards.get(2)!.textContent).not.toContain('当前生效');
    expectText(cards.get(2)!, '曾发布');
    expect(button(cards.get(2)!, '发布 支付宝 版本 2').disabled).toBe(false);
    expect(button(cards.get(1)!, '发布 支付宝 版本 1').disabled).toBe(false);
    noButton(cards.get(1)!, /^回滚/);
    expect(writes(h.server)).toHaveLength(1);

    await click(within(drawer).getAllByRole('button', { name: '关闭' })[0]!);
    await dialogClosed('版本历史 · 支付宝');
    await waitFor(() => expect(clean(cell('alipay', '当前生效').textContent)).toMatch(/^内置图/));
    expect(button(cell('alipay', '操作'), '恢复内置 支付宝').disabled).toBe(true);
    expect(writes(h.server)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-CONFLICT#2] 发布遇 20902：标题「发布未生效」，最新状态取重读的当前版本与操作人',
  async () => {
    const h = mount(publishState());
    await listTable();
    const drawer = await openHistory('taobao', '淘宝');
    const cards = await cardsShown(drawer, '淘宝', [1]);
    await click(button(cards.get(1)!, '发布 淘宝 版本 1'));
    const modal = await dialog('发布 淘宝 版本 1');
    // Someone else published version 1 meanwhile (revision 0 → 1).
    const v1 = h.server.state.versions.get('taobao')![0]!;
    h.server.change('taobao', {
      current_version: 1,
      current: { ...v1, ever_published: true },
      revision: 1,
      updated_by: 'ops-er',
      updated_at: '2026-10-12T02:31:00Z',
    });
    await click(button(modal, '确认发布'));
    await waitFor(() =>
      expectText(
        alertIn('发布 淘宝 版本 1'),
        '发布未生效',
        '淘宝的标识在你打开后已被修改，本次没有做任何修改（20902）。',
        '已重新读取最新状态：当前生效 版本 1，最近变更 2026-10-12 10:31 ops-er。',
      ),
    );
    expect(writes(h.server).map((request) => request.body)).toEqual([
      { version: 1, expected_revision: 0 },
    ]);
    noButton(opened('发布 淘宝 版本 1'), '确认发布');
    expect(button(opened('发布 淘宝 版本 1'), '刷新版本历史')).toBeTruthy();
    expect(mainElement().querySelectorAll('.ant-alert-success')).toHaveLength(0);
    await settle();
    expect(writes(h.server)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-CONFLICT#3] 列表行恢复内置遇 20902：「恢复内置未生效」，【刷新版本历史】回到列表并重读',
  async () => {
    const h = mount();
    await listTable();
    await click(button(cell('alipay', '操作'), '恢复内置 支付宝'));
    const modal = await dialog('支付宝 恢复内置图');
    // Someone else rolled alipay back to version 1 meanwhile.
    h.server.change('alipay', {
      current_version: 1,
      current: { ...ALIPAY_V1 },
      revision: 4,
      updated_by: 'ops-er',
      updated_at: '2026-10-12T02:31:00Z',
    });
    await click(button(modal, '确认恢复内置'));
    await waitFor(() =>
      expectText(
        alertIn('支付宝 恢复内置图'),
        '恢复内置未生效',
        '支付宝的标识在你打开后已被修改，本次没有做任何修改（20902）。',
        '已重新读取最新状态：当前生效 版本 1，最近变更 2026-10-12 10:31 ops-er。',
      ),
    );
    expect(writes(h.server).map((request) => [request.path, request.body])).toEqual([
      ['/admin/v1/platform-icons/alipay/restore-builtin', { expected_revision: 3 }],
    ]);
    noButton(opened('支付宝 恢复内置图'), '确认恢复内置');
    const lists = h.server.log.filter(isList).length;
    await click(button(opened('支付宝 恢复内置图'), '刷新版本历史'));
    await dialogClosed('支付宝 恢复内置图');
    expect(dialogs('版本历史')).toHaveLength(0);
    await waitFor(() => expect(h.server.log.filter(isList).length).toBeGreaterThan(lists));
    await waitFor(() => expect(clean(cell('alipay', '当前生效').textContent)).toMatch(/^版本 1/));
    expectText(cell('alipay', '最近变更'), '10-12 10:31', 'ops-er');
    expect(writes(h.server)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-CONFLICT#4] 20902 后重读列表失败：只显示第一句与【刷新版本历史】，刷新后恢复',
  async () => {
    const h = mount();
    const { modal } = await openRollback();
    restoredBehind(h.server);
    h.server.once(isList, () => jsonResponse({ code: 50000, msg: '服务暂时不可用' }, 503));
    await click(button(modal, '确认回滚'));
    await waitFor(() => {
      const posted = h.server.log.findIndex(isWrite);
      expect(posted).toBeGreaterThanOrEqual(0);
      expect(h.server.log.slice(posted + 1).some(isList)).toBe(true);
    });
    await waitFor(() =>
      expectText(
        alertIn('回滚 支付宝 到版本 1'),
        '回滚未生效',
        '支付宝的标识在你打开后已被修改，本次没有做任何修改（20902）。',
      ),
    );
    await settle();
    expect(alertIn('回滚 支付宝 到版本 1').textContent).not.toContain('已重新读取最新状态');
    expect(button(opened('回滚 支付宝 到版本 1'), '刷新版本历史')).toBeTruthy();
    noButton(opened('回滚 支付宝 到版本 1'), '确认回滚');

    await click(button(opened('回滚 支付宝 到版本 1'), '刷新版本历史'));
    await dialogClosed('回滚 支付宝 到版本 1');
    const drawer = await dialog('版本历史 · 支付宝');
    await waitFor(() => expectText(drawer, '10-12 10:31 · ops-er'));
    await waitFor(() => {
      const card = versionCards(drawer, '支付宝').get(1);
      expect(card, 'card of version 1').toBeDefined();
      expect(button(card!, '发布 支付宝 版本 1').disabled).toBe(false);
    });
    expect(writes(h.server)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-CONFLICT#5] 回滚目标版本不存在（20001 fields=[version]）：弹窗顶部错误条 + 【刷新版本历史】，主按钮去掉',
  async () => {
    const h = mount();
    const { modal } = await openRollback();
    h.server.once(isWrite, () => jsonResponse(VERSION_INVALID, 400));
    await click(button(modal, '确认回滚'));
    await waitFor(() =>
      expectText(
        alertIn('回滚 支付宝 到版本 1'),
        '找不到这个版本，可能已被删除或地址有误；请刷新版本历史',
      ),
    );
    expect(alertIn('回滚 支付宝 到版本 1').textContent).not.toContain('20902');
    noButton(opened('回滚 支付宝 到版本 1'), '确认回滚');
    expect(dialogs('回滚 支付宝 到版本 1')).toHaveLength(1);
    expect(mainElement().querySelectorAll('.ant-alert-success')).toHaveLength(0);
    const versionsBefore = h.server.log.filter(isVersions('alipay')).length;
    await click(button(opened('回滚 支付宝 到版本 1'), '刷新版本历史'));
    await dialogClosed('回滚 支付宝 到版本 1');
    await waitFor(() =>
      expect(h.server.log.filter(isVersions('alipay')).length).toBeGreaterThan(versionsBefore),
    );
    expect(writes(h.server)).toHaveLength(1);
    expect(clean(cell('alipay', '当前生效').textContent)).toMatch(/^版本 2/);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-CONFLICT#6] 发布时服务端报缺来源登记（20001 source_missing 兜底）：弹窗顶部错误条，不当成功',
  async () => {
    const h = mount(publishState());
    await listTable();
    const drawer = await openHistory('taobao', '淘宝');
    const cards = await cardsShown(drawer, '淘宝', [1]);
    await click(button(cards.get(1)!, '发布 淘宝 版本 1'));
    const modal = await dialog('发布 淘宝 版本 1');
    h.server.once(isWrite, () => jsonResponse(SOURCE_MISSING, 400));
    await click(button(modal, '确认发布'));
    await waitFor(() => expectText(alertIn('发布 淘宝 版本 1'), '请先登记来源页地址与下载日期'));
    expect(alertIn('发布 淘宝 版本 1').textContent).not.toContain('未生效');
    expect(dialogs('发布 淘宝 版本 1')).toHaveLength(1);
    await settle();
    expect(mainElement().querySelectorAll('.ant-alert-success')).toHaveLength(0);
    expect(clean(cell('taobao', '当前生效').textContent)).toMatch(/^内置图/);
    expect(writes(h.server)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);
