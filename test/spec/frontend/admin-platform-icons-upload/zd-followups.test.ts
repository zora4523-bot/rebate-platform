// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { isList, version } from '../admin-platform-icons/fixtures.ts';
import {
  button,
  cardsShown,
  cell,
  clean,
  click,
  dialog,
  dialogClosed,
  expectText,
  listTable,
  openHistory,
  settle,
  writes,
} from '../admin-platform-icons/helpers.ts';
import { boardState, createUploadServer } from './fixtures.ts';
import { FLOW_TIMEOUT, mountUpload } from './helpers.ts';

// Two S2 findings of the F1-06zd review, folded into this task by the orchestrator:
// ① the CAS revision of publish / rollback / restore-builtin is the mark's revision as the
//   confirmation dialog showed it when it opened, even if a list re-read arrives meanwhile;
// ② the version history pages through an antd Pagination that only shows 上一页 / 下一页.

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

it(
  '[AC-F1-06ze-REVISION#1] 恢复内置确认用弹窗打开时的 revision：打开后列表重读带来新 revision，确认仍发旧值并走 20902 冲突提示',
  async () => {
    const server = createUploadServer();
    mountUpload(server);
    await listTable();
    // Another admin re-published alipay (revision 3 → 4) before the list is read again.
    server.change('alipay', {
      revision: 4,
      updated_by: 'ops-er',
      updated_at: '2026-10-12T02:31:00Z',
    });
    // Closing the drawer re-reads the list; that read (already with revision 4) arrives only
    // after the confirmation dialog was opened from the row (which still shows revision 3).
    const drawer = await openHistory('alipay', '支付宝');
    await cardsShown(drawer, '支付宝', [3, 2, 1]);
    const late = server.hold(isList);
    const lists = server.log.filter(isList).length;
    await click(within(drawer).getAllByRole('button', { name: '关闭' })[0]!);
    await dialogClosed('版本历史 · 支付宝');
    await waitFor(() => expect(server.log.filter(isList)).toHaveLength(lists + 1));
    try {
      const restore = button(cell('alipay', '操作'), '恢复内置 支付宝');
      expect(restore.disabled, 'the row stays usable while the list is re-read').toBe(false);
      await click(restore);
      const modal = await dialog('支付宝 恢复内置图');
      await act(async () => late.release());
      await settle();
      // The re-read has arrived (the row shows the other admin's change) while the dialog is open.
      await waitFor(() =>
        expect(clean(cell('alipay', '最近变更').textContent)).toContain('ops-er'),
      );
      await click(button(modal, '确认恢复内置'));
      await waitFor(() => expect(writes(server)).toHaveLength(1));
      expect(writes(server)[0]!.path).toBe('/admin/v1/platform-icons/alipay/restore-builtin');
      expect(writes(server)[0]!.body, 'revision seen when the dialog opened').toEqual({
        expected_revision: 3,
      });
      const alert = await waitFor(() => within(modal).getByRole('alert'));
      expectText(alert, '恢复内置未生效', '（20902）');
      await settle();
      expect(writes(server)).toHaveLength(1);
      expect(clean(cell('alipay', '当前生效').textContent)).toMatch(/^版本 2/);
    } finally {
      late.release();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06ze-PAGINATION#1] 版本历史分页是 antd Pagination：只露【上一页】【下一页】，翻页仍每次只请求那一页',
  async () => {
    const state = boardState();
    state.icons.set('alipay', { ...state.icons.get('alipay')!, latest_version: 45 });
    state.versions.set('alipay', [
      ...state.versions.get('alipay')!,
      ...Array.from({ length: 42 }, (_, index) =>
        version('alipay', index + 4, { created_at: '2026-10-10T02:00:00Z' }),
      ),
    ]);
    const server = createUploadServer(state);
    mountUpload(server);
    await listTable();
    const drawer = await openHistory('alipay', '支付宝');
    await waitFor(() => expectText(drawer, '共 45 个版本 · 每页 20 个 · 第 1 / 3 页'));
    const previous = button(drawer, '上一页');
    const next = button(drawer, '下一页');
    const pager = previous.closest<HTMLElement>('.ant-pagination');
    expect(pager, '【上一页】 is inside an antd Pagination').not.toBeNull();
    expect(next.closest('.ant-pagination'), 'both buttons in the same Pagination').toBe(pager);
    // Only the two buttons show: no page numbers, jumpers, size changer or quick jumper.
    expect(
      pager!.querySelectorAll(
        '.ant-pagination-item, .ant-pagination-jump-prev, .ant-pagination-jump-next, .ant-pagination-options, .ant-pagination-simple-pager, input, select',
      ),
    ).toHaveLength(0);
    expect(within(pager!).queryAllByRole('link')).toEqual([]);
    expect(
      within(pager!)
        .queryAllByRole('button')
        .map((item) => clean(item.textContent))
        .filter((text) => text !== ''),
    ).toEqual(['上一页', '下一页']);
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    const pages = () =>
      server.log
        .filter((request) => request.path === '/admin/v1/platform-icons/alipay/versions')
        .map((request) => request.query['page']);
    expect(pages()).toEqual(['1']);
    await click(next);
    await waitFor(() => expectText(drawer, '第 2 / 3 页'));
    await cardsShown(
      drawer,
      '支付宝',
      Array.from({ length: 20 }, (_, index) => 25 - index),
    );
    expect(pages()).toEqual(['1', '2']);
    await click(button(drawer, '下一页'));
    await waitFor(() => expectText(drawer, '第 3 / 3 页'));
    expect(button(drawer, '下一页').disabled).toBe(true);
    expect(button(drawer, '上一页').closest('.ant-pagination')).not.toBeNull();
    expect(pages()).toEqual(['1', '2', '3']);
  },
  FLOW_TIMEOUT,
);
