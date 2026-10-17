// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import {
  button,
  cardsShown,
  click,
  expectBuiltinPreview,
  expectReplacementPreview,
  expectText,
  listTable,
  openHistory,
  previewNames,
  settle,
} from '../admin-platform-icons/helpers.ts';
import { createUploadServer, pngFile, svgFile, type Upload } from './fixtures.ts';
import {
  buttonsNamed,
  chooseFile,
  confirmBox,
  COPY,
  creates,
  field,
  FLOW_TIMEOUT,
  hasText,
  mountUpload,
  onlyButton,
  openUploadFromRow,
  previewShown,
  uploadDialog,
  uploadFile,
  uploads,
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

const lightDark = (platform: string, label: string) => [
  `${platform} ${label}，浅色底 16、24、32px`,
  `${platform} ${label}，深色底 16、24、32px`,
];

function onlyUpload(server: ReturnType<typeof createUploadServer>): Upload {
  const all = [...server.uploads.values()];
  expect(all).toHaveLength(1);
  return all[0]!.data;
}

it(
  '[AC-F1-06ze-CLEANED#1] sanitized=true：文件行、「已清除不安全内容」警告条、两底三档并排内置图、勾选后才可【存为版本】',
  async () => {
    const h = mountUpload();
    await listTable();
    const modal = await openUploadFromRow('taobao', '淘宝');
    await uploadFile(h.server, modal, svgFile('taobao-logo.svg', 9216));
    const upload = onlyUpload(h.server);
    expect(upload.sanitized).toBe(true);
    await previewShown(modal, upload.url);

    // File row: name, original → cleaned size, format, preview expiry in Beijing time.
    expectText(
      modal,
      'taobao-logo.svg',
      '原文件 9 KB',
      '清洗后 4 KB',
      'SVG',
      '预览有效至 10-13 10:20',
      COPY.cleanedTag,
      COPY.reselect,
    );
    // Warning bar (antd Alert) with the board's two sentences.
    const warnings = Array.from(modal.querySelectorAll<HTMLElement>('.ant-alert')).filter((bar) =>
      hasText(bar, COPY.sanitizedTitle),
    );
    expect(warnings, 'one antd Alert 「已清除不安全内容」').toHaveLength(1);
    expect(warnings[0]!.classList.contains('ant-alert-warning'), 'warning tone').toBe(true);
    expectText(warnings[0]!, COPY.sanitizedBody);

    // Preview: the cleaned file (server url) beside the built-in image, light and dark.
    expectText(modal, COPY.previewTitle);
    expect(previewNames(modal).sort()).toEqual(
      [...lightDark('淘宝', '清洗后'), ...lightDark('淘宝', '内置图')].sort(),
    );
    for (const name of lightDark('淘宝', '清洗后'))
      expectReplacementPreview(modal, name, upload.url);
    for (const name of lightDark('淘宝', '内置图')) expectBuiltinPreview(modal, name, [upload.url]);
    // The cleaned file is only shown as <img>; its bytes are never read by the page.
    expect(h.media).not.toHaveBeenCalled();

    // Confirmation gates 【存为版本】.
    const box = confirmBox(modal);
    expect(box.checked).toBe(false);
    expectText(modal, COPY.confirm, COPY.confirmHint);
    expect(onlyButton(modal, COPY.save).disabled, '【存为版本】 before confirming').toBe(true);
    await click(box);
    await waitFor(() => expect(confirmBox(modal).checked).toBe(true));
    await waitFor(() => expect(onlyButton(modal, COPY.save).disabled).toBe(false));
    await click(confirmBox(modal));
    await waitFor(() => expect(onlyButton(modal, COPY.save).disabled).toBe(true));

    // Source registration: both fields, the draft note and the next version number.
    expectText(modal, COPY.sourceSection, COPY.sourceHelp, COPY.draftNote, COPY.saveNote(1));
    expect(field(modal, COPY.sourceLabel).value).toBe('');
    expect(field(modal, COPY.dateLabel).value).toBe('');
    expect(onlyButton(modal, '取消').disabled).toBe(false);
    await settle();
    expect(creates(h.server)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06ze-CLEANED#2] sanitized=false（PNG，支付宝从抽屉进入）：无警告条与勾选框，【存为版本】直接可用；换一份数据显示随之变化',
  async () => {
    const server = createUploadServer();
    // Another expiry (crosses midnight in Beijing time) and size: no constant may pass.
    server.uploadAs({ sanitized: false, bytes: 51200, expires_at: '2026-10-12T16:05:00Z' });
    mountUpload(server);
    await listTable();
    const drawer = await openHistory('alipay', '支付宝');
    await cardsShown(drawer, '支付宝', [3, 2, 1]);
    await click(button(drawer, '上传新版本'));
    const modal = await uploadDialog('支付宝');
    await uploadFile(server, modal, pngFile('alipay-brand.png', 60416));
    const upload = onlyUpload(server);
    expect(upload.format).toBe('png');
    await previewShown(modal, upload.url);

    expectText(
      modal,
      'alipay-brand.png',
      '原文件 59 KB',
      '清洗后 50 KB',
      'PNG',
      '预览有效至 10-13 00:05',
    );
    expect(hasText(modal, COPY.sanitizedTitle), 'no 「已清除不安全内容」').toBe(false);
    expect(hasText(modal, COPY.confirm), 'no confirmation checkbox').toBe(false);
    expect(modal.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(hasText(modal, COPY.cleanedTag), 'no 「已清洗」 tag').toBe(false);
    for (const name of lightDark('支付宝', '清洗后'))
      expectReplacementPreview(modal, name, upload.url);
    for (const name of lightDark('支付宝', '内置图'))
      expectBuiltinPreview(modal, name, [upload.url]);
    expectText(modal, COPY.saveNote(4));
    expect(onlyButton(modal, COPY.save).disabled).toBe(false);
    await settle();
    expect(creates(server)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06ze-CLEANED#3] sanitized=false 的 SVG（未改动）同样无提示条与勾选框；预览用服务端返回的 url，不用本地文件',
  async () => {
    const server = createUploadServer();
    server.uploadAs({ sanitized: false, bytes: 2048 });
    mountUpload(server);
    await listTable();
    const modal = await openUploadFromRow('jd', '京东');
    await uploadFile(server, modal, svgFile('jd.svg', 2048));
    const upload = onlyUpload(server);
    await previewShown(modal, upload.url);
    expect(hasText(modal, COPY.sanitizedTitle)).toBe(false);
    expect(modal.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(buttonsNamed(modal, COPY.save)).toHaveLength(1);
    expect(onlyButton(modal, COPY.save).disabled).toBe(false);
    // Every image in the dialog is the server's cleaned file or the bundled built-in image.
    for (const image of Array.from(modal.querySelectorAll('img'))) {
      const src = image.getAttribute('src') ?? '';
      expect(src.startsWith('blob:') || src.startsWith('data:'), `local preview ${src}`).toBe(
        false,
      );
    }
    // jd's next version is 2 (latest_version 1).
    expectText(modal, COPY.saveNote(2));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06ze-CLEANED#4] 同一弹窗里【重新选择文件】换一份再上传：勾选确认不沿用，新预览须重新勾选才可存，存的是新 upload_id',
  async () => {
    const server = createUploadServer();
    server.uploadAs({ sanitized: true });
    server.uploadAs({ sanitized: true });
    mountUpload(server);
    await listTable();
    const modal = await openUploadFromRow('taobao', '淘宝');
    await uploadFile(server, modal, svgFile('taobao-logo.svg', 9216));
    const first = [...server.uploads.values()][0]!.data;
    await previewShown(modal, first.url);
    await click(confirmBox(modal));
    await waitFor(() => expect(onlyButton(modal, COPY.save).disabled).toBe(false));

    // Another file through 【重新选择文件】 (the dialog's file input), uploaded again.
    await chooseFile(modal, svgFile('taobao-logo-2.svg', 8192));
    await waitFor(() => {
      const start = buttonsNamed(modal, COPY.upload);
      expect(uploads(server).length === 2 || start.some((item) => !item.disabled)).toBe(true);
    });
    if (uploads(server).length === 1) await click(onlyButton(modal, COPY.upload));
    await waitFor(() => expect(uploads(server)).toHaveLength(2));
    const second = [...server.uploads.values()][1]!.data;
    await previewShown(modal, second.url);
    expect(
      Array.from(modal.querySelectorAll('img'), (image) => image.getAttribute('src')),
      'the first preview is gone',
    ).not.toContain(first.url);
    expectText(modal, 'taobao-logo-2.svg', COPY.sanitizedTitle);
    expect(confirmBox(modal).checked, 'the new preview is not confirmed yet').toBe(false);
    expect(onlyButton(modal, COPY.save).disabled, '【存为版本】 before confirming').toBe(true);

    await click(confirmBox(modal));
    await waitFor(() => expect(confirmBox(modal).checked).toBe(true));
    await waitFor(() => expect(onlyButton(modal, COPY.save).disabled).toBe(false));
    await click(onlyButton(modal, COPY.save));
    await waitFor(() => expect(creates(server)).toHaveLength(1));
    expect(creates(server)[0]!.body).toEqual({
      upload_id: second.upload_id,
      sanitized_confirmed: true,
    });
  },
  FLOW_TIMEOUT,
);
