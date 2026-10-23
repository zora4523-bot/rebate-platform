// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  ACCOUNTS,
  ACTIVE_ID,
  JD_ACCOUNT,
  JD_NAME,
  PID,
  PIDS,
  SITE,
  TAOBAO_ACCOUNT,
  TAOBAO_NAME,
  VERIFY,
  createServer,
  failure,
  pids,
  retireUrl,
} from './fixtures.ts';
import {
  ACCOUNTS_ONLY,
  FLOW_TIMEOUT,
  FORBIDDEN,
  LABEL,
  action,
  actions,
  choose,
  click,
  hasRow,
  main,
  mount,
  openPids,
  openPidsRead,
  openRetire,
  panel,
  pidsTab,
  row,
  settle,
  showPids,
  stepUp,
  stepUpOpen,
  verify,
} from './helpers.ts';

vi.mock('../../../../contracts/texts.admin.default.json', async (importOriginal) => {
  const actual = await importOriginal<{ default: { texts: Record<string, string> } }>();
  const texts: Record<string, string> = {
    ...actual.default.texts,
    'admin_dict.union_pids.status.active': '测试字典：推广位启用中',
    // BR-TEXT-25 has no row for pid_scene yet; admin_dict.<enum>.<code> allows the enum name or
    // the table.column name, so both spellings carry the injected value.
    'admin_dict.pid_scene.share': '测试字典：分享场景',
    'admin_dict.union_pids.pid_scene.share': '测试字典：分享场景',
  };
  // A missing entry: the page shows the code.
  delete texts['admin_dict.union_pids.status.retired'];
  return { ...actual, texts, default: { ...actual.default, texts } };
});

const dictionaries = import.meta.glob<{ texts: Record<string, string> }>(
  '../../../../contracts/texts.admin.default.json',
  { eager: true, import: 'default' },
);
const dictionary = Object.values(dictionaries)[0]?.texts ?? {};
const EMPTY = /暂无|没有.*推广位|无数据/;

