// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ID,
  REF,
  STATUS_NAME,
  changedBody,
  createServer,
  detailPath,
  inProgress,
  stepUpRequired,
  stepUpValue,
  writeOffPath,
  type Server,
} from './fixtures.ts';
import {
  CANCEL,
  CHANGED,
  CONFLICT,
  DONE,
  FLOW_TIMEOUT,
  RUNNING,
  action,
  assertWriteOff,
  click,
  confirmAndVerify,
  drawersOf,
  freshNotices,
  freshText,
  mount,
  openWriteOff,
  pressConfirm,
  readAgain,
  requestKey,
  settle,
  settled,
  snapshotText,
  squash,
  statusCell,
  stepUp,
  stepUpDialogs,
  stepUpHeader,
  tellsReleased,
  verify,
  writeOffDialog,
  writeOffDialogs,
  writeOffEntries,
} from './helpers.ts';

const NOTE_TEXT = '账单行显示已到账';

/** After a failure in the dialog: a new step-up when the page asks for one, then the resend. */
async function resend(server: Server, id: string): Promise<void> {
  const sent = server.writeOffs(id).length;
  if (stepUpDialogs().length === 0) await pressConfirm(await writeOffDialog());
  const dialog = stepUpDialogs()[0];
  if (dialog !== undefined) await verify(dialog);
  await waitFor(() => expect(server.writeOffs(id)).toHaveLength(sent + 1));
  await settled(server);
}

