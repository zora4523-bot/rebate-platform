// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ID,
  REF,
  STATUS_NAME,
  changedBody,
  closePath,
  createServer,
  detailPath,
  inProgress,
} from './fixtures.ts';
import {
  CANCEL,
  CHANGED,
  COLUMN,
  CONFLICT,
  FLOW_TIMEOUT,
  RUNNING,
  SUBMIT,
  action,
  assertClose,
  cellText,
  click,
  closeEntries,
  freshText,
  mount,
  openClose,
  reasonDialog,
  reasonDialogs,
  requestKey,
  settle,
  settled,
  snapshotText,
  squash,
  submitClose,
  tellsReleased,
} from './helpers.ts';

const REASON = '账实差异已查明，无需调账';

it(
  '[AC-F1-08e-CLOSEERR#1] 20902（差错单已被他人调账）：提示状态已变化并重新读取，该行显示「已调账」，入口消失',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openClose(server, REF.ledger, ID.ledger);
    server.setStatus(ID.ledger, 'adjusted');
    const reads = server.reads().length + server.requests('GET', detailPath(ID.ledger)).length;
    const before = snapshotText();
    await submitClose(modal, REASON);
    await waitFor(() => expect(server.closes(ID.ledger)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(CONFLICT));
    await waitFor(() =>
      expect(
        server.reads().length + server.requests('GET', detailPath(ID.ledger)).length,
        'the list or the detail is read again',
      ).toBeGreaterThan(reads),
    );
    await settled(server);
    await waitFor(() =>
      expect(squash(cellText(REF.ledger, COLUMN.status))).toContain(STATUS_NAME.adjusted),
    );
    await waitFor(() => expect(closeEntries(REF.ledger)).toEqual([]));
    expect(server.closes()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-CLOSEERR#2] 20901（同键不同请求体）：提示请求内容有变化，不自动重发',
  async () => {
    const server = createServer();
    server.once('POST', closePath(ID.ledger), changedBody);
    await mount(server);
    const modal = await openClose(server, REF.ledger, ID.ledger);
    const before = snapshotText();
    await submitClose(modal, REASON);
    await waitFor(() => expect(server.closes(ID.ledger)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(CHANGED));
    await settle();
    await settled(server);
    expect(server.closes()).toHaveLength(1);
    expect(server.item(ID.ledger).status).toBe('open');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-CLOSEERR#3] 40901（同一请求处理中）：提示稍后查看，不自动重发',
  async () => {
    const server = createServer();
    server.once('POST', closePath(ID.ledger), inProgress);
    await mount(server);
    const modal = await openClose(server, REF.ledger, ID.ledger);
    const before = snapshotText();
    await submitClose(modal, REASON);
    await waitFor(() => expect(server.closes(ID.ledger)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(RUNNING));
    await settle();
    await settled(server);
    expect(server.closes()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-CLOSEERR#4] 网络失败后在同一对话框重试：两次 POST 的 Idempotency-Key 相同，重试成功后提示已解除 1 笔冻结',
  async () => {
    const server = createServer();
    server.once('POST', closePath(ID.ledger), () => {
      throw new TypeError('Failed to fetch');
    });
    await mount(server);
    const modal = await openClose(server, REF.ledger, ID.ledger);
    await submitClose(modal, REASON);
    await waitFor(() => expect(server.closes(ID.ledger)).toHaveLength(1));
    await settled(server);
    expect(server.item(ID.ledger).status).toBe('open');
    const retry = await reasonDialog();
    const before = snapshotText();
    await click(action(retry, SUBMIT));
    await settle();
    await waitFor(() => expect(server.closes(ID.ledger)).toHaveLength(2));
    await settled(server);
    const [first, second] = server.closes(ID.ledger);
    assertClose(first!, REASON);
    assertClose(second!, REASON);
    expect(requestKey(second!), 'the retry reuses the key').toBe(requestKey(first!));
    expect(server.item(ID.ledger).status).toBe('closed');
    await waitFor(() => {
      const fresh = freshText(before);
      expect(tellsReleased(fresh, 1), `1 released hold in 「${fresh}」`).toBe(true);
    });
    await waitFor(() =>
      expect(squash(cellText(REF.ledger, COLUMN.status))).toContain(STATUS_NAME.closed),
    );
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-CLOSEERR#5] 网络失败后取消、重新打开对话框再提交：用新的 Idempotency-Key',
  async () => {
    const server = createServer();
    server.once('POST', closePath(ID.ledger), () => {
      throw new TypeError('Failed to fetch');
    });
    await mount(server);
    const modal = await openClose(server, REF.ledger, ID.ledger);
    await submitClose(modal, REASON);
    await waitFor(() => expect(server.closes(ID.ledger)).toHaveLength(1));
    await settled(server);
    await click(action(await reasonDialog(), CANCEL));
    await settle();
    await waitFor(() => expect(reasonDialogs()).toEqual([]));
    const again = await openClose(server, REF.ledger, ID.ledger);
    await submitClose(again, REASON);
    await waitFor(() => expect(server.closes(ID.ledger)).toHaveLength(2));
    await settled(server);
    const [first, second] = server.closes(ID.ledger);
    assertClose(second!, REASON);
    expect(requestKey(first!)).not.toBeNull();
    expect(requestKey(second!), 'a new dialog uses a new key').not.toBe(requestKey(first!));
    expect(server.item(ID.ledger).status).toBe('closed');
  },
  FLOW_TIMEOUT,
);