it(
  '[AC-F1-10gb-LIST#1] 推广位列表：平台、所属联盟账号、淘宝 site_id、PID、场景、状态与花卷云忽略确认时间；只读，不要动态码',
  async () => {
    const { server, directFetch } = await mount();
    await openPids();
    for (const item of pids()) {
      const text = row(item.pid).textContent ?? '';
      expect(text).toMatch(item.platform === 'taobao' ? /taobao|淘宝/i : /jd|京东/i);
      expect(text).toMatch(
        item.platform === 'taobao'
          ? new RegExp(`${TAOBAO_NAME}|${TAOBAO_ACCOUNT}`)
          : new RegExp(`${JD_NAME}|${JD_ACCOUNT}`),
      );
      // site_id only on taobao rows.
      if (item.site_id === null) expect(text).not.toContain(SITE);
      else expect(text).toContain(item.site_id);
    }
    // Scene and status names come only from the admin dictionary; a missing entry shows the code.
    expect(row(PID.pendingJd).textContent).toContain('测试字典：分享场景');
    expect(row(PID.retired).textContent).toContain('测试字典：分享场景');
    expect(row(PID.active).textContent).toContain('self_buy');
    expect(row(PID.pendingTaobao).textContent).toContain('self_buy');
    expect(row(PID.active).textContent).toContain('测试字典：推广位启用中');
    expect(row(PID.retired).textContent).toContain('retired');
    const pending = dictionary['admin_dict.union_pids.status.pending'] ?? 'pending';
    expect(row(PID.pendingJd).textContent).toContain(pending);
    expect(row(PID.pendingTaobao).textContent).toContain(pending);
    // 花卷云 ignore confirmation time where there is one (北京时间).
    expect(row(PID.active).textContent).toMatch(/2026[-/]0?9[-/]28/);
    expect(row(PID.active).textContent).toContain('15:00');
    expect(row(PID.retired).textContent).toMatch(/2026[-/]0?8[-/]0?1/);
    expect(row(PID.retired).textContent).toContain('10:00');
    // One read of the whole list: no paging, no filter parameters, no step-up.
    expect(server.requests('GET', PIDS)).toHaveLength(1);
    expect(server.requests('GET', PIDS)[0]!.query).toEqual({});
    expect(server.requests('GET', PIDS)[0]!.headers.has('X-Step-Up-Token')).toBe(false);
    expect(server.pidRequests().filter((r) => r.method !== 'GET')).toEqual([]);
    expect(server.requests('POST', VERIFY)).toEqual([]);
    expect(stepUpOpen()).toBe(false);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-LIST#2] 入口按状态：待确认有修改与启用，启用中只有停用，已停用没有操作，任何行都没有删除',
  async () => {
    await mount();
    await openPids();
    for (const pid of [PID.pendingJd, PID.pendingTaobao]) {
      expect(actions(row(pid), /^修改/)).toHaveLength(1);
      expect(actions(row(pid), /^启用/)).toHaveLength(1);
      expect(actions(row(pid), /停用|删除|移除/)).toEqual([]);
    }
    expect(actions(row(PID.active), /^停用/)).toHaveLength(1);
    expect(actions(row(PID.active), /修改|编辑|启用|删除|移除/)).toEqual([]);
    expect(actions(row(PID.retired), /修改|编辑|启用|停用|恢复|删除|移除/)).toEqual([]);
    expect(actions(panel(), /删除|移除/)).toEqual([]);
    expect(actions(panel(), /^(?:登记|新增|添加)/)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-LIST#3] 加载中与空列表分开，空列表不补造推广位',
  async () => {
    const server = createServer([]);
    const release = server.hold('GET', PIDS);
    try {
      await mount(server);
      await openPidsRead(server);
      expect(panel().textContent).toMatch(/加载/);
      expect(panel().textContent).not.toMatch(EMPTY);
    } finally {
      release();
    }
    await waitFor(() => expect(panel().textContent).toMatch(EMPTY));
    expect(panel().textContent).not.toMatch(/加载中/);
    expect(actions(panel(), /修改|启用|停用/)).toEqual([]);
    expect(actions(panel(), /^(?:登记|新增|添加)/)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-LIST#4] 读取失败可重试；再查失败仍显示出错，成功后显示列表',
  async () => {
    const server = createServer();
    server.once('GET', PIDS, () => Promise.reject(new Error('offline')));
    server.once('GET', PIDS, () => failure(50000));
    await mount(server);
    await showPids();
    await waitFor(() => expect(panel().textContent).toMatch(/失败|网络|出错/));
    expect(hasRow(PID.active)).toBe(false);
    await click(action(panel(), /重试|重新加载|重新读取/));
    await waitFor(() => expect(server.requests('GET', PIDS)).toHaveLength(2));
    await settle();
    await waitFor(() => expect(panel().textContent).toMatch(/失败|出错/));
    expect(hasRow(PID.active)).toBe(false);
    await click(action(panel(), /重试|重新加载|重新读取/));
    await waitFor(() => expect(hasRow(PID.active)).toBe(true));
    expect(server.requests('GET', PIDS)).toHaveLength(3);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-LIST#5] 写入后的刷新读取失败时显示出错，不再显示旧列表',
  async () => {
    const server = createServer();
    server.once('POST', retireUrl(ACTIVE_ID), () => failure(20902, { resource: 'union_pid' }));
    await mount(server);
    const form = await openRetire(PID.active);
    // The list has loaded; the refresh after the 20902 is the read that fails.
    server.once('GET', PIDS, () => failure(50000));
    await verify(await stepUp(form));
    await waitFor(() => expect(server.requests('POST', retireUrl(ACTIVE_ID))).toHaveLength(1));
    await waitFor(() => expect(server.requests('GET', PIDS)).toHaveLength(2));
    await waitFor(() => expect(panel().textContent).toMatch(/失败|出错/));
    expect(hasRow(PID.active)).toBe(false);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-LIST#6] 读取 10403 显示无权限，不误报空列表、不要求动态码',
  async () => {
    const server = createServer();
    server.once('GET', PIDS, () => failure(10403, { reason: 'admin_permission_denied' }));
    await mount(server);
    await showPids();
    await waitFor(() => expect(panel().textContent).toMatch(FORBIDDEN));
    expect(panel().textContent).not.toMatch(EMPTY);
    expect(hasRow(PID.active)).toBe(false);
    expect(stepUpOpen()).toBe(false);
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-LIST#7] 持 union.account_auth 而无 union.pid：推广位页签不出现或显示无权限，不发任何 union-pids 请求',
  async () => {
    const { server } = await mount(createServer(), { snapshot: ACCOUNTS_ONLY });
    await waitFor(() => expect(main().textContent).toContain(TAOBAO_NAME));
    const tab = pidsTab();
    if (tab !== null) {
      await click(tab);
      await waitFor(() => expect(panel().textContent).toMatch(FORBIDDEN));
    }
    await settle();
    expect(server.pidRequests()).toEqual([]);
    expect(server.requests('GET', ACCOUNTS)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-LIST#8] 只持 union.pid 时推广位列表照常读取',
  async () => {
    const { server } = await mount(createServer(), {
      snapshot: {
        isSuper: false,
        permissions: ['union.pid'],
        stepUp: { 'union.pid': { tier: 'totp', operations: {} } },
      },
    });
    await openPids();
    expect(row(PID.pendingJd).textContent).toContain(PID.pendingJd);
    expect(server.requests('GET', PIDS)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-LIST#9] 按平台筛选只显示该平台的推广位，筛选不重新请求带参数的列表',
  async () => {
    const { server } = await mount();
    await openPids();
    await choose(panel(), LABEL.platform, /^(?:京东|jd)$/i);
    await waitFor(() => expect(hasRow(PID.active)).toBe(false));
    expect(hasRow(PID.pendingJd)).toBe(true);
    expect(hasRow(PID.retired)).toBe(false);
    expect(hasRow(PID.pendingTaobao)).toBe(false);
    for (const request of server.requests('GET', PIDS)) expect(request.query).toEqual({});
  },
  FLOW_TIMEOUT,
);
