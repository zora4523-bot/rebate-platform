// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ID, REF, STATUS_NAME, createServer, stepUpValue } from './fixtures.ts';
import {
  DONE,
  FLOW_TIMEOUT,
  NOTE,
  assertTotp,
  assertWriteOff,
  confirmAndVerify,
  drawersOf,
  fill,
  freshText,
  mount,
  openDetail,
  openWriteOff,
  pressConfirm,
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
  textbox,
  verify,
  writeOffDialogs,
  writeOffEntries,
} from './helpers.ts';

const NOTE_TEXT = '支付宝账单 2026-10-20 显示该笔已到账，按账单行核销';

/** The row (and the drawer, when open) of `ref` shows 「已核销」 and has no usable 【核销】. */
async function shownWrittenOff(ref: string): Promise<void> {
  await waitFor(() => expect(statusCell(ref)).toContain(STATUS_NAME.written_off));
  for (const drawer of drawersOf(ref))
    await waitFor(() => expect(squash(drawer.textContent)).toContain(STATUS_NAME.written_off));
  await waitFor(() => expect(writeOffEntries(ref)).toEqual([]));
}

it(
  '[AC-F1-08eb-WRITEOFF#1] 待处理的 R2 差错单【核销】填备注：确认后先弹动态码，验证后才 POST write-off（X-Step-Up-Token + Idempotency-Key + {expected_withdrawal_status: APPROVED, note}）；成功提示已核销并解除 1 笔冻结，该行变为「已核销」、入口消失',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openWriteOff(server, REF.late, ID.late);
    const before = snapshotText();
    await confirmAndVerify(server, modal, ID.late, `  ${NOTE_TEXT}  `);
    const [sent] = server.writeOffs(ID.late);
    assertWriteOff(server, sent!, NOTE_TEXT);
    expect(stepUpHeader(sent!)).toBe(stepUpValue(1));
    assertTotp(server);
    expect(server.verifies()).toHaveLength(1);
    expect(server.item(ID.late).status).toBe('written_off');
    await waitFor(() => {
      const fresh = freshText(before);
      expect(fresh).toMatch(DONE);
      expect(tellsReleased(fresh, 1), `1 released hold in 「${fresh}」`).toBe(true);
    });
    await shownWrittenOff(REF.late);
    expect(writeOffDialogs()).toEqual([]);
    expect(stepUpDialogs()).toEqual([]);
    expect(server.writeOffs()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08eb-WRITEOFF#2] 处理中的 R2 差错单不填备注核销：请求体只有 expected_withdrawal_status=APPROVED（不带 note、金额、渠道结果或凭证），成功提示解除 2 笔冻结',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openWriteOff(server, REF.busy, ID.busy);
    const before = snapshotText();
    await confirmAndVerify(server, modal, ID.busy);
    assertWriteOff(server, server.writeOffs(ID.busy)[0]!);
    expect(server.writeOffs(ID.busy)[0]!.body).toEqual({ expected_withdrawal_status: 'APPROVED' });
    await waitFor(() => {
      const fresh = freshText(before);
      expect(fresh).toMatch(DONE);
      expect(tellsReleased(fresh, 2), `2 released holds in 「${fresh}」`).toBe(true);
    });
    await shownWrittenOff(REF.busy);
    expect(server.holdsOf(ID.busy)).toBe(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08eb-WRITEOFF#3] 没有提现冻结的 R2 差错单核销：照样给已核销提示，提示里出现解除 0 笔冻结',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openWriteOff(server, REF.quiet, ID.quiet);
    const before = snapshotText();
    await confirmAndVerify(server, modal, ID.quiet);
    assertWriteOff(server, server.writeOffs(ID.quiet)[0]!);
    await waitFor(() => {
      const fresh = freshText(before);
      expect(fresh).toMatch(DONE);
      expect(tellsReleased(fresh, 0), `0 released holds in 「${fresh}」`).toBe(true);
    });
    await shownWrittenOff(REF.quiet);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08eb-WRITEOFF#4] 连点两次确认、再连点两次【验证并继续】：只弹一个动态码对话框，只发一次 write-off POST',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openWriteOff(server, REF.late, ID.late);
    await fill(textbox(modal, NOTE), NOTE_TEXT);
    await pressConfirm(modal, true);
    const dialog = await stepUp();
    await settle();
    expect(stepUpDialogs(), 'one step-up dialog').toHaveLength(1);
    expect(server.writeOffs()).toEqual([]);
    await verify(dialog, true);
    await waitFor(() => expect(server.writeOffs(ID.late)).toHaveLength(1));
    await settled(server);
    await settle();
    await settled(server);
    expect(server.writeOffs(), 'one write-off').toHaveLength(1);
    assertWriteOff(server, server.writeOffs(ID.late)[0]!, NOTE_TEXT);
    await shownWrittenOff(REF.late);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08eb-WRITEOFF#5] 连续核销两张差错单：第二次重新弹动态码，两次 POST 的动态码令牌与 Idempotency-Key 都不相同',
  async () => {
    const server = createServer();
    await mount(server);
    const first = await openWriteOff(server, REF.late, ID.late);
    await confirmAndVerify(server, first, ID.late);
    await shownWrittenOff(REF.late);
    await openDetail(server, REF.busy, ID.busy);
    const second = await openWriteOff(server, REF.busy, ID.busy);
    await confirmAndVerify(server, second, ID.busy);
    expect(server.verifies(), 'a step-up for each write-off').toHaveLength(2);
    const [one] = server.writeOffs(ID.late);
    const [two] = server.writeOffs(ID.busy);
    assertWriteOff(server, one!);
    assertWriteOff(server, two!);
    expect(stepUpHeader(two!), 'a new step-up value').not.toBe(stepUpHeader(one!));
    expect(stepUpHeader(two!)).toBe(stepUpValue(2));
    expect(requestKey(two!), 'a new Idempotency-Key').not.toBe(requestKey(one!));
    await shownWrittenOff(REF.busy);
    expect(server.writeOffs()).toHaveLength(2);
  },
  FLOW_TIMEOUT,
);
