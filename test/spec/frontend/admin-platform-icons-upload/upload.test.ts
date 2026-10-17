// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import {
  button,
  cardsShown,
  cell,
  click,
  dialogClosed,
  dialogs,
  expectText,
  listTable,
  openHistory,
  settle,
} from '../admin-platform-icons/helpers.ts';
import { createUploadServer, isUpload, pngFile, svgFile, type Key } from './fixtures.ts';
import {
  buttonsNamed,
  chooseFile,
  COPY,
  creates,
  fileInput,
  FLOW_TIMEOUT,
  hasText,
  mountUpload,
  nonGet,
  openDrawers,
  onlyButton,
  openUploadFromRow,
  previewShown,
  uploadDialog,
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

const ENTRIES: readonly {
  readonly name: string;
  readonly key: Key;
  readonly platform: string;
  readonly subtitle: string;
  readonly open: () => Promise<HTMLElement>;
}[] = [
  {
    name: '列表行【上传 淘宝】',
    key: 'taobao',
    platform: '淘宝',
    subtitle: '淘宝 · taobao · 当前生效：内置图',
    open: () => openUploadFromRow('taobao', '淘宝'),
  },
  {
    name: '版本历史抽屉【上传新版本】（支付宝）',
    key: 'alipay',
    platform: '支付宝',
    subtitle: '支付宝 · alipay · 当前生效：版本 2',
    open: async () => {
      const drawer = await openHistory('alipay', '支付宝');
      await cardsShown(drawer, '支付宝', [3, 2, 1]);
      await click(button(drawer, '上传新版本'));
      return uploadDialog('支付宝');
    },
  },
  {
    name: '空态抽屉【上传替换图】（天猫）',
    key: 'tmall',
    platform: '天猫',
    subtitle: '天猫 · tmall · 当前生效：内置图',
    open: async () => {
      const drawer = await openHistory('tmall', '天猫');
      await waitFor(() => expectText(drawer, '还没有上传过替换图'));
      await click(button(drawer, '上传替换图'));
      return uploadDialog('天猫');
    },
  },
];

for (const entry of ENTRIES) {
  it(
    `[AC-F1-06ze-UPLOAD#1] ${entry.name} 打开带平台名的上传弹窗：文件要求三条、未选文件时【上传并预览】置灰、不发请求`,
    async () => {
      const h = mountUpload();
      await listTable();
      const modal = await entry.open();
      expectText(
        modal,
        uploadTitle(entry.platform),
        entry.subtitle,
        COPY.noFile,
        COPY.choose,
        COPY.requirements,
        COPY.rule1,
        COPY.rule2,
        COPY.rule3,
      );
      // One key per dialog: only this platform's dialog is open.
      expect(dialogs('上传替换图')).toHaveLength(1);
      const input = fileInput(modal);
      const accept = (input.getAttribute('accept') ?? '').toLowerCase();
      expect(accept, 'file chooser offers SVG').toMatch(/\.svg|image\/svg\+xml/);
      expect(accept, 'file chooser offers PNG').toMatch(/\.png|image\/png/);
      expect(onlyButton(modal, COPY.upload).disabled, '【上传并预览】 without a file').toBe(true);
      expect(onlyButton(modal, '取消').disabled).toBe(false);
      await settle();
      expect(nonGet(h.server)).toEqual([]);

      await click(onlyButton(modal, '取消'));
      await dialogClosed(uploadTitle(entry.platform));
      if (entry.key !== 'taobao') expect(openDrawers(entry.platform)).toHaveLength(1);
      expect(nonGet(h.server)).toEqual([]);
    },
    FLOW_TIMEOUT,
  );
}

for (const sample of [
  { kind: 'SVG', file: () => svgFile('taobao-logo.svg', 9216), type: 'image/svg+xml' },
  { kind: 'PNG', file: () => pngFile('taobao-logo.png', 51200), type: 'image/png' },
]) {
  it(
    `[AC-F1-06ze-UPLOAD#2] 选 ${sample.kind} 文件后才可上传；【上传并预览】只发一次 multipart，part 名 file，不自设 Content-Type`,
    async () => {
      const h = mountUpload();
      await listTable();
      const modal = await openUploadFromRow('taobao', '淘宝');
      const file = sample.file();
      await chooseFile(modal, file);
      await waitFor(() => expect(onlyButton(modal, COPY.upload).disabled).toBe(false));
      expectText(modal, file.name);
      // Choosing a file sends nothing; only the button uploads.
      await settle();
      expect(nonGet(h.server)).toEqual([]);

      await click(onlyButton(modal, COPY.upload));
      await waitFor(() => expect(uploads(h.server)).toHaveLength(1));
      const request = uploads(h.server)[0]!;
      expect(request.path).toBe('/admin/v1/platform-icons/taobao/uploads');
      expect(request.method).toBe('POST');
      expect(request.parts, 'multipart body').toBeDefined();
      expect(
        request.parts!.map((part) => [part.name, part.fileName, part.size, part.type]),
      ).toEqual([['file', file.name, file.size, sample.type]]);
      expect(Object.keys(request.headers)).not.toContain('content-type');
      expect(request.headers['authorization']).toBe('Bearer example-admin-token');

      const url = h.server.uploads.values().next().value!.data.url;
      await previewShown(modal, url);
      await settle();
      expect(uploads(h.server)).toHaveLength(1);
      expect(creates(h.server)).toEqual([]);
    },
    FLOW_TIMEOUT,
  );
}

it(
  '[AC-F1-06ze-UPLOAD#3] 上传与清洗中：显示画板状态，【取消】可用，再按上传也只发一次；响应到达后出预览',
  async () => {
    const server = createUploadServer();
    const gate = server.hold(isUpload);
    mountUpload(server);
    try {
      await listTable();
      const modal = await openUploadFromRow('taobao', '淘宝');
      const file = svgFile();
      await chooseFile(modal, file);
      await waitFor(() => expect(onlyButton(modal, COPY.upload).disabled).toBe(false));
      const press = onlyButton(modal, COPY.upload);
      await click(press);
      await waitFor(() => expect(uploads(server)).toHaveLength(1));
      await waitFor(() => expectText(modal, COPY.uploading, COPY.discard, file.name));
      // No usable upload button while the file is under way; 取消 stays usable.
      const starters = [
        ...buttonsNamed(modal, COPY.upload),
        ...within(modal)
          .queryAllByRole('button')
          .filter((item) => /正在上传/.test(item.textContent ?? '')),
      ];
      for (const starter of starters)
        expect((starter as HTMLButtonElement).disabled, 'upload button in flight').toBe(true);
      expect(onlyButton(modal, '取消').disabled).toBe(false);
      await act(async () => {
        fireEvent.click(press.isConnected ? press : (starters[0] ?? press));
      });
      await settle();
      expect(uploads(server)).toHaveLength(1);

      await act(async () => gate.release());
      const url = server.uploads.values().next().value!.data.url;
      await previewShown(modal, url);
      expect(hasText(modal, COPY.uploading)).toBe(false);
      expect(uploads(server)).toHaveLength(1);
    } finally {
      gate.release();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06ze-UPLOAD#4] 上传中按【取消】：中止请求（AbortSignal）、关闭弹窗、不生成预览、不再发后续请求',
  async () => {
    const server = createUploadServer();
    const gate = server.hold(isUpload);
    mountUpload(server);
    try {
      await listTable();
      const modal = await openUploadFromRow('taobao', '淘宝');
      await uploadFile(server, modal, svgFile());
      await waitFor(() => expectText(modal, COPY.uploading));
      const request = uploads(server)[0]!;
      expect(request.signal, 'the upload carries an AbortSignal').toBeDefined();
      expect(request.signal!.aborted).toBe(false);

      await click(onlyButton(modal, '取消'));
      await dialogClosed(uploadTitle('淘宝'));
      expect(request.signal!.aborted, 'cancel aborts the upload').toBe(true);
      await act(async () => gate.release());
      await settle();
      const url = server.uploads.values().next().value?.data.url;
      if (url !== undefined) {
        expect(
          Array.from(document.querySelectorAll('img'), (image) => image.getAttribute('src')),
        ).not.toContain(url);
      }
      expect(dialogs('上传替换图')).toHaveLength(0);
      expect(nonGet(server)).toHaveLength(1);
      expect(creates(server)).toEqual([]);
    } finally {
      gate.release();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06ze-UPLOAD#5] 取消后迟到的上传响应被丢弃：重新打开的弹窗不被带回清洗后预览，新上传的结果才被采用',
  async () => {
    const server = createUploadServer();
    // The old answer arrives even though the request was aborted (already on its way).
    const gate = server.hold(isUpload, { ignoreAbort: true });
    mountUpload(server);
    try {
      await listTable();
      const first = await openUploadFromRow('taobao', '淘宝');
      await uploadFile(server, first, svgFile('taobao-old.svg', 2048));
      await waitFor(() => expectText(first, COPY.uploading));
      await click(onlyButton(first, '取消'));
      await dialogClosed(uploadTitle('淘宝'));

      await openUploadFromRow('taobao', '淘宝');
      await act(async () => gate.release());
      await settle();
      const old = server.uploads.values().next().value!.data;
      const modal = await uploadDialog('淘宝');
      expect(
        Array.from(document.querySelectorAll('img'), (image) => image.getAttribute('src')),
        'the late answer shows no preview',
      ).not.toContain(old.url);
      expectText(modal, COPY.noFile);
      expect(buttonsNamed(modal, COPY.save), 'no 【存为版本】 from the late answer').toEqual([]);
      expect(onlyButton(modal, COPY.upload).disabled).toBe(true);

      await uploadFile(server, modal, svgFile('taobao-new.svg', 3072));
      const fresh = [...server.uploads.values()][1]!.data;
      await previewShown(modal, fresh.url);
      expect(
        Array.from(modal.querySelectorAll('img'), (image) => image.getAttribute('src')),
      ).not.toContain(old.url);
      expectText(modal, 'taobao-new.svg');
      await settle();
      expect(creates(server)).toEqual([]);
      expect(uploads(server)).toHaveLength(2);
    } finally {
      gate.release();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06ze-UPLOAD#6] 从列表行上传只针对该行：请求路径用该行的键，弹窗标题与副标题随行变化',
  async () => {
    const h = mountUpload();
    await listTable();
    const modal = await openUploadFromRow('wechat_pay', '微信支付');
    expectText(modal, '微信支付 · wechat_pay · 当前生效：内置图');
    await uploadFile(h.server, modal, svgFile('wechat-pay.svg', 4096));
    expect(uploads(h.server).map((request) => request.path)).toEqual([
      '/admin/v1/platform-icons/wechat_pay/uploads',
    ]);
    const url = h.server.uploads.values().next().value!.data.url;
    await previewShown(modal, url);
    expect(button(cell('wechat_pay', '操作'), '上传 微信支付')).toBeDefined();
  },
  FLOW_TIMEOUT,
);
