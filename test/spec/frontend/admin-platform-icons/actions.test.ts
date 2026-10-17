// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import {
  ALIPAY_V1,
  ALIPAY_V2,
  boardState,
  createServer,
  isList,
  publishState,
  TAOBAO_V1,
  version,
  type Key,
  type State,
  type Version,
} from './fixtures.ts';
import {
  breadcrumb,
  button,
  cardsShown,
  cell,
  clean,
  click,
  dialog,
  dialogClosed,
  dialogs,
  expectBuiltinPreview,
  expectReplacementPreview,
  expectText,
  FLOW_TIMEOUT,
  highlightOnly,
  listTable,
  mainElement,
  mount,
  noButton,
  openHistory,
  previewNames,
  row,
  settle,
  successBar,
  waitSuccess,
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

const lightDark = (platform: string, label: string) => [
  `${platform} ${label}，浅色底 16、24、32px`,
  `${platform} ${label}，深色底 16、24、32px`,
];

function primaryButtons(modal: HTMLElement): HTMLButtonElement[] {
  return Array.from(modal.querySelectorAll<HTMLButtonElement>('button.ant-btn-primary'));
}

/** Second scenario of 「发布」: built-in now, revision 5 (published and restored before). */
function wecomState(): State {
  const state = boardState();
  state.icons.set('wecom', {
    ...state.icons.get('wecom')!,
    revision: 5,
    latest_version: 2,
    updated_at: '2026-10-11T03:00:00Z',
  });
  state.versions.set('wecom', [
    version('wecom', 1, { ever_published: true }),
    version('wecom', 2, {
      sanitized: false,
      bytes: 2048,
      source_url: 'https://example.test/brand/wecom-2',
      downloaded_on: '2026-10-11',
      created_at: '2026-10-11T03:00:00Z',
      revision: 4,
    }),
  ]);
  return state;
}

const PUBLISH_CASES: readonly {
  name: string;
  key: Key;
  platform: string;
  setup: () => State;
  target: Version;
  revision: number;
  file: string;
  saved: string;
  cards: readonly number[];
}[] = [
  {
    name: '淘宝 版本 1（revision 0）',
    key: 'taobao',
    platform: '淘宝',
    setup: publishState,
    target: TAOBAO_V1,
    revision: 0,
    file: 'SVG · 4 KB · 已清除不安全内容',
    saved: 'ops-yi · 2026-10-12 10:22',
    cards: [1],
  },
  {
    name: '企业微信 版本 2（revision 5，版本自己的 revision 是 4）',
    key: 'wecom',
    platform: '企业微信',
    setup: wecomState,
    target: wecomState().versions.get('wecom')![1]!,
    revision: 5,
    file: 'SVG · 2 KB · 未改动（无需清洗）',
    saved: 'ops-yi · 2026-10-11 11:00',
    cards: [2, 1],
  },
];

for (const scenario of PUBLISH_CASES) {
  it(
    `[AC-F1-06zd-PUBLISH#1] ${scenario.name}：确认弹窗按画板，确认后请求带列表读到的 revision，结果提示、高亮并显示新版本`,
    async () => {
      const { key, platform, target } = scenario;
      const n = target.version;
      const h = mount(scenario.setup());
      await listTable();
      const drawer = await openHistory(key, platform);
      const cards = await cardsShown(drawer, platform, scenario.cards);
      await click(button(cards.get(n)!, `发布 ${platform} 版本 ${n}`));

      const modal = await dialog(`发布 ${platform} 版本 ${n}`);
      expect(modal.closest('.ant-modal'), 'confirmation is an antd Modal').not.toBeNull();
      expectText(
        modal,
        `${key} · 当前生效：内置图`,
        scenario.file,
        scenario.saved,
        target.source_url!,
        target.downloaded_on!,
        `发布后立即生效，不分灰度：App 与 H5 下次取配置时换成版本 ${n}；远程图加载失败时仍显示内置图。`,
        `发布后版本 ${n} 的来源登记锁定，不能再改。之后可随时回滚到其他版本或恢复内置。发布写入操作日志。`,
        '所需权限',
        'content.platform_icon',
        '不需二次验证',
      );
      expect(previewNames(modal).sort()).toEqual(
        [
          ...lightDark(platform, `版本 ${n}（发布后）`),
          ...lightDark(platform, '内置图（当前）'),
        ].sort(),
      );
      for (const name of lightDark(platform, `版本 ${n}（发布后）`))
        expectReplacementPreview(modal, name, target.url);
      for (const name of lightDark(platform, '内置图（当前）'))
        expectBuiltinPreview(modal, name, [target.url]);
      expect(button(modal, '取消').disabled).toBe(false);
      const confirm = button(modal, '确认发布');
      expect(confirm.classList.contains('ant-btn-primary')).toBe(true);
      expect(writes(h.server)).toEqual([]);

      await click(confirm);
      const sentence = `${platform} 已发布版本 ${n}，立即生效。App 与 H5 下次取配置时换成新图，加载失败时仍显示内置图。已写入操作日志。`;
      const bar = await waitSuccess(sentence);
      expect(writes(h.server)).toEqual([
        {
          method: 'POST',
          path: `/admin/v1/platform-icons/${key}/publish`,
          query: {},
          body: { version: n, expected_revision: scenario.revision },
        },
      ]);
      // Back on the list: drawer and dialog closed, bar above the table.
      await waitFor(() => expect(dialogs('')).toHaveLength(0));
      const table = mainElement().querySelector('.ant-table')!;
      expect(bar.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(button(bar, '查看操作日志')).toBeTruthy();
      // The row shows the server's new state, highlighted.
      await waitFor(() => expect(clean(cell(key, '当前生效').textContent)).toMatch(`版本 ${n}`));
      expect(clean(cell(key, '当前生效').textContent)).toMatch(/^版本/);
      expectText(cell(key, '最近变更'), '10-12 10:25', 'owner');
      for (const name of lightDark(platform, `版本 ${n}`))
        expectReplacementPreview(cell(key, '预览（16 · 24 · 32px）'), name, target.url);
      expect(button(cell(key, '操作'), `恢复内置 ${platform}`).disabled).toBe(false);
      expect(highlightOnly(key).length, 'only the published row is highlighted').toBeGreaterThan(0);

      // 【查看操作日志】 opens the audit log menu.
      await click(button(bar, '查看操作日志'));
      await waitFor(() => expect(breadcrumb()).toEqual(['系统', '操作日志']));
      expect(writes(h.server)).toHaveLength(1);
    },
    FLOW_TIMEOUT,
  );
}

it(
  '[AC-F1-06zd-ROLLBACK#1] 回滚：同一发布接口，标题与说明不同，预览列目标、当前与内置图；结果提示「已回滚到版本 n」',
  async () => {
    const h = mount();
    await listTable();
    const drawer = await openHistory('alipay', '支付宝');
    const cards = await cardsShown(drawer, '支付宝', [3, 2, 1]);
    await click(button(cards.get(1)!, '回滚 支付宝 到版本 1'));

    const modal = await dialog('回滚 支付宝 到版本 1');
    expect(modal.closest('.ant-modal')).not.toBeNull();
    expectText(
      modal,
      'alipay · 当前生效：版本 2',
      '目标版本',
      '版本 1 · SVG · 3 KB',
      ALIPAY_V1.source_url!,
      '2026-10-02',
      'ops-yi · 2026-10-02 11:00',
      '回滚即重新发布版本 1，立即生效、不分灰度；App 与 H5 下次取配置时换成版本 1。',
      '版本 2、版本 3 保留在历史里，可再次发布。回滚写入操作日志。',
      'content.platform_icon',
      '不需二次验证',
    );
    expect(modal.textContent).not.toContain('确认发布');
    expect(previewNames(modal).sort()).toEqual(
      [
        ...lightDark('支付宝', '版本 1（回滚后）'),
        ...lightDark('支付宝', '版本 2（当前）'),
        ...lightDark('支付宝', '内置图'),
      ].sort(),
    );
    for (const name of lightDark('支付宝', '版本 1（回滚后）'))
      expectReplacementPreview(modal, name, ALIPAY_V1.url);
    for (const name of lightDark('支付宝', '版本 2（当前）'))
      expectReplacementPreview(modal, name, ALIPAY_V2.url);
    for (const name of lightDark('支付宝', '内置图'))
      expectBuiltinPreview(modal, name, [ALIPAY_V1.url, ALIPAY_V2.url]);
    expect(writes(h.server)).toEqual([]);

    await click(button(modal, '确认回滚'));
    const bar = await waitSuccess('支付宝 已回滚到版本 1');
    expect(clean(bar.textContent)).toMatch(/^支付宝 已回滚到版本 1/);
    expect(bar.textContent).not.toContain('已发布版本');
    expect(writes(h.server)).toEqual([
      {
        method: 'POST',
        path: '/admin/v1/platform-icons/alipay/publish',
        query: {},
        body: { version: 1, expected_revision: 3 },
      },
    ]);
    await waitFor(() => expect(dialogs('')).toHaveLength(0));
    await waitFor(() => expect(clean(cell('alipay', '当前生效').textContent)).toMatch(/^版本 1/));
    for (const name of lightDark('支付宝', '版本 1'))
      expectReplacementPreview(cell('alipay', '预览（16 · 24 · 32px）'), name, ALIPAY_V1.url);
    expect(previewNames(cell('alipay', '预览（16 · 24 · 32px）'))).not.toContain(
      '支付宝 版本 2，浅色底 16、24、32px',
    );
    expect(highlightOnly('alipay').length).toBeGreaterThan(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-RESTORE#1] 行【恢复内置】确认弹窗主按钮用主色，请求带 revision；结果提示、该行回到内置图且按钮置灰',
  async () => {
    const h = mount();
    await listTable();
    await click(button(cell('alipay', '操作'), '恢复内置 支付宝'));
    const modal = await dialog('支付宝 恢复内置图');
    expect(modal.closest('.ant-modal')).not.toBeNull();
    expectText(
      modal,
      'alipay · 当前生效：版本 2',
      '恢复后下发里去掉支付宝的替换图，App 与 H5 下次取配置时回到安装包与 H5 内置的图。',
      '已存的 3 个版本都保留，可在版本历史里再次发布。恢复内置写入操作日志。',
      'content.platform_icon',
      '不需二次验证',
    );
    expect(previewNames(modal).sort()).toEqual(
      [...lightDark('支付宝', '内置图（恢复后）'), ...lightDark('支付宝', '版本 2（当前）')].sort(),
    );
    for (const name of lightDark('支付宝', '版本 2（当前）'))
      expectReplacementPreview(modal, name, ALIPAY_V2.url);
    for (const name of lightDark('支付宝', '内置图（恢复后）'))
      expectBuiltinPreview(modal, name, [ALIPAY_V2.url]);
    const confirm = button(modal, '确认恢复内置');
    expect(confirm.classList.contains('ant-btn-primary')).toBe(true);
    expect(confirm.classList.contains('ant-btn-dangerous')).toBe(false);
    expect(writes(h.server)).toEqual([]);

    await click(confirm);
    const bar = await waitSuccess(
      '支付宝 已恢复内置图。App 与 H5 下次取配置时回到内置图；已存的 3 个版本仍保留，可在版本历史里再次发布。已写入操作日志。',
    );
    expect(button(bar, '查看操作日志')).toBeTruthy();
    expect(writes(h.server)).toEqual([
      {
        method: 'POST',
        path: '/admin/v1/platform-icons/alipay/restore-builtin',
        query: {},
        body: { expected_revision: 3 },
      },
    ]);
    await waitFor(() => expect(dialogs('')).toHaveLength(0));
    await waitFor(() => expect(clean(cell('alipay', '当前生效').textContent)).toMatch(/^内置图/));
    expect(button(cell('alipay', '操作'), '恢复内置 支付宝').disabled).toBe(true);
    expect(clean(cell('alipay', '来源登记').textContent)).toBe('随安装包与 H5 发布，无需登记');
    const preview = cell('alipay', '预览（16 · 24 · 32px）');
    expect(previewNames(preview).sort()).toEqual(lightDark('支付宝', '内置图').sort());
    for (const name of lightDark('支付宝', '内置图')) expectBuiltinPreview(preview, name);
    expect(
      Array.from(preview.querySelectorAll('img'), (image) => image.getAttribute('src')),
    ).not.toContain(ALIPAY_V2.url);
    expectText(cell('alipay', '最近变更'), '10-12 10:25', 'owner');
    expect(highlightOnly('alipay').length).toBeGreaterThan(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-RESTORE#2] 抽屉里的【恢复内置】与【回滚到此版】取消后回到抽屉，不发写请求',
  async () => {
    const h = mount();
    await listTable();
    const drawer = await openHistory('alipay', '支付宝');
    const cards = await cardsShown(drawer, '支付宝', [3, 2, 1]);

    await click(button(drawer, '恢复内置'));
    const restore = await dialog('支付宝 恢复内置图');
    await click(button(restore, '取消'));
    await dialogClosed('支付宝 恢复内置图');
    expect(dialogs('版本历史 · 支付宝')).toHaveLength(1);

    await click(button(cards.get(1)!, '回滚 支付宝 到版本 1'));
    const rollback = await dialog('回滚 支付宝 到版本 1');
    await click(button(rollback, '取消'));
    await dialogClosed('回滚 支付宝 到版本 1');
    expect(dialogs('版本历史 · 支付宝')).toHaveLength(1);
    await settle();
    expect(writes(h.server)).toEqual([]);
    expect(mainElement().querySelectorAll('.ant-alert-success')).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);

it.each([
  { action: '发布', open: 'history', confirm: '确认发布' },
  { action: '回滚', open: 'history', confirm: '确认回滚' },
  { action: '恢复内置', open: 'row', confirm: '确认恢复内置' },
] as const)(
  '[AC-F1-06zd-PUBLISH#2] $action 在途时主按钮与取消禁用，再点一次也只发一个请求',
  async ({ action, open, confirm }) => {
    const server = createServer(publishState());
    const gate = server.hold((request) => request.method === 'POST');
    mount(server);
    try {
      await listTable();
      let modal: HTMLElement;
      if (open === 'row') {
        await click(button(cell('alipay', '操作'), '恢复内置 支付宝'));
        modal = await dialog('支付宝 恢复内置图');
      } else if (action === '发布') {
        const drawer = await openHistory('taobao', '淘宝');
        const cards = await cardsShown(drawer, '淘宝', [1]);
        await click(button(cards.get(1)!, '发布 淘宝 版本 1'));
        modal = await dialog('发布 淘宝 版本 1');
      } else {
        const drawer = await openHistory('alipay', '支付宝');
        const cards = await cardsShown(drawer, '支付宝', [3, 2, 1]);
        await click(button(cards.get(1)!, '回滚 支付宝 到版本 1'));
        modal = await dialog('回滚 支付宝 到版本 1');
      }
      const primary = button(modal, confirm);
      await click(primary);
      await waitFor(() => expect(writes(server)).toHaveLength(1));
      await waitFor(() => {
        const buttons = primaryButtons(modal);
        expect(buttons.length).toBeGreaterThan(0);
        for (const item of buttons) expect(item.disabled, 'primary button in flight').toBe(true);
      });
      const cancel = Array.from(modal.querySelectorAll('button')).find(
        (item) => clean(item.textContent).replace(/\s/g, '') === '取消',
      );
      expect(cancel?.disabled, '取消 in flight').toBe(true);
      // A second press (the same node if still mounted, else the current primary button).
      await act(async () => {
        fireEvent.click(primary.isConnected ? primary : primaryButtons(modal)[0]!);
      });
      await settle();
      expect(writes(server)).toHaveLength(1);
      await act(async () => gate.release());
      await waitFor(() =>
        expect(mainElement().querySelectorAll('.ant-alert-success').length).toBeGreaterThan(0),
      );
      await settle();
      expect(writes(server)).toHaveLength(1);
    } finally {
      gate.release();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-PUBLISH#3] 成功后下一次写请求用新的 revision（发布后立刻恢复内置）',
  async () => {
    const h = mount(publishState());
    await listTable();
    const drawer = await openHistory('taobao', '淘宝');
    const cards = await cardsShown(drawer, '淘宝', [1]);
    await click(button(cards.get(1)!, '发布 淘宝 版本 1'));
    await click(button(await dialog('发布 淘宝 版本 1'), '确认发布'));
    await waitSuccess('淘宝 已发布版本 1');
    await waitFor(() => expect(dialogs('')).toHaveLength(0));
    await waitFor(() =>
      expect(button(cell('taobao', '操作'), '恢复内置 淘宝').disabled).toBe(false),
    );

    await click(button(cell('taobao', '操作'), '恢复内置 淘宝'));
    const modal = await dialog('淘宝 恢复内置图');
    expectText(modal, 'taobao · 当前生效：版本 1', '已存的 1 个版本都保留');
    await click(button(modal, '确认恢复内置'));
    await waitSuccess('淘宝 已恢复内置图');
    expect(writes(h.server).map((request) => [request.path, request.body])).toEqual([
      ['/admin/v1/platform-icons/taobao/publish', { version: 1, expected_revision: 0 }],
      ['/admin/v1/platform-icons/taobao/restore-builtin', { expected_revision: 1 }],
    ]);
    await waitFor(() => expect(clean(cell('taobao', '当前生效').textContent)).toMatch(/^内置图/));
    expect(() => successBar('淘宝 已发布版本 1')).toThrow();
    noButton(row('taobao'), /^回滚/);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-RESTORE#3] 先发的列表读取迟到时不覆盖恢复内置后的新状态',
  async () => {
    const server = createServer();
    mount(server);
    await listTable();
    const drawer = await openHistory('alipay', '支付宝');
    await cardsShown(drawer, '支付宝', [3, 2, 1]);
    // Closing the drawer refreshes the list (flow-map §24); hold that read: it answers the old
    // state (alipay on version 2) and arrives after the restore below.
    const stale = server.hold(isList);
    const lists = server.log.filter(isList).length;
    await click(within(drawer).getAllByRole('button', { name: '关闭' })[0]!);
    await dialogClosed('版本历史 · 支付宝');
    await waitFor(() => expect(server.log.filter(isList)).toHaveLength(lists + 1));
    try {
      const restore = button(cell('alipay', '操作'), '恢复内置 支付宝');
      // Only when the row stays usable while the refresh is under way can the old answer
      // arrive after a newer one; otherwise there is no late answer to guard against.
      if (!restore.disabled) {
        await click(restore);
        await click(button(await dialog('支付宝 恢复内置图'), '确认恢复内置'));
        await waitSuccess('支付宝 已恢复内置图');
        await waitFor(() =>
          expect(clean(cell('alipay', '当前生效').textContent)).toMatch(/^内置图/),
        );
        await act(async () => stale.release());
        await settle();
        expect(clean(cell('alipay', '当前生效').textContent)).toMatch(/^内置图/);
        expect(button(cell('alipay', '操作'), '恢复内置 支付宝').disabled).toBe(true);
        expect(previewNames(cell('alipay', '预览（16 · 24 · 32px）'))).not.toContain(
          '支付宝 版本 2，浅色底 16、24、32px',
        );
      } else {
        await act(async () => stale.release());
        await waitFor(() =>
          expect(button(cell('alipay', '操作'), '恢复内置 支付宝').disabled).toBe(false),
        );
      }
    } finally {
      stale.release();
    }
    expect(writes(server).length).toBeLessThanOrEqual(1);
  },
  FLOW_TIMEOUT,
);
