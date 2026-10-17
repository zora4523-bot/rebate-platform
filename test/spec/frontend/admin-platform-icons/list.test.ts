// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { API_ERRORS, jsonResponse } from '../admin-data/fixtures.ts';
import {
  ALIPAY_V2,
  boardState,
  createServer,
  isList,
  JD_V1,
  KEYS,
  NAMES,
  version,
  type Key,
} from './fixtures.ts';
import {
  button,
  cell,
  clean,
  expectAllBuiltinPreviews,
  expectBuiltinPreview,
  expectReplacementPreview,
  expectText,
  FLOW_TIMEOUT,
  headers,
  listTable,
  mainElement,
  mount,
  previewNames,
  rowKeys,
} from './helpers.ts';

beforeEach(() => {
  installMediaQuery();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:00:00+08:00'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Oracle: board AdmPlatformIcons (column titles, cell wording) and decisions-r20 §2 (names).
const COLUMNS = ['标识', '当前生效', '预览（16 · 24 · 32px）', '来源登记', '最近变更', '操作'];
const BUILTIN_SOURCE = '随安装包与 H5 发布，无需登记';
const BUILTIN_KEYS: readonly Key[] = ['taobao', 'tmall', 'pdd', 'wechat', 'wechat_pay', 'wecom'];

const lightDark = (platform: string, label: string) => [
  `${platform} ${label}，浅色底 16、24、32px`,
  `${platform} ${label}，深色底 16、24、32px`,
];

it(
  '[AC-F1-06zd-LIST#1] 进入页面只 GET 一次列表，8 个标识键按枚举顺序成行，列头、标题与说明按画板',
  async () => {
    const h = mount();
    const table = await listTable();
    expect(h.server.log).toEqual([
      { method: 'GET', path: '/admin/v1/platform-icons', query: {}, body: undefined },
    ]);
    expect(rowKeys(table)).toEqual([...KEYS]);
    expect(headers(table)).toEqual(COLUMNS);
    for (const key of KEYS) {
      const identity = cell(key, '标识');
      expectText(identity, NAMES[key], key);
    }
    const main = mainElement();
    expect(within(main).getByRole('heading', { name: '平台标识' })).toBeTruthy();
    expectText(main, '共 8 个标识', '所需权限', 'content.platform_icon', '不需二次验证');
    // The two-paragraph explanation of the board (BR-TEXT-24 wording), not a shortened note.
    expectText(
      main,
      '界面里的平台来源、授权、支付 / 收款方式、分享去向标识只用平台官方原图。',
      '远程图缺失、加载失败或校验不通过时，App 与 H5 显示内置图。',
      '标注「仅限签约商户」「不得公开分发」的素材不要上传（替换图经 CDN 公开可读）。',
      '发布、回滚、恢复内置都写入操作日志。',
    );
    expect(h.media).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-LIST#2] 当前生效、来源登记、最近变更（北京时间）与操作按钮按每行数据显示',
  async () => {
    mount();
    await listTable();
    // 当前生效: 内置图 / 版本 n, plus 「未发布：版本 n」 when a newer version is saved.
    for (const key of ['taobao', 'tmall', 'pdd', 'wechat', 'wechat_pay'] as const)
      expect(clean(cell(key, '当前生效').textContent), key).toBe('内置图');
    expect(clean(cell('jd', '当前生效').textContent)).toBe('版本 1');
    expectText(cell('alipay', '当前生效'), '版本 2', '未发布：版本 3');
    expect(clean(cell('alipay', '当前生效').textContent)).toMatch(/^版本 2/);
    expectText(cell('wecom', '当前生效'), '内置图', '未发布：版本 1');
    expect(clean(cell('wecom', '当前生效').textContent)).toMatch(/^内置图/);

    // 来源登记 of the published version; the built-in image needs none.
    for (const key of BUILTIN_KEYS)
      expect(clean(cell(key, '来源登记').textContent), key).toBe(BUILTIN_SOURCE);
    const alipay = cell('alipay', '来源登记');
    expectText(alipay, '已登记', ALIPAY_V2.source_url!, '下载日期 2026-10-08', 'SVG', '已清洗');
    const jd = cell('jd', '来源登记');
    expectText(jd, '已登记', JD_V1.source_url!, '下载日期 2026-10-08', 'SVG');
    expect(jd.textContent).not.toContain('已清洗');
    for (const key of ['alipay', 'jd'] as const)
      expect(cell(key, '来源登记').textContent, 'sample marker of the board').not.toContain('样例');

    // 最近变更: updated_at in Beijing time (MM-DD HH:mm) and updated_by; never changed = —.
    expectText(cell('alipay', '最近变更'), '10-09 10:00', 'ops-yi');
    expectText(cell('jd', '最近变更'), '10-08 16:20', 'ops-yi');
    expectText(cell('wecom', '最近变更'), '10-09 09:00', 'ops-yi');
    for (const key of ['taobao', 'tmall', 'pdd', 'wechat', 'wechat_pay'] as const)
      expect(clean(cell(key, '最近变更').textContent), key).toBe('—');

    // 操作: 上传 / 历史 always; 恢复内置 disabled (not hidden) while the built-in image shows.
    for (const key of KEYS) {
      const actions = cell(key, '操作');
      const platform = NAMES[key];
      expect(button(actions, `上传 ${platform}`).disabled, key).toBe(false);
      expect(button(actions, `历史 ${platform}`).disabled, key).toBe(false);
      expect(button(actions, `恢复内置 ${platform}`).disabled, key).toBe(
        BUILTIN_KEYS.includes(key),
      );
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-LIST#3] 浅 / 深底 16·24·32px 预览以 <img> 加载清洗后的 url，有替换图时并排内置图，不读取图片字节',
  async () => {
    const h = mount();
    await listTable();
    for (const key of BUILTIN_KEYS) {
      const preview = cell(key, '预览（16 · 24 · 32px）');
      expect(previewNames(preview).sort(), key).toEqual(lightDark(NAMES[key], '内置图').sort());
      for (const name of lightDark(NAMES[key], '内置图'))
        expectBuiltinPreview(preview, name, [ALIPAY_V2.url, JD_V1.url]);
      expectText(preview, '浅色底', '深色底');
    }
    for (const [key, current] of [
      ['alipay', ALIPAY_V2],
      ['jd', JD_V1],
    ] as const) {
      const preview = cell(key, '预览（16 · 24 · 32px）');
      const platform = NAMES[key];
      expect(previewNames(preview).sort(), key).toEqual(
        [
          ...lightDark(platform, `版本 ${current.version}`),
          ...lightDark(platform, '内置图'),
        ].sort(),
      );
      for (const name of lightDark(platform, `版本 ${current.version}`))
        expectReplacementPreview(preview, name, current.url);
      for (const name of lightDark(platform, '内置图'))
        expectBuiltinPreview(preview, name, [current.url]);
    }
    const main = mainElement();
    expect(main.querySelectorAll('object, iframe, embed, foreignObject')).toHaveLength(0);
    // Every built-in group of the 8 rows (light and dark) shows that platform's built-in file.
    expectAllBuiltinPreviews(main.querySelector('.ant-table')!, KEYS.length * 2);
    expect(h.media).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-LIST#4] 每行显示响应里的版本与地址（换一份数据，显示随之变化）',
  async () => {
    // Same page, other contract-valid values: no row text may be a constant.
    const state = boardState();
    const v7 = version('tmall', 7, {
      format: 'png',
      bytes: 61440,
      sanitized: false,
      source_url: 'https://example.test/brand/tmall-2026',
      downloaded_on: '2026-09-30',
      ever_published: true,
    });
    state.icons.set('tmall', {
      key: 'tmall',
      current_version: 7,
      revision: 11,
      current: v7,
      latest_version: 9,
      updated_by: 'ops-er',
      updated_at: '2026-10-10T16:05:00Z',
    });
    mount(createServer(state));
    await listTable();
    expectText(cell('tmall', '当前生效'), '版本 7', '未发布：版本 9');
    expectText(
      cell('tmall', '来源登记'),
      '已登记',
      'https://example.test/brand/tmall-2026',
      '下载日期 2026-09-30',
      'PNG',
    );
    expect(cell('tmall', '来源登记').textContent).not.toContain('已清洗');
    // 2026-10-10T16:05Z is already 10-11 00:05 in Beijing.
    expectText(cell('tmall', '最近变更'), '10-11 00:05', 'ops-er');
    for (const name of lightDark('天猫', '版本 7'))
      expectReplacementPreview(cell('tmall', '预览（16 · 24 · 32px）'), name, v7.url);
    expect(button(cell('tmall', '操作'), '恢复内置 天猫').disabled).toBe(false);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-LIST#5] 列表请求在途时显示 antd Spin，响应后退出加载并显示数据',
  async () => {
    const server = createServer();
    const gate = server.hold(isList);
    mount(server);
    try {
      await waitFor(() => expect(server.log.filter(isList)).toHaveLength(1));
      await waitFor(() => {
        const main = mainElement();
        expect(main.querySelector('.ant-spin-spinning')).not.toBeNull();
      });
      expect(mainElement().querySelectorAll('tr[data-row-key]')).toHaveLength(0);
      await act(async () => gate.release());
      await listTable();
      await waitFor(() => expect(mainElement().querySelector('.ant-spin-spinning')).toBeNull());
    } finally {
      gate.release();
    }
  },
  FLOW_TIMEOUT,
);

it.each(['network', 'http', 'parse'] as const)(
  '[AC-F1-06zd-LIST#6] %s 失败用 antd 反馈出错，【重试】只再请求一次并恢复数据',
  async (failure) => {
    const server = createServer();
    server.once(isList, () => {
      if (failure === 'network') throw new TypeError('synthetic network failure');
      if (failure === 'http') return jsonResponse({ code: 50000, msg: '服务暂时不可用' }, 503);
      return new Response('{invalid-json', { status: 200 });
    });
    mount(server);
    await waitFor(() => {
      const main = mainElement();
      expect(main.querySelector('.ant-result, .ant-alert-error')).not.toBeNull();
      expect(within(main).queryByRole('button', { name: '重试' })).not.toBeNull();
    });
    const feedback = mainElement().querySelector('.ant-result, .ant-alert-error');
    expect(feedback?.textContent).toMatch(/失败|出错|错误|异常|暂时不可用/);
    expect(mainElement().querySelectorAll('tr[data-row-key]')).toHaveLength(0);
    const before = server.log.length;
    expect(server.log.filter(isList)).toHaveLength(1);
    await act(async () => {
      within(mainElement()).getByRole('button', { name: '重试' }).click();
    });
    await listTable();
    expect(server.log.slice(before)).toEqual([
      { method: 'GET', path: '/admin/v1/platform-icons', query: {}, body: undefined },
    ]);
    expect(mainElement().querySelector('.ant-result, .ant-alert-error')).toBeNull();
    expect(within(mainElement()).queryByRole('button', { name: '重试' })).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-LIST#7] 10403 admin_permission_denied 显示无权限 Result，不显示表格与重试',
  async () => {
    const server = createServer();
    server.once(isList, () => jsonResponse(API_ERRORS[0], 403));
    mount(server);
    await waitFor(() => {
      const result = mainElement().querySelector('.ant-result');
      expect(result).not.toBeNull();
      expect(result?.textContent).toMatch(/无权限|没有.*权限|暂无.*权限|无权/);
    });
    expect(server.log.filter(isList)).toHaveLength(1);
    expect(mainElement().querySelector('.ant-table')).toBeNull();
    expect(within(mainElement()).queryByRole('button', { name: '重试' })).toBeNull();
  },
  FLOW_TIMEOUT,
);
