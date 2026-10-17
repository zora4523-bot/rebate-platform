// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { jsonResponse } from '../admin-data/fixtures.ts';
import {
  ALIPAY_V1,
  ALIPAY_V2,
  ALIPAY_V3,
  boardState,
  createServer,
  isList,
  isVersions,
  JD_V1,
  publishState,
  TAOBAO_V1,
  version,
  type LoggedRequest,
} from './fixtures.ts';
import {
  button,
  cardsShown,
  click,
  dialog,
  dialogClosed,
  dialogs,
  expectAllBuiltinPreviews,
  expectBuiltinPreview,
  expectReplacementPreview,
  expectText,
  FLOW_TIMEOUT,
  listTable,
  mount,
  noButton,
  openHistory,
  previewNames,
  row,
  settle,
  writes,
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

const versionsOf = (log: readonly LoggedRequest[], key: Parameters<typeof isVersions>[0]) =>
  log.filter(isVersions(key)).map((request) => request.query);

function drawerWidth(drawer: HTMLElement): string | undefined {
  return drawer.closest<HTMLElement>('.ant-drawer-content-wrapper')?.style.width;
}

it(
  '[AC-F1-06zd-HISTORY#1] 行【历史】打开 720 宽 antd 抽屉，GET 第 1 页版本，卡片新的在前并标状态、文件与登记',
  async () => {
    const h = mount();
    await listTable();
    const drawer = await openHistory('alipay', '支付宝');
    expect(drawerWidth(drawer)).toBe('720px');
    const cards = await cardsShown(drawer, '支付宝', [3, 2, 1]);
    expect(versionsOf(h.server.log, 'alipay')).toEqual([{ page: '1', page_size: '20' }]);
    expect(writes(h.server)).toEqual([]);

    // Header: key, permission line, what is live and who changed it last.
    expectText(
      drawer,
      'alipay',
      '所需权限 content.platform_icon（不需二次验证）',
      '发布即生效，不分灰度',
      '当前生效',
      '版本 2',
      '最近变更',
      '10-09 10:00 · ops-yi',
      '已存版本',
      '共 3 个',
      '版本（新的在前）',
    );
    expect(button(drawer, '上传新版本').disabled).toBe(false);
    expect(button(drawer, '恢复内置').disabled).toBe(false);

    // Version 3: draft without registration; 【发布】 disabled with its reason, 【补登来源】 offered.
    const v3 = cards.get(3)!;
    expectText(
      v3,
      '草稿 · 来源未登记',
      'PNG · 50 KB · 原样保存',
      '来源页地址',
      '未登记',
      '下载日期',
      'ops-yi · 2026-10-09 10:00',
      '缺来源页地址与下载日期，补登后才能发布。',
    );
    expect(button(v3, /^发布 支付宝 版本 3/).disabled).toBe(true);
    expect(button(v3, '补登来源 支付宝 版本 3')).toBeTruthy();
    noButton(v3, /^回滚/);

    // Version 2: live; neither 【发布】 nor 【回滚到此版】.
    const v2 = cards.get(2)!;
    expectText(
      v2,
      '当前生效',
      'SVG · 4 KB · 已清除不安全内容',
      ALIPAY_V2.source_url!,
      '2026-10-08',
      'ops-yi · 2026-10-08 15:00',
    );
    noButton(v2, /^发布/);
    noButton(v2, /^回滚/);

    // Version 1: published before, older than the live one → 【回滚到此版】; registration locked.
    const v1 = cards.get(1)!;
    expectText(
      v1,
      '曾发布',
      'SVG · 3 KB · 未改动（无需清洗）',
      ALIPAY_V1.source_url!,
      '2026-10-02',
      'ops-yi · 2026-10-02 11:00',
      '来源登记在发布后锁定，不能再改。',
    );
    const rollback = button(v1, '回滚 支付宝 到版本 1');
    expect(rollback.disabled).toBe(false);
    expectText(rollback, '回滚到此版');
    noButton(v1, /^发布/);
    noButton(v1, /^补登来源|^修改来源/);
    for (const card of [v2, v1]) expect(card.textContent).not.toContain('草稿');

    // Every card previews its own cleaned file beside the built-in image.
    for (const [n, item] of [
      [3, ALIPAY_V3],
      [2, ALIPAY_V2],
      [1, ALIPAY_V1],
    ] as const) {
      const card = cards.get(n)!;
      expect(previewNames(card).sort()).toEqual(
        [
          `支付宝 版本 ${n}，浅色底 16、24、32px`,
          `支付宝 版本 ${n}，深色底 16、24、32px`,
          '支付宝 内置图，浅色底 16、24、32px',
          '支付宝 内置图，深色底 16、24、32px',
        ].sort(),
      );
      expectReplacementPreview(card, `支付宝 版本 ${n}，浅色底 16、24、32px`, item.url);
      expectReplacementPreview(card, `支付宝 版本 ${n}，深色底 16、24、32px`, item.url);
      expectBuiltinPreview(card, '支付宝 内置图，浅色底 16、24、32px', [item.url]);
      expectBuiltinPreview(card, '支付宝 内置图，深色底 16、24、32px', [item.url]);
    }

    // One page only: both page buttons disabled.
    expectText(drawer, '共 3 个版本 · 每页 20 个 · 第 1 / 1 页');
    expect(button(drawer, '上一页').disabled).toBe(true);
    expect(button(drawer, '下一页').disabled).toBe(true);
    expect(h.media).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it.each([
  {
    name: '当前是内置图、版本从未发布 → 可发布 + 【发布】',
    key: 'taobao' as const,
    platform: '淘宝',
    setup: publishState,
    expected: [[1, '可发布', '发布 淘宝 版本 1']] as const,
  },
  {
    name: '当前是内置图、版本曾发布 → 曾发布 + 【发布】（不叫回滚）',
    key: 'wecom' as const,
    platform: '企业微信',
    setup: () => {
      const state = boardState();
      state.icons.set('wecom', {
        ...state.icons.get('wecom')!,
        revision: 2,
        latest_version: 2,
      });
      state.versions.set('wecom', [
        version('wecom', 1, { ever_published: true }),
        version('wecom', 2, { created_at: '2026-10-10T01:00:00Z' }),
      ]);
      return state;
    },
    expected: [
      [2, '可发布', '发布 企业微信 版本 2'],
      [1, '曾发布', '发布 企业微信 版本 1'],
    ] as const,
  },
  {
    name: '比当前新、已登记 → 可发布 + 【发布】',
    key: 'jd' as const,
    platform: '京东',
    setup: () => {
      const state = boardState();
      state.icons.set('jd', { ...state.icons.get('jd')!, latest_version: 2 });
      state.versions.set('jd', [JD_V1, version('jd', 2, { created_at: '2026-10-11T01:00:00Z' })]);
      return state;
    },
    expected: [[2, '可发布', '发布 京东 版本 2']] as const,
  },
])(
  '[AC-F1-06zd-HISTORY#2] $name',
  async ({ key, platform, setup, expected }) => {
    mount(setup());
    await listTable();
    const drawer = await openHistory(key, platform);
    const cards = await cardsShown(
      drawer,
      platform,
      key === 'jd' ? [2, 1] : expected.map(([n]) => n),
    );
    for (const [n, label, action] of expected) {
      const card = cards.get(n)!;
      expectText(card, label);
      expect(card.textContent).not.toContain('草稿');
      const publish = button(card, action);
      expect(publish.disabled).toBe(false);
      expectText(publish, '发布');
      noButton(card, /^回滚/);
    }
    if (key === 'jd') {
      // The live version 1 offers neither action.
      expectText(cards.get(1)!, '当前生效');
      noButton(cards.get(1)!, /^发布|^回滚/);
    }
    if (key === 'taobao') expectText(cards.get(1)!, TAOBAO_V1.source_url!, '2026-10-12');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-HISTORY#3] 版本历史分页：第 n / pages 页，上一页 / 下一页每次只请求那一页一次',
  async () => {
    const state = boardState();
    const all = Array.from({ length: 45 }, (_, index) =>
      version('alipay', index + 1, { ever_published: true }),
    );
    state.versions.set('alipay', all);
    state.icons.set('alipay', {
      ...state.icons.get('alipay')!,
      current_version: 45,
      current: all[44]!,
      latest_version: 45,
    });
    const h = mount(state);
    await listTable();
    const drawer = await openHistory('alipay', '支付宝');
    const range = (from: number, to: number) =>
      Array.from({ length: from - to + 1 }, (_, index) => from - index);

    await cardsShown(drawer, '支付宝', range(45, 26));
    expectText(drawer, '共 45 个版本 · 每页 20 个 · 第 1 / 3 页', '共 45 个');
    expect(button(drawer, '上一页').disabled).toBe(true);
    expect(button(drawer, '下一页').disabled).toBe(false);
    expect(versionsOf(h.server.log, 'alipay')).toEqual([{ page: '1', page_size: '20' }]);

    await click(button(drawer, '下一页'));
    await cardsShown(drawer, '支付宝', range(25, 6));
    expectText(drawer, '第 2 / 3 页');
    expect(button(drawer, '上一页').disabled).toBe(false);
    expect(button(drawer, '下一页').disabled).toBe(false);
    expect(versionsOf(h.server.log, 'alipay')).toEqual([
      { page: '1', page_size: '20' },
      { page: '2', page_size: '20' },
    ]);

    await click(button(drawer, '下一页'));
    await cardsShown(drawer, '支付宝', range(5, 1));
    expectText(drawer, '第 3 / 3 页');
    expect(button(drawer, '下一页').disabled).toBe(true);
    expect(versionsOf(h.server.log, 'alipay')).toEqual([
      { page: '1', page_size: '20' },
      { page: '2', page_size: '20' },
      { page: '3', page_size: '20' },
    ]);

    await click(button(drawer, '上一页'));
    await cardsShown(drawer, '支付宝', range(25, 6));
    expectText(drawer, '第 2 / 3 页');
    // Going back may reuse page 2 or read it again, but at most once.
    const pages = versionsOf(h.server.log, 'alipay');
    expect(pages.slice(0, 3)).toEqual([
      { page: '1', page_size: '20' },
      { page: '2', page_size: '20' },
      { page: '3', page_size: '20' },
    ]);
    expect(pages.slice(3)).toEqual(pages.length === 3 ? [] : [{ page: '2', page_size: '20' }]);
    expect(writes(h.server)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-HISTORY#4] 没有版本时抽屉显示空态、内置图预览与【上传替换图】',
  async () => {
    const h = mount();
    await listTable();
    const drawer = await openHistory('tmall', '天猫');
    await waitFor(() => expectText(drawer, '还没有上传过替换图'));
    expect(versionsOf(h.server.log, 'tmall')).toEqual([{ page: '1', page_size: '20' }]);
    expectText(
      drawer,
      'tmall',
      '当前生效',
      '内置图',
      '已存版本',
      '0 个',
      '天猫 目前显示安装包与 H5 内置的图（预览见上方）。上传后先存为版本，发布后才生效。',
    );
    expect(previewNames(drawer).sort()).toEqual(
      ['天猫 内置图，浅色底 16、24、32px', '天猫 内置图，深色底 16、24、32px'].sort(),
    );
    const upload = button(drawer, '上传替换图');
    expect(upload.disabled).toBe(false);
    expectAllBuiltinPreviews(drawer, 2);
    expect(
      within(drawer)
        .queryAllByRole('listitem')
        .filter((item) => item.querySelector('img')),
    ).toHaveLength(0);
    // The upload flow itself is F1-06ze; pressing the entry must not break the page.
    await click(upload);
    await settle();
    expect(writes(h.server)).toEqual([]);
    expect(document.querySelector('main')).not.toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-HISTORY#5] 关闭抽屉刷新列表；先开的抽屉迟到的版本响应不覆盖后开的抽屉',
  async () => {
    const server = createServer();
    const late = server.hold(isVersions('alipay'));
    mount(server);
    await listTable();
    const first = await openHistory('alipay', '支付宝');
    await waitFor(() => expect(server.log.filter(isVersions('alipay'))).toHaveLength(1));
    const lists = server.log.filter(isList).length;
    await click(within(first).getAllByRole('button', { name: '关闭' })[0]!);
    await dialogClosed('版本历史 · 支付宝');
    // flow-map §24: closing the drawer refreshes the list with the latest data.
    await waitFor(() => expect(server.log.filter(isList)).toHaveLength(lists + 1));
    await listTable();
    await waitFor(() => expect(button(row('jd'), '历史 京东').disabled).toBe(false));

    const second = await openHistory('jd', '京东');
    await cardsShown(second, '京东', [1]);
    await act(async () => late.release());
    await settle();
    expect(dialogs('版本历史 · 支付宝')).toHaveLength(0);
    const open = await dialog('版本历史 · 京东');
    await cardsShown(open, '京东', [1]);
    expect(previewNames(open).some((name) => name.startsWith('支付宝'))).toBe(false);
    // The late answer carried alipay's draft version 3: no card of the open drawer may show it
    // (the drawer header's 「已存版本 共 n 个（含草稿）」 wording is not a card and stays allowed).
    for (const item of within(open).queryAllByRole('listitem'))
      expect(item.textContent, 'version card of the 京东 drawer').not.toContain('草稿');
    expectText(open, 'jd', '版本 1');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-HISTORY#6] 版本加载失败时卡片区显示「版本加载失败」+【重试】，重试只再请求一次',
  async () => {
    const server = createServer();
    server.once(isVersions('alipay'), () =>
      jsonResponse({ code: 50000, msg: '服务暂时不可用' }, 503),
    );
    mount(server);
    await listTable();
    const drawer = await openHistory('alipay', '支付宝');
    await waitFor(() => expectText(drawer, '版本加载失败'));
    expectText(drawer, '当前生效', '版本 2');
    expect(dialogs('版本历史 · 支付宝')).toEqual([drawer]);
    expect(server.log.filter(isVersions('alipay'))).toHaveLength(1);
    await click(button(drawer, '重试'));
    await cardsShown(drawer, '支付宝', [3, 2, 1]);
    expect(versionsOf(server.log, 'alipay')).toEqual([
      { page: '1', page_size: '20' },
      { page: '1', page_size: '20' },
    ]);
    expect(drawer.textContent).not.toContain('版本加载失败');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-HISTORY#7] 只登记一项来源的版本也是草稿：标草稿、【发布】置灰、点了也不发请求',
  async () => {
    // BR-TEXT-24 「必填登记」: a version missing either registration is a draft (publishable=false).
    const state = boardState();
    state.icons.set('alipay', { ...state.icons.get('alipay')!, latest_version: 5 });
    state.versions.set('alipay', [
      ...state.versions.get('alipay')!,
      version('alipay', 4, {
        source_url: 'https://example.test/brand/alipay/v4',
        downloaded_on: null,
        publishable: false,
        created_at: '2026-10-10T02:00:00Z',
      }),
      version('alipay', 5, {
        source_url: null,
        downloaded_on: '2026-10-11',
        publishable: false,
        created_at: '2026-10-11T02:00:00Z',
      }),
    ]);
    const h = mount(state);
    await listTable();
    const drawer = await openHistory('alipay', '支付宝');
    const cards = await cardsShown(drawer, '支付宝', [5, 4, 3, 2, 1]);
    for (const n of [5, 4]) {
      const card = cards.get(n)!;
      expectText(card, '草稿');
      expect(card.textContent, `version ${n}`).not.toContain('可发布');
      expect(card.textContent, `version ${n}`).not.toContain('曾发布');
      const publish = button(card, new RegExp(`^发布 支付宝 版本 ${n}`));
      expect(publish.disabled, `version ${n}`).toBe(true);
      noButton(card, /^回滚/);
      // A press on the disabled button opens nothing and sends nothing.
      await click(publish);
      await settle();
      expect(dialogs(`发布 支付宝 版本 ${n}`)).toHaveLength(0);
    }
    expectText(cards.get(4)!, 'https://example.test/brand/alipay/v4');
    expectText(cards.get(5)!, '2026-10-11');
    expect(writes(h.server)).toEqual([]);
  },
  FLOW_TIMEOUT,
);
