/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import {
  BASE_URL,
  CHANNEL_USER,
  ORDER,
  OUT_REFUND_NO,
  OUT_TRADE_NO,
  PERIOD,
  createServer,
  namePattern,
  snapshot,
} from './fixtures.ts';

// The real /pay-orders route of the admin app in Chromium: the pay order list with the
// dictionary names of status and channel (read when the test runs, the code without a row),
// 【详情】 of the partly refunded order at /pay-orders/{pay_order_id} with its refunds, and the
// 收款对账 tab with an R4 difference that keeps its minus sign; only the four GETs of CT-21e go
// out. Waits use expect.element and expect.poll only.
const FIRST = { timeout: 10_000 };
let root: Root | undefined;
let auth: AdminAuthProvider | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  auth?.dispose();
  auth = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

async function show(server = createServer()) {
  auth = harness().create();
  await signIn(auth);
  window.history.replaceState(null, '', '/pay-orders');
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'browser',
      authProvider: auth,
      permissionsProvider: async () => snapshot(server.permissions),
      account: { username: 'fin-pay', displayName: '财务' },
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

it('[AC-F1-13a-BROWSER#1] /pay-orders：列出支付单（状态与渠道的字典名），【详情】进 /pay-orders/{id}，显示退款记录 30.50 与 20.00；不显示渠道侧用户标识，只发四个 GET', async () => {
  await page.viewport(1440, 1080);
  const server = await show();
  const row = page.getByRole('main').getByRole('row').filter({ hasText: OUT_TRADE_NO.refunded });
  await expect.element(row, FIRST).toBeVisible();
  await expect.element(row).toMatchTextContent(namePattern('payStatus', 'PAID'));
  await expect.element(row).toMatchTextContent(namePattern('channel', 'alipay'));
  await expect.element(row).toMatchTextContent(/128\.00/);
  await row
    .getByText(/^(?:详\s*情|查\s*看|查看详情)$/)
    .first()
    .click();

  await expect.poll(() => window.location.pathname, FIRST).toBe(`/pay-orders/${ORDER.refunded}`);
  const success = page.getByRole('row').filter({ hasText: OUT_REFUND_NO.success });
  const failed = page.getByRole('row').filter({ hasText: OUT_REFUND_NO.failed });
  await expect.element(success, FIRST).toBeVisible();
  await expect.element(success).toMatchTextContent(/30\.50/);
  await expect.element(success).toMatchTextContent(namePattern('refundStatus', 'SUCCESS'));
  await expect.element(failed).toMatchTextContent(/20\.00/);
  expect(server.detailReads(ORDER.refunded).length).toBeGreaterThan(0);
  for (const value of Object.values(CHANNEL_USER))
    expect(document.body.textContent ?? '').not.toContain(value);
  expect(server.others()).toEqual([]);
});

it('[AC-F1-13a-BROWSER#2] /pay-orders 的「收款对账」页签：列出 R4 差错单，收款异常一行显示类型字典名与差额 -45.60；只发四个 GET', async () => {
  await page.viewport(1440, 1080);
  const server = await show();
  await expect
    .element(
      page.getByRole('main').getByRole('row').filter({ hasText: OUT_TRADE_NO.manual }),
      FIRST,
    )
    .toBeVisible();
  await page
    .getByRole('main')
    .getByText(/^\s*收款对账\s*(?:\d+|[（(]\d+[)）])?\s*$/)
    .first()
    .click();
  const diff = page
    .getByRole('main')
    .getByRole('row')
    .filter({ hasText: new RegExp(`(?<![\\d-])${PERIOD.anomaly}(?![\\d-])`) });
  await expect.element(diff, FIRST).toBeVisible();
  await expect.element(diff).toMatchTextContent(namePattern('diffType', 'pay_anomaly'));
  await expect.element(diff).toMatchTextContent(/[-−]\s*[¥￥]?\s*45\.60/);
  expect(server.diffReads().length).toBeGreaterThan(0);
  expect(server.others()).toEqual([]);
});
