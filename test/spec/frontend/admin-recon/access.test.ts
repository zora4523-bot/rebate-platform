// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ID,
  LIST,
  OTHER_GRANTS,
  RECON_GRANTS,
  REF,
  VIEW_GRANTS,
  createServer,
  snapshot,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  FORBIDDEN,
  RUNS_TAB,
  click,
  main,
  mount,
  openDetail,
  openDiffs,
  rowsOf,
  settle,
  settled,
  tabsNamed,
} from './helpers.ts';

const PLANNED = '功能开发中';
/** Sidebar links named 「对账与差错」. */
function menuLinks(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('a[href]')).filter(
    (node) => (node.textContent ?? '').trim() === '对账与差错',
  );
}

it(
  '[AC-F1-08e-ACCESS#1] 只持 fund.view 可看差错单列表；fund.recon 与 fund.view 都没有：菜单不出现、不请求 recon-diffs、不显示差错单',
  async () => {
    const viewer = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(viewer);
    await openDiffs(viewer, REF.ledger);
    expect(menuLinks(), 'menu 对账与差错 for fund.view').toHaveLength(1);
    expect(viewer.reads().length).toBeGreaterThan(0);
    cleanup();

    const other = createServer(undefined, { permissions: OTHER_GRANTS });
    await mount(other);
    await settle();
    await settled(other);
    expect(menuLinks(), 'no menu 对账与差错').toEqual([]);
    expect(other.diffRequests()).toEqual([]);
    expect(rowsOf(main(), [REF.ledger])).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-ACCESS#2] 列表返回 10403（菜单因 fund.view 可见、服务端不认）：显示无权限提示，不显示差错单',
  async () => {
    const server = createServer(undefined, { permissions: OTHER_GRANTS });
    await mount(server, { snapshot: snapshot(VIEW_GRANTS) });
    await openDiffs(server);
    await waitFor(() => expect(server.requests('GET', LIST).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(FORBIDDEN));
    expect(rowsOf(main(), [REF.ledger])).toEqual([]);
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-ACCESS#3] planned 清单不含这三个操作：照常请求并列出差错单，不显示「功能开发中」',
  async () => {
    const server = createServer();
    await mount(server, { planned: new Set(['adminGetDashboard']) });
    await openDiffs(server, REF.ledger);
    expect(server.reads().length).toBeGreaterThan(0);
    expect(main().textContent).not.toContain(PLANNED);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-ACCESS#4] 只请求三个已有契约的操作：列表、详情之外不发任何对账请求（对账任务、手动触发、月末三项、导出、恢复、调账、核销、重算都不请求）',
  async () => {
    const server = createServer(undefined, { permissions: RECON_GRANTS });
    await mount(server);
    await openDetail(server, REF.channel, ID.channel);
    const runs = tabsNamed(RUNS_TAB)[0];
    if (runs !== undefined) {
      await click(runs);
      await settle();
    }
    await settled(server);
    const allowed = /^\/admin\/v1\/recon-diffs(?:\/[^/]+)?$/;
    expect(server.log.filter((request) => !allowed.test(request.path))).toEqual([]);
    expect(server.log.filter((request) => request.method !== 'GET')).toEqual([]);
  },
  FLOW_TIMEOUT,
);
