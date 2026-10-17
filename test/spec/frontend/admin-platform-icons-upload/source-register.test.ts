// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { isVersions } from '../admin-platform-icons/fixtures.ts';
import {
  button,
  cardsShown,
  click,
  dialogs,
  expectText,
  listTable,
  openHistory,
  settle,
  versionCards,
} from '../admin-platform-icons/helpers.ts';
import {
  createUploadServer,
  isPatch,
  registerState,
  reject,
  VERSION_INVALID,
  type UploadServer,
} from './fixtures.ts';
import {
  buttonsNamed,
  COPY,
  field,
  fillSource,
  FLOW_TIMEOUT,
  hasText,
  mountUpload,
  onlyButton,
  openDrawers,
  typeText,
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

/** Open registration dialogs whose title starts with one of `titles`. */
function registerDialogs(titles: readonly string[]): HTMLElement[] {
  return titles.flatMap((title) => dialogs(title));
}

async function registerDialog(...titles: string[]): Promise<HTMLElement> {
  await waitFor(() =>
    expect(registerDialogs(titles), `dialog ${titles.join(' / ')}`).toHaveLength(1),
  );
  const modal = registerDialogs(titles)[0]!;
  expect(modal.closest('.ant-modal'), 'the registration dialog is an antd Modal').not.toBeNull();
  return modal;
}

async function registerClosed(...titles: string[]): Promise<void> {
  await waitFor(() =>
    expect(registerDialogs(titles), 'registration dialog closed').toHaveLength(0),
  );
}

const patches = (server: UploadServer) => server.log.filter(isPatch);

async function openRegister(): Promise<{ drawer: HTMLElement; modal: HTMLElement }> {
  await listTable();
  const drawer = await openHistory('alipay', '支付宝');
  const cards = await cardsShown(drawer, '支付宝', [3, 2, 1]);
  await click(button(cards.get(3)!, '补登来源 支付宝 版本 3'));
  const modal = await registerDialog('补登来源 · 支付宝 版本 3');
  return { drawer, modal };
}

it(
  '[AC-F1-06ze-SOURCE-REGISTER#1] 草稿【补登来源】叠在抽屉上，两项都登记 → PATCH 带版本的 revision；成功后卡片变「可发布」',
  async () => {
    const h = mountUpload(registerState());
    const { drawer, modal } = await openRegister();
    expect(openDrawers('支付宝'), 'the drawer stays under the dialog').toHaveLength(1);
    expectText(
      modal,
      'alipay · 草稿',
      '文件',
      'PNG · 50 KB · 原样保存',
      '保存',
      'ops-yi · 2026-10-09 10:00',
      COPY.sourceHelp,
      COPY.registerNote(3),
    );
    expect(field(modal, COPY.sourceLabel).value).toBe('');
    expect(field(modal, COPY.dateLabel).value).toBe('');
    expect(onlyButton(modal, '取消').disabled).toBe(false);
    await fillSource(modal, { url: 'https://example.test/brand/alipay', date: '2026-10-09' });
    await click(onlyButton(modal, COPY.saveRegister));
    await waitFor(() => expect(patches(h.server)).toHaveLength(1));
    const request = patches(h.server)[0]!;
    expect(request.path).toBe('/admin/v1/platform-icons/alipay/versions/3');
    // CAS on the version's revision (5), not the mark's (3).
    expect(request.body).toEqual({
      expected_revision: 5,
      source_url: 'https://example.test/brand/alipay',
      downloaded_on: '2026-10-09',
    });
    await registerClosed('补登来源 · 支付宝 版本 3');
    expect(openDrawers('支付宝')).toHaveLength(1);
    await waitFor(() => {
      const card = versionCards(drawer, '支付宝').get(3)!;
      expectText(card, '可发布', 'https://example.test/brand/alipay', '2026-10-09');
      expect(hasText(card, '草稿')).toBe(false);
      expect(button(card, '发布 支付宝 版本 3').disabled).toBe(false);
      expect(button(card, '修改来源 支付宝 版本 3').disabled).toBe(false);
    });
    await settle();
    expect(patches(h.server)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06ze-SOURCE-REGISTER#2] 只登记来源页地址：请求体不带下载日期，版本仍是草稿、【发布】置灰',
  async () => {
    const h = mountUpload(registerState());
    const { drawer, modal } = await openRegister();
    await fillSource(modal, { url: 'https://example.test/brand/alipay' });
    await click(onlyButton(modal, COPY.saveRegister));
    await waitFor(() => expect(patches(h.server)).toHaveLength(1));
    expect(patches(h.server)[0]!.body).toEqual({
      expected_revision: 5,
      source_url: 'https://example.test/brand/alipay',
    });
    await registerClosed('补登来源 · 支付宝 版本 3');
    await waitFor(() => {
      const card = versionCards(drawer, '支付宝').get(3)!;
      expectText(card, '草稿', 'https://example.test/brand/alipay');
      expect(hasText(card, '可发布')).toBe(false);
      expect(button(card, /^发布 支付宝 版本 3/).disabled).toBe(true);
      expect(button(card, '补登来源 支付宝 版本 3').disabled).toBe(false);
    });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06ze-SOURCE-REGISTER#3] 20001 fields=[version]：顶部错误条原句 +【刷新版本历史】，刷新后关弹窗并重读版本',
  async () => {
    const server = createUploadServer(registerState());
    server.once(isPatch, reject(VERSION_INVALID, 400));
    mountUpload(server);
    const { drawer, modal } = await openRegister();
    await fillSource(modal, { url: 'https://example.test/brand/alipay', date: '2026-10-09' });
    await click(onlyButton(modal, COPY.saveRegister));
    await waitFor(() => expect(within(modal).queryAllByRole('alert')).toHaveLength(1));
    const alert = within(modal).getByRole('alert');
    expectText(alert, COPY.versionNotEditable);
    expect(hasText(alert, '20902')).toBe(false);
    for (const item of buttonsNamed(modal, COPY.saveRegister))
      expect(item.disabled, '【保存登记】 no longer usable').toBe(true);
    await settle();
    expect(patches(server)).toHaveLength(1);
    const reads = server.log.filter(isVersions('alipay')).length;
    await click(onlyButton(modal, COPY.refreshHistory));
    await registerClosed('补登来源 · 支付宝 版本 3');
    await waitFor(() =>
      expect(server.log.filter(isVersions('alipay')).length).toBeGreaterThan(reads),
    );
    expect(openDrawers('支付宝')).toHaveLength(1);
    await cardsShown(drawer, '支付宝', [3, 2, 1]);
    expect(patches(server)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06ze-SOURCE-REGISTER#4] 20902（别人先登记了）：冲突写法，不重发；【刷新版本历史】关弹窗并重读，显示别人登记的结果',
  async () => {
    const server = createUploadServer(registerState());
    mountUpload(server);
    const { drawer, modal } = await openRegister();
    // Another admin registers version 3 after the dialog opened (its revision moves on).
    server.changeVersion('alipay', 3, {
      source_url: 'https://example.test/brand/alipay/other',
      downloaded_on: '2026-10-10',
      publishable: true,
      revision: 6,
    });
    await fillSource(modal, { url: 'https://example.test/brand/alipay', date: '2026-10-09' });
    await click(onlyButton(modal, COPY.saveRegister));
    await waitFor(() => expect(within(modal).queryAllByRole('alert')).toHaveLength(1));
    const alert = within(modal).getByRole('alert');
    expectText(alert, '未生效', '本次没有做任何修改（20902）');
    expect((patches(server)[0]!.body as { expected_revision?: unknown }).expected_revision).toBe(5);
    for (const item of buttonsNamed(modal, COPY.saveRegister))
      expect(item.disabled, '【保存登记】 no longer usable').toBe(true);
    await settle();
    expect(patches(server), 'no automatic resend').toHaveLength(1);
    await click(onlyButton(modal, COPY.refreshHistory));
    await registerClosed('补登来源 · 支付宝 版本 3');
    await waitFor(() => {
      const card = versionCards(drawer, '支付宝').get(3)!;
      expectText(card, '可发布', 'https://example.test/brand/alipay/other', '2026-10-10');
    });
    expect(patches(server)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06ze-SOURCE-REGISTER#5] 已登记未发布的版本【修改来源】：同一流程，带出原登记，改后 PATCH 带版本 revision',
  async () => {
    const server = createUploadServer();
    // wecom version 1: registered, never published; revision 3 after two earlier changes.
    server.changeVersion('wecom', 1, { revision: 3 });
    mountUpload(server);
    await listTable();
    const drawer = await openHistory('wecom', '企业微信');
    const cards = await cardsShown(drawer, '企业微信', [1]);
    await click(button(cards.get(1)!, '修改来源 企业微信 版本 1'));
    const titles = ['修改来源 · 企业微信 版本 1', '补登来源 · 企业微信 版本 1'];
    const modal = await registerDialog(...titles);
    expect(field(modal, COPY.sourceLabel).value).toBe('https://example.test/brand/wecom');
    expect(field(modal, COPY.dateLabel).value).toBe('2026-10-09');
    await typeText(field(modal, COPY.sourceLabel), 'https://example.test/brand/wecom-official');
    await click(onlyButton(modal, COPY.saveRegister));
    await waitFor(() => expect(patches(server)).toHaveLength(1));
    const request = patches(server)[0]!;
    expect(request.path).toBe('/admin/v1/platform-icons/wecom/versions/1');
    const body = request.body as Record<string, unknown>;
    expect(body['expected_revision']).toBe(3);
    expect(body['source_url']).toBe('https://example.test/brand/wecom-official');
    // The unchanged date may be sent again or left out.
    expect([undefined, '2026-10-09']).toContain(body['downloaded_on']);
    expect(Object.keys(body).sort()).toEqual(
      [
        'expected_revision',
        'source_url',
        ...('downloaded_on' in body ? ['downloaded_on'] : []),
      ].sort(),
    );
    await registerClosed(...titles);
    await waitFor(() =>
      expectText(
        versionCards(drawer, '企业微信').get(1)!,
        '可发布',
        'https://example.test/brand/wecom-official',
      ),
    );
  },
  FLOW_TIMEOUT,
);
