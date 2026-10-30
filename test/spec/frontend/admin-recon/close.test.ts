// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ID,
  REF,
  STATUS_NAME,
  VIEW_GRANTS,
  closePath,
  createServer,
  rejected,
} from './fixtures.ts';
import {
  COLUMN,
  FLOW_TIMEOUT,
  LABEL,
  SUBMIT,
  action,
  assertClose,
  assertNoStepUp,
  cellText,
  click,
  closeEntries,
  fieldError,
  fill,
  freshText,
  mount,
  openClose,
  openDetail,
  openDialogs,
  reasonDialogs,
  settle,
  settled,
  snapshotText,
  squash,
  submitClose,
  tellsReleased,
  textbox,
} from './helpers.ts';

const DONE = /已关闭|关闭成功|已结案|结案成功/;

it(
  '[AC-F1-08e-CLOSE#1] 处理中的差错单【已关闭（不处理）】：对话框提示会解除提现冻结，填原因提交 POST close（Idempotency-Key + {reason}，不弹动态码），成功提示已解除 2 笔冻结，状态变为「已关闭（不处理）」且入口消失',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openClose(server, REF.channel, ID.channel);
    expect(squash(modal.textContent), 'the dialog says withdrawal holds are released').toMatch(
      /冻结/,
    );
    expect(server.closes()).toEqual([]);
    const before = snapshotText();
    await submitClose(modal, '  通道已退回，无需处理  ');
    await waitFor(() => expect(server.closes(ID.channel)).toHaveLength(1));
    await settled(server);
    assertClose(server.closes(ID.channel)[0]!, '通道已退回，无需处理');
    assertNoStepUp(server);
    expect(server.item(ID.channel).status).toBe('closed');
    await waitFor(() => {
      const fresh = freshText(before);
      expect(fresh).toMatch(DONE);
      expect(tellsReleased(fresh, 2), `2 released holds in 「${fresh}」`).toBe(true);
    });
    await waitFor(() =>
      expect(squash(cellText(REF.channel, COLUMN.status))).toContain(STATUS_NAME.closed),
    );
    expect(closeEntries(REF.channel)).toEqual([]);
    expect(reasonDialogs()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-CLOSE#2] 没有提现冻结的待处理差错单关闭：照样给结案成功提示，提示里出现 0',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openClose(server, REF.appeal, ID.appeal);
    const before = snapshotText();
    await submitClose(modal, '申诉恢复已在支付侧处理');
    await waitFor(() => expect(server.closes(ID.appeal)).toHaveLength(1));
    await settled(server);
    assertClose(server.closes(ID.appeal)[0]!, '申诉恢复已在支付侧处理');
    await waitFor(() => {
      const fresh = freshText(before);
      expect(fresh).toMatch(DONE);
      expect(tellsReleased(fresh, 0), `0 released holds in 「${fresh}」`).toBe(true);
    });
    await waitFor(() =>
      expect(squash(cellText(REF.appeal, COLUMN.status))).toContain(STATUS_NAME.closed),
    );
    expect(closeEntries(REF.appeal)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-CLOSE#3] 原因为空或全是空白：不发请求，在原因字段旁提示，对话框不关',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openClose(server, REF.ledger, ID.ledger);
    await click(action(modal, SUBMIT));
    await settle();
    await waitFor(() => expect(fieldError(textbox(modal, LABEL.reason))).not.toBe(''));
    expect(server.closes()).toEqual([]);
    await fill(textbox(modal, LABEL.reason), '   ');
    await click(action(modal, SUBMIT));
    await settle();
    await settled(server);
    await waitFor(() => expect(fieldError(textbox(modal, LABEL.reason))).not.toBe(''));
    expect(server.closes()).toEqual([]);
    expect(reasonDialogs()).toHaveLength(1);
    expect(server.item(ID.ledger).status).toBe('open');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-CLOSE#4] 服务端 20001 data.fields=[reason]：在原因字段旁提示，对话框不关、状态不变',
  async () => {
    const server = createServer();
    server.once('POST', closePath(ID.ledger), () => rejected(['reason']));
    await mount(server);
    const modal = await openClose(server, REF.ledger, ID.ledger);
    await submitClose(modal, '账实差异已查明');
    await waitFor(() => expect(server.closes(ID.ledger)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(fieldError(textbox(modal, LABEL.reason))).not.toBe(''));
    expect(reasonDialogs()).toHaveLength(1);
    expect(squash(cellText(REF.ledger, COLUMN.status))).toContain(STATUS_NAME.open);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-CLOSE#5] 只持 fund.view：列表与详情都没有可用的【已关闭（不处理）】，不发 POST',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(server);
    for (const [ref, id] of [
      [REF.ledger, ID.ledger],
      [REF.channel, ID.channel],
    ] as const) {
      await openDetail(server, ref, id);
      expect(closeEntries(ref), `${ref} no usable close entry`).toEqual([]);
    }
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    expect(reasonDialogs()).toEqual([]);
    expect(openDialogs().length, 'the drawers opened').toBeGreaterThan(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-CLOSE#6] 已关闭 / 已调账 / 已核销的差错单（持 fund.recon）：列表与详情都没有可用的【已关闭（不处理）】，待处理与处理中的有',
  async () => {
    const server = createServer();
    await mount(server);
    for (const [ref, id] of [
      [REF.union, ID.union],
      [REF.monthEnd, ID.monthEnd],
      [REF.settle, ID.settle],
    ] as const) {
      await openDetail(server, ref, id);
      expect(closeEntries(ref), `${ref} no usable close entry`).toEqual([]);
    }
    for (const [ref, id] of [
      [REF.ledger, ID.ledger],
      [REF.channel, ID.channel],
    ] as const) {
      await openDetail(server, ref, id);
      expect(closeEntries(ref).length, `${ref} a usable close entry`).toBeGreaterThan(0);
    }
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);
