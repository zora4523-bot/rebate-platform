// @vitest-environment jsdom
import { act, fireEvent, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { EXPORTS, createServer, failure, offline, type Server } from './export-fixtures.ts';
import {
  EXPORT,
  FLOW_TIMEOUT,
  HINT,
  SUPER,
  actions,
  announce,
  announceSuccess,
  before,
  click,
  closeConfirmations,
  confirmations,
  expectMasked,
  expectNoSuccess,
  exportMasked,
  filterRisk,
  main,
  mount,
  onRecords,
  required,
  settle,
  settled,
  stepUpDialogs,
  submitOf,
  type Sent,
} from './export-helpers.ts';

/** Exports again after a failure: the dialog still open is submitted, else 【导出】 again. */
async function exportAgain(server: Server): Promise<Sent> {
  const layers = confirmations();
  if (layers.length !== 1) return exportMasked(server);
  const posts = server.exportPosts().length;
  const prior = before();
  await click(submitOf(layers[0]!));
  await waitFor(() => expect(server.exportPosts().length).toBe(posts + 1));
  expect(stepUpDialogs()).toEqual([]);
  return { post: server.exportPosts().at(-1)!, prior };
}

it(
  '[AC-F1-07je-ERROR#1] 创建导出回 10403：提示无权限，不显示已创建，不跳走，不自动重发',
  async () => {
    const server = createServer({ exports: true });
    server.once('POST', EXPORTS, () => failure(10403, { reason: 'admin_permission_denied' }));
    await mount(server, SUPER);
    const { post, prior } = await exportMasked(server);
    expectMasked(post, {});
    await settled(server);
    await announce(prior, HINT.forbidden);
    expectNoSuccess(prior);
    expect(onRecords(), 'stays on the list').toBe(false);
    await settle();
    expect(server.exportPosts(), 'not sent again by itself').toHaveLength(1);
    expect(server.tasks).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07je-ERROR#2] 创建导出回 20001（filters）：在对话框内或提示里说明，不显示已创建，不自动重发',
  async () => {
    const server = createServer({ exports: true });
    server.once('POST', EXPORTS, () => failure(20001, { fields: ['filters'] }));
    await mount(server, SUPER);
    await filterRisk(server, 'appealing');
    const { post, prior } = await exportMasked(server);
    expectMasked(post, { risk_state: 'appealing' });
    await settled(server);
    await announce(prior, HINT.invalid);
    expectNoSuccess(prior);
    expect(onRecords(), 'stays on the list').toBe(false);
    await settle();
    expect(server.exportPosts()).toHaveLength(1);
    expect(server.tasks).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07je-ERROR#3] 网络失败：提示失败，不显示已创建；之后再点一次导出会再发一次 POST（同样的脱敏 body），这次 202 提示已创建',
  async () => {
    const server = createServer({ exports: true });
    server.once('POST', EXPORTS, () => offline());
    await mount(server, SUPER);
    await filterRisk(server, 'frozen');
    const failed = await exportMasked(server);
    expectMasked(failed.post, { risk_state: 'frozen' });
    await settled(server);
    await announce(failed.prior, HINT.failed);
    expectNoSuccess(failed.prior);
    expect(onRecords(), 'stays on the list').toBe(false);
    await settle();
    expect(server.exportPosts(), 'not sent again by itself').toHaveLength(1);
    expect(server.tasks).toEqual([]);

    const again = await exportAgain(server);
    expectMasked(again.post, { risk_state: 'frozen' });
    await settled(server);
    expect(server.exportPosts()).toHaveLength(2);
    expect(server.tasks).toHaveLength(1);
    await announceSuccess(again.prior);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07je-ERROR#4] 连点只发一次：双击【导出】（及确认）只发一个 POST，请求在途时再点也不再发；应答 202 后提示已创建，再点一次导出会再建一个新任务',
  async () => {
    const server = createServer({ exports: true, records: true });
    const release = server.hold('POST', EXPORTS);
    await mount(server, SUPER);
    let held: Sent | undefined;
    try {
      held = await exportMasked(server, true);
      await settle();
      expect(server.exportPosts(), 'a double press sends one POST').toHaveLength(1);
      // Pressed once more while the request is in flight (greyed or not), and confirmed if a new
      // dialog asks.
      const shown = confirmations().length;
      const entries = actions(main(), EXPORT);
      expect(entries.length, '【导出】 is still on the page').toBeGreaterThan(0);
      await act(async () => {
        fireEvent.click(entries[0]!);
      });
      await settle();
      if (confirmations().length > shown && confirmations().length === 1) {
        await click(submitOf(confirmations()[0]!));
        await settle();
      }
      expect(server.exportPosts(), 'nothing more while the export is in flight').toHaveLength(1);
    } finally {
      release();
    }
    const first = required(held, 'the first export');
    await settled(server);
    expectMasked(first.post, {});
    expect(server.exportPosts()).toHaveLength(1);
    expect(server.tasks).toHaveLength(1);
    await announceSuccess(first.prior);
    // Pressed again afterwards: a new task (on the list, unless the page went to 导出记录).
    if (!onRecords()) {
      if (confirmations().length > 0) await closeConfirmations();
      const second = await exportMasked(server);
      expectMasked(second.post, {});
      await settled(server);
      expect(server.exportPosts()).toHaveLength(2);
      expect(server.tasks, 'each export is a new task').toHaveLength(2);
      await announceSuccess(second.prior);
    }
  },
  FLOW_TIMEOUT,
);
