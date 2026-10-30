// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  DAY,
  ENTRY_GRANTS,
  LEDGER_GRANTS,
  LIST,
  VIEW_GRANTS,
  createServer,
  snapshot,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  FORBIDDEN,
  dayRows,
  listed,
  main,
  mount,
  settle,
  settled,
} from './helpers.ts';

/** Sidebar links named 「平台资金台账」. */
function menuLinks(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('a[href]')).filter(
    (node) => (node.textContent ?? '').trim() === '平台资金台账',
  );
}

it(
  '[AC-F1-08ga-ACCESS#1] 只持 fund.view：菜单不出现（菜单仍只认 fund.cash_entry），直达 /fund-ledger 照常读取并列出按日台账；同持 fund.cash_entry 时菜单出现、同样列出',
  async () => {
    const viewer = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(viewer);
    await listed(DAY.latest);
    expect(menuLinks(), 'no menu 平台资金台账 for fund.view only').toEqual([]);
    expect(viewer.reads().length).toBeGreaterThan(0);
    expect(main().textContent).not.toMatch(FORBIDDEN);
    cleanup();

    const ledger = createServer(undefined, { permissions: LEDGER_GRANTS });
    await mount(ledger);
    await listed(DAY.latest);
    expect(menuLinks(), 'menu 平台资金台账 with fund.cash_entry').toHaveLength(1);
    expect(ledger.reads().length).toBeGreaterThan(0);
    expect(main().textContent).not.toMatch(FORBIDDEN);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ga-ACCESS#2] 只持 fund.cash_entry（菜单可见、没有 fund.view）：进页不请求资产快照，显示无权限提示',
  async () => {
    const server = createServer(undefined, { permissions: ENTRY_GRANTS });
    await mount(server);
    await settle();
    await settled(server);
    expect(menuLinks(), 'menu 平台资金台账 still shown').toHaveLength(1);
    await waitFor(() => expect(main().textContent).toMatch(FORBIDDEN));
    await settled(server);
    expect(server.snapshotRequests()).toEqual([]);
    expect(dayRows(DAY.latest)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ga-ACCESS#3] 列表返回 10403（本地快照有 fund.view、服务端不认）：显示无权限提示，不显示任何快照行',
  async () => {
    const server = createServer(undefined, { permissions: ENTRY_GRANTS });
    await mount(server, { snapshot: snapshot(LEDGER_GRANTS) });
    await waitFor(() => expect(server.requests('GET', LIST).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(FORBIDDEN));
    for (const day of [DAY.latest, DAY.late, DAY.older, DAY.bare])
      expect(dayRows(day), day).toEqual([]);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);
