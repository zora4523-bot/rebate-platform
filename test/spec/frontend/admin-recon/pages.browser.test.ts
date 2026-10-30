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
  ID,
  REF,
  STATUS_NAME,
  TYPE_NAME,
  VERIFY,
  createServer,
  detailPath,
  snapshot,
} from './fixtures.ts';

// The real /recon route of the admin app in Chromium: the 差错单 list with dictionary names, a
// row's drawer, and 【已关闭（不处理）】 with a reason (no step-up), ending with the released
// holds in the notice and the row's new status. Waits use expect.element only.
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
  window.history.replaceState(null, '', '/recon');
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

it('[AC-F1-08e-BROWSER#1] /recon 差错单：列出字典中文名，打开处理中的差错单抽屉，【已关闭（不处理）】填原因提交（不弹动态码），提示已解除 2 笔冻结，该行变为「已关闭（不处理）」', async () => {
  await page.viewport(1440, 1080);
  const server = await show();
  const tab = page.getByRole('main').getByRole('tab', { name: /^差错单/ });
  const area = page.getByRole('main');
  const row = area.getByRole('row').filter({ hasText: REF.channel });
  // With tabs, the 差错单 tab is chosen first; without tabs the list is the page itself.
  await expect.poll(() => tab.elements().length + row.elements().length, FIRST).toBeGreaterThan(0);
  if (tab.elements().length > 0) await tab.first().click();
  await expect.element(row, FIRST).toBeVisible();
  await expect.element(row).toMatchTextContent(TYPE_NAME.channel_mismatch);
  await expect.element(row).toMatchTextContent(STATUS_NAME.processing);
  await expect
    .element(area.getByRole('row').filter({ hasText: REF.ledger }))
    .toMatchTextContent(TYPE_NAME.ledger_mismatch);

  await row
    .getByRole('button', { name: /^(?:详\s*情|处\s*理|查\s*看)$/ })
    .first()
    .click();
  const entry = page.getByRole('button', { name: /^已关闭[（(]不处理[)）]$/ }).first();
  await expect.element(entry, FIRST).toBeVisible();
  expect(server.requests('GET', detailPath(ID.channel)).length).toBeGreaterThan(0);
  await entry.click();

  const reason = page.getByLabelText(/原因/);
  await expect.element(reason, FIRST).toBeVisible();
  await reason.fill('通道已退回，无需处理');
  expect(server.closes()).toEqual([]);
  await page
    .getByRole('button', { name: /^(?:确\s*认|确\s*定|提\s*交|已关闭[（(]不处理[)）])/ })
    .last()
    .click();

  await expect
    .element(page.getByText(/(?<!\d)2(?!\d)\D{0,12}冻结|冻结\D{0,12}(?<!\d)2(?!\d)/).first(), FIRST)
    .toBeVisible();
  await expect.element(row, FIRST).toMatchTextContent(STATUS_NAME.closed);
  const sent = server.closes(ID.channel);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toEqual({ reason: '通道已退回，无需处理' });
  expect((sent[0]!.headers.get('Idempotency-Key') ?? '').trim()).not.toBe('');
  expect(sent[0]!.headers.has('X-Step-Up-Token')).toBe(false);
  expect(server.requests('POST', VERIFY)).toEqual([]);
});
