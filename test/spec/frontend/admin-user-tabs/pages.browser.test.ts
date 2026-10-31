/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import {
  BASE_URL,
  INVITE,
  ORDERS,
  SUPER,
  UID,
  WITHDRAWALS,
  createServer,
  uidOrders,
  uidWithdrawals,
  yuan,
  type Server,
} from './fixtures.ts';

const FIRST = { timeout: 10_000 };
let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

/** The real admin app on /users over the fake server (memory router, super admin). */
function show(): Server {
  const server = createServer(SUPER);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'memory',
      initialRoute: { menuId: 'users' },
      permissionsProvider: async () => SUPER,
      account: { username: 'ops-yi', displayName: '超管' },
      environment: 'test',
      onLogout: () => {},
      dataProvider: createDataProvider({
        baseUrl: BASE_URL,
        fetch: server.fetch,
        getToken: () => 'example-admin-token',
        onError: () => {},
      }),
    }),
  );
  return server;
}

it('[AC-F1-07jb-BROWSER#1] 1440 用户详情：页签行「概览 / 订单 / 找回 / 提现」可见，切到订单、提现页签显示该用户的行与后台格式金额', async () => {
  await page.viewport(1440, 1100);
  const server = show();
  const main = page.getByRole('main');
  const open = main.getByRole('button', { name: `详情 ${UID}`, exact: true });
  await expect.element(open, FIRST).toBeVisible();
  await open.click();
  await expect.element(main.getByText(INVITE[UID]!, { exact: true }).first(), FIRST).toBeVisible();
  for (const name of ['概览', '订单', '找回', '提现'])
    await expect.element(main.getByRole('tab', { name, exact: true })).toBeVisible();

  await main.getByRole('tab', { name: '订单', exact: true }).click();
  const order = uidOrders()[0]!;
  await expect
    .element(main.getByText(order.sub_order_id, { exact: true }).first(), FIRST)
    .toBeVisible();
  await expect.element(main.getByText(yuan(order.pay_amount_fen!)).first()).toBeVisible();

  await main.getByRole('tab', { name: '提现', exact: true }).click();
  const withdrawal = uidWithdrawals()[0]!;
  await expect
    .element(main.getByText(withdrawal.out_biz_no, { exact: true }).first(), FIRST)
    .toBeVisible();
  await expect.element(main.getByText(yuan(withdrawal.amount_fen)).first()).toBeVisible();

  for (const path of [ORDERS, WITHDRAWALS]) {
    const reads = server.requests('GET', path);
    expect(reads.length, path).toBeGreaterThan(0);
    for (const read of reads) expect(read.query['user_id']).toBe(UID);
  }
  expect(server.log.filter((request) => request.method !== 'GET')).toEqual([]);
});