it(
  '[AC-F1-08eb-ERR#1] 10003（动态码令牌失效）：不自动重发，重新弹动态码；再次验证后重放，Idempotency-Key 与第一次相同、动态码令牌是新的，成功解除 1 笔冻结',
  async () => {
    const server = createServer();
    server.once('POST', writeOffPath(ID.late), stepUpRequired);
    await mount(server);
    const modal = await openWriteOff(server, REF.late, ID.late);
    await confirmAndVerify(server, modal, ID.late, NOTE_TEXT);
    await settle();
    await settled(server);
    expect(server.writeOffs(ID.late), 'no automatic resend').toHaveLength(1);
    // The step-up dialog comes back by itself, or after pressing confirm again in the dialog.
    if (stepUpDialogs().length === 0) await pressConfirm(await writeOffDialog());
    const again = await stepUp();
    expect(server.writeOffs(ID.late)).toHaveLength(1);
    const before = snapshotText();
    await verify(again);
    await waitFor(() => expect(server.writeOffs(ID.late)).toHaveLength(2));
    await settled(server);
    const [first, second] = server.writeOffs(ID.late);
    assertWriteOff(server, second!, NOTE_TEXT);
    expect(requestKey(second!), 'the replay keeps its key').toBe(requestKey(first!));
    expect(stepUpHeader(first!)).toBe(stepUpValue(1));
    expect(stepUpHeader(second!), 'a new step-up value').toBe(stepUpValue(2));
    expect(server.item(ID.late).status).toBe('written_off');
    await waitFor(() => {
      const fresh = freshText(before);
      expect(fresh).toMatch(DONE);
      expect(tellsReleased(fresh, 1), `1 released hold in 「${fresh}」`).toBe(true);
    });
    await waitFor(() => expect(statusCell(REF.late)).toContain(STATUS_NAME.written_off));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08eb-ERR#2] 网络失败后在同一对话框重试：两次 POST 的 Idempotency-Key 相同、请求体相同，重试成功后提示解除 1 笔冻结',
  async () => {
    const server = createServer();
    server.once('POST', writeOffPath(ID.late), () => {
      throw new TypeError('Failed to fetch');
    });
    await mount(server);
    const modal = await openWriteOff(server, REF.late, ID.late);
    await confirmAndVerify(server, modal, ID.late, NOTE_TEXT);
    expect(server.item(ID.late).status).toBe('open');
    expect(writeOffDialogs(), 'the dialog stays open').toHaveLength(1);
    const before = snapshotText();
    await resend(server, ID.late);
    const [first, second] = server.writeOffs(ID.late);
    assertWriteOff(server, first!, NOTE_TEXT);
    assertWriteOff(server, second!, NOTE_TEXT);
    expect(requestKey(second!), 'the retry reuses the key').toBe(requestKey(first!));
    expect(second!.body).toEqual(first!.body);
    expect(server.item(ID.late).status).toBe('written_off');
    await waitFor(() => {
      const fresh = freshText(before);
      expect(tellsReleased(fresh, 1), `1 released hold in 「${fresh}」`).toBe(true);
    });
    await waitFor(() => expect(statusCell(REF.late)).toContain(STATUS_NAME.written_off));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08eb-ERR#3] 网络失败后取消、重新打开【核销】再提交：用新的 Idempotency-Key',
  async () => {
    const server = createServer();
    server.once('POST', writeOffPath(ID.late), () => {
      throw new TypeError('Failed to fetch');
    });
    await mount(server);
    const modal = await openWriteOff(server, REF.late, ID.late);
    await confirmAndVerify(server, modal, ID.late);
    await click(action(await writeOffDialog(), CANCEL));
    await settle();
    await waitFor(() => expect(writeOffDialogs()).toEqual([]));
    const again = await openWriteOff(server, REF.late, ID.late);
    await confirmAndVerify(server, again, ID.late);
    const [first, second] = server.writeOffs(ID.late);
    assertWriteOff(server, second!);
    expect(requestKey(first!)).not.toBeNull();
    expect(requestKey(second!), 'a new dialog uses a new key').not.toBe(requestKey(first!));
    expect(server.item(ID.late).status).toBe('written_off');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08eb-ERR#4] 20902 resource=recon_diff（差错单已被他人关闭）：提示已变化并重新读取详情，显示「已关闭（不处理）」，【核销】消失，不显示成功、不重发',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openWriteOff(server, REF.late, ID.late);
    server.setStatus(ID.late, 'closed');
    const reads = server.requests('GET', detailPath(ID.late)).length;
    const before = snapshotText();
    await confirmAndVerify(server, modal, ID.late);
    await waitFor(() => expect(freshText(before)).toMatch(CONFLICT));
    await readAgain(server, ID.late, reads);
    await settled(server);
    await waitFor(() => {
      const drawers = drawersOf(REF.late).map((node) => squash(node.textContent));
      const shown = [statusCell(REF.late), ...drawers];
      expect(
        shown.some((text) => text.includes(STATUS_NAME.closed)),
        'the row or the drawer shows the new status',
      ).toBe(true);
    });
    await waitFor(() => expect(writeOffEntries(REF.late)).toEqual([]));
    expect(freshNotices(before)).not.toMatch(DONE);
    expect(server.writeOffs()).toHaveLength(1);
    expect(server.item(ID.late).status).toBe('closed');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08eb-ERR#5] 20902 resource=withdrawal（原提现单已不是 APPROVED）：提示已变化并重新读取详情，不显示成功、不重发，差错单仍待处理',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openWriteOff(server, REF.late, ID.late);
    server.setWithdrawal(ID.late, 'PAYING');
    const reads = server.requests('GET', detailPath(ID.late)).length;
    const before = snapshotText();
    await confirmAndVerify(server, modal, ID.late);
    await waitFor(() => expect(freshText(before)).toMatch(CONFLICT));
    await readAgain(server, ID.late, reads);
    await settle();
    await settled(server);
    expect(freshNotices(before)).not.toMatch(DONE);
    expect(tellsReleased(freshNotices(before), 1)).toBe(false);
    expect(server.writeOffs()).toHaveLength(1);
    expect(server.item(ID.late).status).toBe('open');
    expect(server.withdrawalOf(ID.late)).toBe('PAYING');
    expect(statusCell(REF.late)).toContain(STATUS_NAME.open);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08eb-ERR#6] 20901（同键不同请求体）：提示请求内容有变化，不自动重发、不显示成功',
  async () => {
    const server = createServer();
    server.once('POST', writeOffPath(ID.late), changedBody);
    await mount(server);
    const modal = await openWriteOff(server, REF.late, ID.late);
    const before = snapshotText();
    await confirmAndVerify(server, modal, ID.late, NOTE_TEXT);
    await waitFor(() => expect(freshText(before)).toMatch(CHANGED));
    await settle();
    await settled(server);
    expect(server.writeOffs()).toHaveLength(1);
    expect(server.verifies()).toHaveLength(1);
    expect(freshNotices(before)).not.toMatch(DONE);
    expect(server.item(ID.late).status).toBe('open');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08eb-ERR#7] 40901（同一请求处理中）：提示稍后查看，不自动重发、不显示成功',
  async () => {
    const server = createServer();
    server.once('POST', writeOffPath(ID.late), inProgress);
    await mount(server);
    const modal = await openWriteOff(server, REF.late, ID.late);
    const before = snapshotText();
    await confirmAndVerify(server, modal, ID.late);
    await waitFor(() => expect(freshText(before)).toMatch(RUNNING));
    await settle();
    await settled(server);
    expect(server.writeOffs()).toHaveLength(1);
    expect(server.verifies()).toHaveLength(1);
    expect(freshNotices(before)).not.toMatch(DONE);
  },
  FLOW_TIMEOUT,
);
