// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJUST_GRANTS,
  BILL,
  LIST,
  SETTLE_GRANTS,
  UPLOAD_GRANTS,
  VIEW_GRANTS,
  createServer,
  snapshot,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  FORBIDDEN,
  PLANNED,
  billRows,
  listed,
  main,
  mount,
  settle,
  settled,
} from './helpers.ts';

/** Sidebar links named 「月结账单」. */
function menuLinks(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('a[href]')).filter(
    (node) => (node.textContent ?? '').trim() === '月结账单',
  );
}

it(
  '[AC-F1-08d-ACCESS#1] 持 settle.bill 或 fund.view 任一可看账单列表；只持 fund.view 时菜单仍不出现（菜单不改），直达本页照常列出',
  async () => {
    const settler = createServer(undefined, { permissions: SETTLE_GRANTS });
    await mount(settler);
    await listed(BILL.issued);
    expect(menuLinks(), 'menu 月结账单 for settle.bill').toHaveLength(1);
    expect(settler.reads().length).toBeGreaterThan(0);
    cleanup();

    const viewer = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(viewer);
    await listed(BILL.issued);
    expect(menuLinks(), 'no menu 月结账单 for fund.view only').toEqual([]);
    expect(viewer.reads().length).toBeGreaterThan(0);
    expect(main().textContent).not.toMatch(FORBIDDEN);
  },
  FLOW_TIMEOUT,
);

it.each([
  ['settle.statement_upload', UPLOAD_GRANTS],
  ['fund.settle_adjust', ADJUST_GRANTS],
])(
  '[AC-F1-08d-ACCESS#2] 只持 %s（菜单可见、没有 settle.bill 与 fund.view）：进页不请求账单，显示无权限提示',
  async (_name, grants) => {
    const server = createServer(undefined, { permissions: grants });
    await mount(server);
    await settle();
    await settled(server);
    expect(menuLinks(), 'menu 月结账单 still shown').toHaveLength(1);
    await waitFor(() => expect(main().textContent).toMatch(FORBIDDEN));
    await settled(server);
    expect(server.settleRequests()).toEqual([]);
    expect(billRows(BILL.issued)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-ACCESS#3] 列表返回 10403（本地快照有 settle.bill、服务端不认）：显示无权限提示，不显示账单',
  async () => {
    const server = createServer(undefined, { permissions: UPLOAD_GRANTS });
    await mount(server, { snapshot: snapshot(SETTLE_GRANTS) });
    await waitFor(() => expect(server.requests('GET', LIST).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(FORBIDDEN));
    expect(billRows(BILL.issued)).toEqual([]);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-ACCESS#4] planned 清单含 listAdminSettleBills：整页「功能开发中」，不发任何请求；清单不含时照常请求并列出、不显示「功能开发中」',
  async () => {
    const blocked = createServer();
    await mount(blocked, { planned: new Set(['listAdminSettleBills', 'adminGetDashboard']) });
    await waitFor(() => expect(main().textContent).toContain(PLANNED));
    await settled(blocked);
    expect(main().textContent).toContain('月结账单');
    expect(blocked.log).toEqual([]);
    expect(billRows(BILL.issued)).toEqual([]);
    cleanup();

    const open = createServer();
    await mount(open, { planned: new Set(['adminGetDashboard']) });
    await listed(BILL.issued);
    expect(open.reads().length).toBeGreaterThan(0);
    expect(main().textContent).not.toContain(PLANNED);
  },
  FLOW_TIMEOUT,
);
