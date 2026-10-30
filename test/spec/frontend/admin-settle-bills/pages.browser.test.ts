/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import { BASE_URL, BATCH, BILL, ORDER, createServer, namePattern, snapshot } from './fixtures.ts';

// The real /settle-bills route of the admin app in Chromium: the bill list, 【查看】 of the
// settling bill with its batch table (names read from the console dictionary when the test runs,
// the code without a row), and 【明细】 of the PARTIAL batch with its items; only the three GETs
// of CT-24z go out. Waits use expect.element only.
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
  window.history.replaceState(null, '', '/settle-bills');
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'browser',
      authProvider: auth,
      permissionsProvider: async () => snapshot(server.permissions),
      account: { username: 'fin-yi', displayName: '财务' },
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

it('[AC-F1-08d-BROWSER#1] /settle-bills：列出账单，【查看】2026-07 显示 PARTIAL / CONFIRMED 批次状态与 SCHEDULED 结算方式的字典名，【明细】列出该批次的子订单与入账金额 720.12；只发三个 GET', async () => {
  await page.viewport(1440, 1080);
  const server = await show();
  const bill = page
    .getByRole('main')
    .getByRole('row')
    .filter({ hasText: /(?<![\d-])2026-07(?!-?\d)/ });
  await expect.element(bill, FIRST).toBeVisible();
  await expect.element(bill).toMatchTextContent(namePattern('billStatus', 'settling'));
  await bill
    .getByText(/^(?:查\s*看|详\s*情)$/)
    .first()
    .click();

  const partial = page.getByRole('row').filter({ hasText: BATCH.partial.slice(0, 8) });
  const scheduled = page.getByRole('row').filter({ hasText: BATCH.scheduled.slice(0, 8) });
  await expect.element(partial, FIRST).toBeVisible();
  await expect.element(partial).toMatchTextContent(namePattern('batchStatus', 'PARTIAL'));
  await expect.element(scheduled).toMatchTextContent(namePattern('batchStatus', 'CONFIRMED'));
  await expect.element(scheduled).toMatchTextContent(namePattern('settleMode', 'SCHEDULED'));
  expect(server.billReads(BILL.settling).length).toBeGreaterThan(0);

  await partial
    .getByText(/^(?:明\s*细|查看明细|批次明细)$/)
    .first()
    .click();
  const item = page.getByRole('row').filter({ hasText: ORDER.credited.slice(0, 8) });
  await expect.element(item, FIRST).toBeVisible();
  await expect.element(item).toMatchTextContent(/720\.12/);
  expect(server.itemReads(BATCH.partial).length).toBeGreaterThan(0);
  expect(server.others()).toEqual([]);
});
