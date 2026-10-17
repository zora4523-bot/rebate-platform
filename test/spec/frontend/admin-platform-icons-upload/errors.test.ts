// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import {
  click,
  dialogClosed,
  dialogs,
  expectText,
  listTable,
  mainElement,
  previewNames,
  settle,
} from '../admin-platform-icons/helpers.ts';
import {
  BODY_TOO_LARGE,
  createUploadServer,
  FORMAT_INVALID,
  isCreate,
  isUpload,
  reject,
  SANITIZED_UNCONFIRMED,
  svgFile,
  SVG_UNCONVERTIBLE,
  TOO_LARGE,
  UNKNOWN_KEY,
  type Envelope,
} from './fixtures.ts';
import {
  buttonsNamed,
  chooseFile,
  confirmBox,
  COPY,
  creates,
  FLOW_TIMEOUT,
  hasText,
  historyDrawer,
  mountUpload,
  openDrawers,
  onlyButton,
  openUploadFromRow,
  previewShown,
  uploadFile,
  uploads,
  uploadTitle,
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

/** The file was refused: sentence under the file, nothing previewed or saved, dialog open. */
async function expectRefused(
  server: ReturnType<typeof createUploadServer>,
  modal: HTMLElement,
  sentence: string,
  shown: string,
): Promise<void> {
  await waitFor(() => expectText(modal, sentence));
  expectText(modal, COPY.failedTag, COPY.reselect, COPY.notUploaded, shown);
  expect(dialogs(uploadTitle('淘宝')), 'the dialog stays open').toHaveLength(1);
  expect(previewNames(modal).filter((name) => name.includes('清洗后'))).toEqual([]);
  expect(buttonsNamed(modal, COPY.save), 'no 【存为版本】').toEqual([]);
  expect(hasText(modal, COPY.uploading)).toBe(false);
  await settle();
  expect(uploads(server), 'no automatic retry').toHaveLength(1);
  expect(creates(server)).toEqual([]);
}

const REFUSALS: readonly { name: string; envelope: Envelope; sentence: string }[] = [
  { name: 'icon_format_invalid', envelope: FORMAT_INVALID, sentence: COPY.formatInvalid },
  { name: 'icon_too_large', envelope: TOO_LARGE, sentence: COPY.tooLarge },
  { name: 'icon_svg_unconvertible', envelope: SVG_UNCONVERTIBLE, sentence: COPY.unconvertible },
];

for (const refusal of REFUSALS) {
  for (const msg of ['contract', 'generic'] as const) {
    it(
      `[AC-F1-06ze-ERRORS#1] 20001 ${refusal.name}（msg ${msg === 'contract' ? '契约原句' : '「参数错误」'}）：按 reason 在文件下显示 §3 提示，弹窗不关`,
      async () => {
        const server = createUploadServer();
        // The console text comes from data.reason, not from msg (admin-only reason, contract).
        const envelope =
          msg === 'contract' ? refusal.envelope : { ...refusal.envelope, msg: '参数错误' };
        server.once(isUpload, reject(envelope, 400));
        mountUpload(server);
        await listTable();
        const modal = await openUploadFromRow('taobao', '淘宝');
        await uploadFile(server, modal, svgFile('taobao-brand.svg', 26624));
        await expectRefused(server, modal, refusal.sentence, 'taobao-brand.svg');
        if (msg === 'generic') expect(hasText(modal, '参数错误')).toBe(false);
      },
      FLOW_TIMEOUT,
    );
  }
}

it(
  '[AC-F1-06ze-ERRORS#2] 413 fields=[body]（整包超全局上限）按「文件超过大小上限（当前 200KB）」显示，弹窗不关',
  async () => {
    const server = createUploadServer();
    server.once(isUpload, reject(BODY_TOO_LARGE, 413));
    mountUpload(server);
    await listTable();
    const modal = await openUploadFromRow('taobao', '淘宝');
    await uploadFile(server, modal, svgFile('taobao-huge.svg', 300_000));
    await expectRefused(server, modal, COPY.tooLarge, 'taobao-huge.svg');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06ze-ERRORS#3] upload_id 失效（预览过期）：提示「上传已失效，请重新上传」，【存为版本】置灰、保留【重新选择文件】；重新上传后用新的 upload_id 存成功',
  async () => {
    const server = createUploadServer();
    mountUpload(server);
    await listTable();
    const modal = await openUploadFromRow('taobao', '淘宝');
    await uploadFile(server, modal, svgFile('taobao-logo.svg', 9216));
    const first = [...server.uploads.values()][0]!.data;
    await previewShown(modal, first.url);
    await click(confirmBox(modal));
    await waitFor(() => expect(onlyButton(modal, COPY.save).disabled).toBe(false));
    server.expire(first.upload_id);
    await click(onlyButton(modal, COPY.save));
    await waitFor(() => expect(creates(server)).toHaveLength(1));
    await waitFor(() => expectText(modal, COPY.uploadExpired));
    expect(dialogs(uploadTitle('淘宝'))).toHaveLength(1);
    expect(openDrawers('淘宝'), 'no drawer for a failed save').toHaveLength(0);
    await waitFor(() => expect(onlyButton(modal, COPY.save).disabled).toBe(true));
    expectText(modal, COPY.reselect);
    await settle();
    expect(creates(server), 'no automatic resend').toHaveLength(1);

    // Choose the file again: a new upload (cleaned again, sanitized=true), and the save uses the
    // new upload_id. The confirmation given for the first file does not carry over.
    server.uploadAs({ sanitized: true });
    await chooseFile(modal, svgFile('taobao-logo-2.svg', 8192));
    await waitFor(() => {
      const start = buttonsNamed(modal, COPY.upload);
      expect(uploads(server).length === 2 || start.some((item) => !item.disabled)).toBe(true);
    });
    if (uploads(server).length === 1) await click(onlyButton(modal, COPY.upload));
    await waitFor(() => expect(uploads(server)).toHaveLength(2));
    const second = [...server.uploads.values()][1]!.data;
    await previewShown(modal, second.url);
    expect(hasText(modal, COPY.uploadExpired), 'the expiry notice is gone').toBe(false);
    expect(second.sanitized).toBe(true);
    expect(confirmBox(modal).checked, 'the new preview is not confirmed yet').toBe(false);
    expect(onlyButton(modal, COPY.save).disabled, '【存为版本】 before confirming').toBe(true);
    await click(confirmBox(modal));
    await waitFor(() => expect(confirmBox(modal).checked).toBe(true));
    await waitFor(() => expect(onlyButton(modal, COPY.save).disabled).toBe(false));
    await click(onlyButton(modal, COPY.save));
    await waitFor(() => expect(creates(server)).toHaveLength(2));
    expect(creates(server)[1]!.body).toEqual({
      upload_id: second.upload_id,
      sanitized_confirmed: true,
    });
    await historyDrawer('淘宝');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06ze-ERRORS#4] sanitized_confirmed 兜底：服务端仍回 20001 fields=[sanitized_confirmed] 时在勾选框下提示，不关弹窗、不重发',
  async () => {
    const server = createUploadServer();
    server.once(isCreate, reject(SANITIZED_UNCONFIRMED, 400));
    mountUpload(server);
    await listTable();
    const modal = await openUploadFromRow('taobao', '淘宝');
    await uploadFile(server, modal, svgFile());
    await previewShown(modal, [...server.uploads.values()][0]!.data.url);
    await click(confirmBox(modal));
    await waitFor(() => expect(onlyButton(modal, COPY.save).disabled).toBe(false));
    await click(onlyButton(modal, COPY.save));
    await waitFor(() => expect(creates(server)).toHaveLength(1));
    await waitFor(() => expectText(modal, COPY.unconfirmed));
    // Not the generic upload_id sentence, not a drawer.
    expect(hasText(modal, COPY.uploadExpired)).toBe(false);
    expect(dialogs(uploadTitle('淘宝'))).toHaveLength(1);
    expect(openDrawers('淘宝')).toHaveLength(0);
    await settle();
    expect(creates(server)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06ze-ERRORS#5] 20001 fields=[key]：关上传弹窗，落列表页并提示「没有这个平台标识」',
  async () => {
    const server = createUploadServer();
    server.once(isUpload, reject(UNKNOWN_KEY, 400));
    mountUpload(server);
    await listTable();
    const modal = await openUploadFromRow('taobao', '淘宝');
    await uploadFile(server, modal, svgFile());
    await dialogClosed(uploadTitle('淘宝'));
    await waitFor(() => expectText(mainElement(), COPY.unknownKey));
    expect(dialogs('上传替换图')).toHaveLength(0);
    await listTable();
    await settle();
    expect(creates(server)).toEqual([]);
    expect(uploads(server)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);
