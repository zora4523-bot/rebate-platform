// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  LIST,
  NO,
  OTHER_GRANTS,
  REVIEW_GRANTS,
  VIEW_GRANTS,
  createServer,
  snapshot,
  type Grants,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  FORBIDDEN,
  main,
  mount,
  openList,
  rowsOf,
  settle,
  settled,
} from './helpers.ts';

const PLANNED = '功能开发中';
/** Sidebar links named 「提现审核」. */
function menuLinks(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('a[href]')).filter(
    (node) => (node.textContent ?? '').trim() === '提现审核',
  );
}

it(
  '[AC-F1-08a-ACCESS#1] 持 withdraw.review：菜单可见并列出提现单；只持 fund.view：菜单仍不出现（菜单不改），直达本页照常读列表并列出',
  async () => {
    const reviewer = createServer(undefined, { permissions: REVIEW_GRANTS });
    await mount(reviewer);
    await openList(reviewer, NO.pending);
    expect(menuLinks(), 'menu 提现审核 for withdraw.review').toHaveLength(1);
    expect(reviewer.reads().length).toBeGreaterThan(0);
    cleanup();

    const viewer = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(viewer);
    await openList(viewer, NO.pending);
    expect(menuLinks(), 'no menu 提现审核 for fund.view alone').toEqual([]);
    expect(viewer.reads().length).toBeGreaterThan(0);
    expect(rowsOf(main(), [NO.rejected])).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-ACCESS#2] 只持 payout.execute 或 payout.manual_entry（无 withdraw.review、fund.view）：菜单可见，进页不请求提现单，显示无权限提示',
  async () => {
    const onlyPayout: readonly Grants[] = [['payout.execute'], ['payout.manual_entry']];
    for (const grants of onlyPayout) {
      const server = createServer(undefined, { permissions: grants });
      await mount(server);
      await settle();
      await settled(server);
      expect(menuLinks(), `menu 提现审核 for ${grants.join(',')}`).toHaveLength(1);
      await waitFor(() => expect(main().textContent).toMatch(FORBIDDEN));
      await settled(server);
      expect(server.withdrawalRequests(), `no withdrawal request for ${grants.join(',')}`).toEqual(
        [],
      );
      expect(rowsOf(main(), [NO.pending])).toEqual([]);
      cleanup();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-ACCESS#3] 直达 /withdrawals：持 fund.view（另有 user.lookup）照常列出；withdraw.review 与 fund.view 都没有（只 user.lookup）时不请求提现单，显示无权限提示或沿用外壳原有跳转（离开提现审核）二者之一',
  async () => {
    const viewer = createServer(undefined, { permissions: [...VIEW_GRANTS, ...OTHER_GRANTS] });
    await mount(viewer);
    await openList(viewer, NO.pending);
    expect(viewer.reads().length).toBeGreaterThan(0);
    cleanup();

    const server = createServer(undefined, { permissions: OTHER_GRANTS });
    await mount(server);
    await settle();
    await settled(server);
    expect(menuLinks(), 'no menu 提现审核').toEqual([]);
    // Either the page's own no-permission notice, or the shell's usual redirect away from
    // 提现审核 (its crumb is gone and no list is shown).
    const banner = (): string => document.querySelector('[role="banner"]')?.textContent ?? '';
    await waitFor(() =>
      expect(
        FORBIDDEN.test(main().textContent ?? '') || !banner().includes('提现审核'),
        'a no-permission notice or the redirect away from 提现审核',
      ).toBe(true),
    );
    await settled(server);
    expect(server.withdrawalRequests()).toEqual([]);
    expect(rowsOf(main(), [NO.pending])).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-ACCESS#4] 列表返回 10403（快照有 withdraw.review、服务端不认）：显示无权限提示，不显示提现单，不发 GET 以外的请求',
  async () => {
    const server = createServer(undefined, { permissions: OTHER_GRANTS });
    await mount(server, { snapshot: snapshot(REVIEW_GRANTS) });
    await openList(server);
    await waitFor(() => expect(server.requests('GET', LIST).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(FORBIDDEN));
    expect(rowsOf(main(), [NO.pending])).toEqual([]);
    expect(server.writes()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-ACCESS#5] planned 清单不含 listAdminWithdrawals / getAdminWithdrawal：照常请求并列出提现单，不显示「功能开发中」',
  async () => {
    const server = createServer();
    await mount(server, { planned: new Set(['adminGetDashboard']) });
    await openList(server, NO.pending);
    expect(server.reads().length).toBeGreaterThan(0);
    expect(main().textContent).not.toContain(PLANNED);
  },
  FLOW_TIMEOUT,
);
