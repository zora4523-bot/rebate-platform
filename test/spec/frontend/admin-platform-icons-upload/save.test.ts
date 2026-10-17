// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { isList, isVersions } from '../admin-platform-icons/fixtures.ts';
import {
  button,
  cardsShown,
  cell,
  clean,
  click,
  dialogClosed,
  dialogs,
  expectReplacementPreview,
  expectText,
  listTable,
  noButton,
  openHistory,
  settle,
} from '../admin-platform-icons/helpers.ts';
import { createUploadServer, isCreate, svgFile, type UploadServer } from './fixtures.ts';
import {
  confirmBox,
  COPY,
  creates,
  fillSource,
  FLOW_TIMEOUT,
  hasText,
  historyDrawer,
  mountUpload,
  onlyButton,
  openUploadFromRow,
  previewShown,
  uploadDialog,
  uploadFile,
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

/** Uploads a cleaned SVG for taobao from its row, confirms the preview; returns the dialog. */
async function cleanedTaobao(server: UploadServer): Promise<HTMLElement> {
  await listTable();
  const modal = await openUploadFromRow('taobao', '淘宝');
  await uploadFile(server, modal, svgFile('taobao-logo.svg', 9216));
  const upload = [...server.uploads.values()][0]!.data;
  await previewShown(modal, upload.url);
  await click(confirmBox(modal));
  await waitFor(() => expect(onlyButton(modal, COPY.save).disabled).toBe(false));
  return modal;
}

/** The success bar of the history drawer: an antd Alert inside it holding `sentence`. */
function drawerBar(drawer: HTMLElement, sentence: string): HTMLElement {
  const bars = Array.from(drawer.querySelectorAll<HTMLElement>('.ant-alert')).filter((bar) =>
    hasText(bar, sentence),
  );
  expect(bars, `antd Alert 「${sentence}」 in the drawer`).toHaveLength(1);
  return bars[0]!;
}

it(
  '[AC-F1-06ze-SAVE#1] 来源两项都填：存为版本请求体含 upload_id、sanitized_confirmed、source_url、downloaded_on；落到历史抽屉、成功提示、列表重读',
  async () => {
    const h = mountUpload();
    const modal = await cleanedTaobao(h.server);
    await fillSource(modal, { url: 'https://example.test/brand/taobao', date: '2026-10-09' });
    const lists = h.server.log.filter(isList).length;
    await click(onlyButton(modal, COPY.save));
    await waitFor(() => expect(creates(h.server)).toHaveLength(1));
    const request = creates(h.server)[0]!;
    expect(request.path).toBe('/admin/v1/platform-icons/taobao/versions');
    expect(request.headers['content-type']).toContain('application/json');
    expect(request.body).toEqual({
      upload_id: [...h.server.uploads.keys()][0],
      sanitized_confirmed: true,
      source_url: 'https://example.test/brand/taobao',
      downloaded_on: '2026-10-09',
    });

    // Lands on the key's history drawer with the success bar (AdmPlatformIconSaved).
    await dialogClosed(uploadTitle('淘宝'));
    const drawer = await historyDrawer('淘宝');
    const cards = await cardsShown(drawer, '淘宝', [1]);
    expect(drawerBar(drawer, COPY.savedPublishable(1))).toBeDefined();
    expectText(cards.get(1)!, '可发布', 'https://example.test/brand/taobao', '2026-10-09');
    expect(button(cards.get(1)!, '发布 淘宝 版本 1').disabled).toBe(false);
    expect(button(cards.get(1)!, '修改来源 淘宝 版本 1').disabled).toBe(false);
    expectReplacementPreview(
      cards.get(1)!,
      '淘宝 版本 1，浅色底 16、24、32px',
      [...h.server.uploads.values()][0]!.data.url,
    );
    // The list is read again after the save and shows the new unpublished version.
    const postIndex = h.server.log.indexOf(request);
    await waitFor(() =>
      expect(h.server.log.slice(postIndex + 1).filter(isList).length).toBeGreaterThan(0),
    );
    expect(h.server.log.filter(isList).length).toBeGreaterThan(lists);
    await waitFor(() =>
      expect(clean(cell('taobao', '当前生效').textContent)).toContain('未发布：版本 1'),
    );
    await settle();
    expect(creates(h.server)).toHaveLength(1);
    expect(dialogs('上传替换图')).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);

for (const missing of [
  { name: '两项都不填', values: {}, body: {} },
  {
    name: '只填来源页地址',
    values: { url: 'https://example.test/brand/taobao' },
    body: { source_url: 'https://example.test/brand/taobao' },
  },
  { name: '只填下载日期', values: { date: '2026-10-08' }, body: { downloaded_on: '2026-10-08' } },
] as const) {
  it(
    `[AC-F1-06ze-SAVE#2] ${missing.name}：仍可存，请求体不带缺的项；按服务端 publishable=false 显示为草稿`,
    async () => {
      const h = mountUpload();
      const modal = await cleanedTaobao(h.server);
      await fillSource(modal, missing.values);
      expect(onlyButton(modal, COPY.save).disabled, 'a draft can be saved').toBe(false);
      await click(onlyButton(modal, COPY.save));
      await waitFor(() => expect(creates(h.server)).toHaveLength(1));
      expect(creates(h.server)[0]!.body).toEqual({
        upload_id: [...h.server.uploads.keys()][0],
        sanitized_confirmed: true,
        ...missing.body,
      });
      expect(h.server.state.versions.get('taobao')![0]!.publishable).toBe(false);

      const drawer = await historyDrawer('淘宝');
      const cards = await cardsShown(drawer, '淘宝', [1]);
      const bar = drawerBar(drawer, COPY.saved(1));
      // A draft cannot be published: the bar does not send the operator to 【发布】.
      expect(hasText(bar, '核对预览后点【发布】')).toBe(false);
      expectText(cards.get(1)!, '草稿');
      expect(hasText(cards.get(1)!, '可发布')).toBe(false);
      expect(button(cards.get(1)!, /^发布 淘宝 版本 1/).disabled).toBe(true);
      expect(button(cards.get(1)!, '补登来源 淘宝 版本 1').disabled).toBe(false);
    },
    FLOW_TIMEOUT,
  );
}

it(
  '[AC-F1-06ze-SAVE#3] 存为版本在途时按钮禁用，双击也只发一次（同一 upload_id 不重复提交）',
  async () => {
    const server = createUploadServer();
    const gate = server.hold(isCreate);
    mountUpload(server);
    try {
      const modal = await cleanedTaobao(server);
      await fillSource(modal, { url: 'https://example.test/brand/taobao', date: '2026-10-09' });
      const save = onlyButton(modal, COPY.save);
      // Two presses in a row (a double click): each its own event.
      await act(async () => {
        fireEvent.click(save);
      });
      await act(async () => {
        fireEvent.click(save.isConnected ? save : onlyButton(modal, COPY.save));
      });
      await waitFor(() => expect(creates(server)).toHaveLength(1));
      await waitFor(() => expect(onlyButton(modal, COPY.save).disabled).toBe(true));
      await act(async () => {
        fireEvent.click(save.isConnected ? save : onlyButton(modal, COPY.save));
      });
      await settle();
      expect(creates(server)).toHaveLength(1);
      await act(async () => gate.release());
      await historyDrawer('淘宝');
      await settle();
      expect(creates(server)).toHaveLength(1);
      expect(server.state.versions.get('taobao')).toHaveLength(1);
    } finally {
      gate.release();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06ze-SAVE#4] 从抽屉上传新版本（支付宝）：存为版本 4 后抽屉重读版本，新卡片在最前并显示上传的文件',
  async () => {
    const server = createUploadServer();
    server.uploadAs({ sanitized: false });
    mountUpload(server);
    await listTable();
    const drawer = await openHistory('alipay', '支付宝');
    await cardsShown(drawer, '支付宝', [3, 2, 1]);
    const reads = server.log.filter(isVersions('alipay')).length;
    await click(button(drawer, '上传新版本'));
    const modal = await uploadDialog('支付宝');
    await uploadFile(server, modal, svgFile('alipay-2026.svg', 6144));
    const upload = [...server.uploads.values()][0]!.data;
    await previewShown(modal, upload.url);
    await fillSource(modal, { url: 'https://example.test/brand/alipay/2026', date: '2026-10-11' });
    await click(onlyButton(modal, COPY.save));
    await waitFor(() => expect(creates(server)).toHaveLength(1));
    const body = creates(server)[0]!.body as Record<string, unknown>;
    expect(body['upload_id']).toBe(upload.upload_id);
    expect(body['source_url']).toBe('https://example.test/brand/alipay/2026');
    expect(body['downloaded_on']).toBe('2026-10-11');
    // sanitized=false: the confirmation is not needed (absent or false are both fine).
    expect([undefined, false]).toContain(body['sanitized_confirmed']);

    await dialogClosed(uploadTitle('支付宝'));
    const after = await historyDrawer('支付宝');
    const cards = await cardsShown(after, '支付宝', [4, 3, 2, 1]);
    expect(server.log.filter(isVersions('alipay')).length).toBeGreaterThan(reads);
    drawerBar(after, COPY.savedPublishable(4));
    expectReplacementPreview(cards.get(4)!, '支付宝 版本 4，浅色底 16、24、32px', upload.url);
    expectText(cards.get(4)!, '可发布', 'https://example.test/brand/alipay/2026');
    noButton(cards.get(4)!, /^回滚/);
    expect(button(cards.get(4)!, '发布 支付宝 版本 4').disabled).toBe(false);
  },
  FLOW_TIMEOUT,
);
