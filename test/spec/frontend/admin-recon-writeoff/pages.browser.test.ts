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
  BEARER,
  ID,
  REF,
  STATUS_NAME,
  TOTP_CODE,
  created,
  createServer,
  detailPath,
  snapshot,
  stepUpValue,
} from './fixtures.ts';

// The real /recon route of the admin app in Chromium: a processing R2 difference's drawer,
// 【核销】 with a note, the totp step-up, then the released holds in the notice and the row's new
// status. Waits use expect.element / expect.poll only.
const FIRST = { timeout: 10_000 };
const NOTE_TEXT = '支付宝账单显示该笔已到账，按账单行核销';
let root: Root | undefined;
let auth: AdminAuthProvider | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  auth?.dispose();
  auth = undefined;
  created.splice(0);
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
        getToken: () => BEARER,
        onError: () => {},
      }),
    }),
  );
  return server;
}

it('[AC-F1-08eb-BROWSER#1] /recon 处理中的 R2 差错单：抽屉【核销】→ 确认对话框填备注 → 动态码验证后 POST write-off（Idempotency-Key + X-Step-Up-Token + {expected_withdrawal_status: APPROVED, note}），提示解除 2 笔冻结，该行变为「已核销」', async () => {
  await page.viewport(1440, 1080);
  const server = await show();
  const tab = page.getByRole('main').getByRole('tab', { name: /^差错单/ });
  const area = page.getByRole('main');
  const row = area.getByRole('row').filter({ hasText: REF.busy });
  // With tabs, the 差错单 tab is chosen first; without tabs the list is the page itself.
  await expect.poll(() => tab.elements().length + row.elements().length, FIRST).toBeGreaterThan(0);
  if (tab.elements().length > 0) await tab.first().click();
  await expect.element(row, FIRST).toBeVisible();
  await expect.element(row).toMatchTextContent(STATUS_NAME.processing);

  await row
    .getByRole('button', { name: /^(?:详\s*情|处\s*理|查\s*看)$/ })
    .first()
    .click();
  const entry = page.getByRole('button', { name: /^核\s*销/ }).first();
  await expect.element(entry, FIRST).toBeVisible();
  expect(server.requests('GET', detailPath(ID.busy)).length).toBeGreaterThan(0);
  await entry.click();

  const note = page.getByLabelText(/备注/);
  await expect.element(note, FIRST).toBeVisible();
  await note.fill(NOTE_TEXT);
  await page
    .getByRole('dialog')
    .filter({ has: page.getByLabelText(/备注/) })
    .getByRole('button', { name: /^(?:确\s*认|确\s*定|提\s*交|核\s*销)/ })
    .first()
    .click();

  const verification = page.getByRole('dialog', { name: /二次验证|动态码/ });
  await expect.element(verification, FIRST).toBeVisible();
  expect(server.writeOffs(), 'no write-off before the step-up').toEqual([]);
  await verification.getByLabelText('动态码', { exact: true }).fill(TOTP_CODE);
  await verification
    .getByRole('button', { name: /^(?:验证并继续|验\s*证|确\s*认|确\s*定)$/ })
    .click();

  await expect
    .element(page.getByText(/(?<!\d)2(?!\d)\D{0,12}冻结|冻结\D{0,12}(?<!\d)2(?!\d)/).first(), FIRST)
    .toBeVisible();
  await expect.element(row, FIRST).toMatchTextContent(STATUS_NAME.written_off);
  const sent = server.writeOffs(ID.busy);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toEqual({ expected_withdrawal_status: 'APPROVED', note: NOTE_TEXT });
  expect((sent[0]!.headers.get('Idempotency-Key') ?? '').trim()).not.toBe('');
  expect(sent[0]!.headers.get('X-Step-Up-Token')).toBe(stepUpValue(1));
  expect(server.verifies()).toHaveLength(1);
  expect(server.unexpected().map((request) => `${request.method} ${request.path}`)).toEqual([]);
  expect(server.item(ID.busy).status).toBe('written_off');
});
