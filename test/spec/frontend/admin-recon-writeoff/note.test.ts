// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ID, REF, STATUS_NAME, createServer, rejected, writeOffPath } from './fixtures.ts';
import {
  DONE,
  FLOW_TIMEOUT,
  NOTE,
  assertWriteOff,
  confirmAndVerify,
  fieldError,
  fill,
  freshNotices,
  freshText,
  mount,
  openWriteOff,
  pressConfirm,
  settle,
  settled,
  snapshotText,
  statusCell,
  stepUpDialogs,
  tellsReleased,
  textbox,
  verify,
  writeOffDialog,
  writeOffDialogs,
} from './helpers.ts';

it(
  '[AC-F1-08eb-NOTE#1] 备注去首尾空白后 201 字：不成功、在备注旁提示、对话框不关、差错单仍待处理（不发请求，或发出后收 20001 [note]，两种都可）；改成正好 200 字再提交即核销成功',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openWriteOff(server, REF.late, ID.late);
    const long = `  ${'核'.repeat(201)}  `;
    await fill(textbox(modal, NOTE), long);
    const before = snapshotText();
    await pressConfirm(modal);
    // Checked before the step-up, or sent after it and refused by the server: both are fine.
    await waitFor(() =>
      expect(
        fieldError(textbox(modal, NOTE)) !== '' || stepUpDialogs().length > 0,
        'a note error or the step-up dialog',
      ).toBe(true),
    );
    const dialog = stepUpDialogs()[0];
    if (dialog !== undefined) {
      await verify(dialog);
      await waitFor(() => expect(server.writeOffs(ID.late)).toHaveLength(1));
    }
    await settled(server);
    const note = await writeOffDialog();
    await waitFor(() => expect(fieldError(textbox(note, NOTE))).not.toBe(''));
    expect(server.writeOffs().length).toBeLessThanOrEqual(1);
    for (const request of server.writeOffs()) {
      const body = request.body as Record<string, unknown>;
      expect(String(body['note']).trim().length, 'only an over-long note was sent').toBe(201);
    }
    expect(server.item(ID.late).status).toBe('open');
    expect(freshNotices(before)).not.toMatch(DONE);
    expect(statusCell(REF.late)).toContain(STATUS_NAME.open);

    const sent = server.writeOffs().length;
    const fine = '账'.repeat(200);
    const success = snapshotText();
    await confirmAndVerify(server, note, ID.late, fine);
    expect(server.writeOffs()).toHaveLength(sent + 1);
    assertWriteOff(server, server.writeOffs(ID.late).at(-1)!, fine);
    expect(server.item(ID.late).status).toBe('written_off');
    await waitFor(() => {
      const fresh = freshText(success);
      expect(fresh).toMatch(DONE);
      expect(tellsReleased(fresh, 1), `1 released hold in 「${fresh}」`).toBe(true);
    });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08eb-NOTE#2] 服务端 20001 data.fields=[note]：在备注旁提示，对话框不关、不显示成功，差错单状态不变',
  async () => {
    const server = createServer();
    server.once('POST', writeOffPath(ID.late), () => rejected(['note']));
    await mount(server);
    const modal = await openWriteOff(server, REF.late, ID.late);
    const before = snapshotText();
    await confirmAndVerify(server, modal, ID.late, '按账单行核销');
    await waitFor(() => expect(fieldError(textbox(modal, NOTE))).not.toBe(''));
    expect(writeOffDialogs()).toHaveLength(1);
    await settle();
    await settled(server);
    expect(server.writeOffs()).toHaveLength(1);
    expect(freshNotices(before)).not.toMatch(DONE);
    expect(statusCell(REF.late)).toContain(STATUS_NAME.open);
    expect(server.item(ID.late).status).toBe('open');
  },
  FLOW_TIMEOUT,
);
