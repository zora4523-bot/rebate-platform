// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ORDER,
  ORDERS,
  OUT_TRADE_NO,
  REFUND_GRANTS,
  RESOLVE_GRANTS,
  VIEW_GRANTS,
  createServer,
  detailRoute,
  snapshot,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  FORBIDDEN,
  listed,
  main,
  mount,
  rowsOf,
  settle,
  settled,
} from './helpers.ts';

/** The 「功能开发中」 placeholder of a planned operation (apps/admin/src/texts/shell.ts). */
const PLANNED = '功能开发中';

/** Sidebar links named 「支付单」. */
function menuLinks(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('a[href]')).filter(
    (node) => (node.textContent ?? '').trim() === '支付单',
  );
}

it(
  '[AC-F1-13a-ACCESS#1] 持 pay.view：菜单「支付单」可见，进页读支付单列表并列出，不显示无权限提示',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(server);
    await listed(OUT_TRADE_NO.refunded);
    expect(menuLinks(), 'menu 支付单 for pay.view').toHaveLength(1);
    expect(server.orderReads().length).toBeGreaterThan(0);
    expect(main().textContent).not.toMatch(FORBIDDEN);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it.each([
  ['pay.refund', REFUND_GRANTS],
  ['pay.resolve', RESOLVE_GRANTS],
])(
  '[AC-F1-13a-ACCESS#2] 只持 %s（菜单可见、没有 pay.view）：进页不发任何支付单请求，显示无权限提示',
  async (_name, grants) => {
    const server = createServer(undefined, { permissions: grants });
    await mount(server);
    await settle();
    await settled(server);
    expect(menuLinks(), 'menu 支付单 still shown').toHaveLength(1);
    await waitFor(() => expect(main().textContent).toMatch(FORBIDDEN));
    await settled(server);
    expect(server.payRequests()).toEqual([]);
    expect(rowsOf(OUT_TRADE_NO.refunded)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-ACCESS#3] 只持 pay.refund 直达详情地址 pay-orders/{id}：不请求该支付单，显示无权限提示',
  async () => {
    const server = createServer(undefined, { permissions: REFUND_GRANTS });
    await mount(server, { route: detailRoute(ORDER.refunded) });
    await settle();
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(FORBIDDEN));
    await settled(server);
    expect(server.detailReads(ORDER.refunded)).toEqual([]);
    expect(server.payRequests()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-ACCESS#4] 列表返回 10403（本地快照有 pay.view、服务端不认）：显示无权限提示，不显示支付单，不发 GET 以外的请求',
  async () => {
    const server = createServer(undefined, { permissions: REFUND_GRANTS });
    await mount(server, { snapshot: snapshot(VIEW_GRANTS) });
    await waitFor(() => expect(server.requests('GET', ORDERS).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(FORBIDDEN));
    for (const number of Object.values(OUT_TRADE_NO))
      expect(rowsOf(number), `no row ${number}`).toEqual([]);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-ACCESS#5] createAdminShell 不传 planned 清单时照常请求并列出；planned 清单不含本页四个读操作时同样照常，不显示「功能开发中」',
  async () => {
    const plain = createServer();
    await mount(plain);
    await listed(OUT_TRADE_NO.manual);
    expect(plain.orderReads().length).toBeGreaterThan(0);
    expect(main().textContent).not.toContain(PLANNED);
    cleanup();

    const listedPlanned = createServer();
    await mount(listedPlanned, { planned: new Set(['adminGetDashboard']) });
    await listed(OUT_TRADE_NO.manual);
    expect(listedPlanned.orderReads().length).toBeGreaterThan(0);
    expect(main().textContent).not.toContain(PLANNED);
  },
  FLOW_TIMEOUT,
);
