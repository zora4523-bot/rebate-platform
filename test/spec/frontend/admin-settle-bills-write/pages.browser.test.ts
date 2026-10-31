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
  BATCH,
  OTP,
  confirmPath,
  createServer,
  namePattern,
  snapshot,
} from './fixtures.ts';

// The real /settle-bills route of the admin app in Chromium: 【查看】 of the issued bill,
// 【确认立即执行】, its confirmation dialog, the totp step-up dialog and the confirm POST; the batch
// rows then show the dictionary name of CONFIRMED. Only the three reads, the step-up and the
// confirm go out. Waits use expect.element only.
const FIRST = { timeout: 10_000 };
const DISMISS = /^(?:取消|关闭|返回|Close|Cancel)$/i;
/** The confirmation covers every waiting batch of the bill (BR-FUND-04 ⑥). */
const SCOPE =
  /全部.{0,12}(?:待确认|DRAFT).{0,4}批次|(?:待确认|DRAFT).{0,6}批次.{0,12}(?:全部|一并|一次|都)|一次.{0,6}确认.{0,12}全部/;

/** The row of the batch table (main area) holding `batchId`. */
function batchRow(batchId: string) {
  return page
    .getByRole('main')
    .getByRole('row')
    .filter({ hasText: batchId.slice(0, 8) });
}
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

async function show() {
  const server = createServer(undefined, { writes: ['confirm'] });
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

/** The one button of `dialog` that does not dismiss it. */
function submitIn(dialog: Element): HTMLElement {
  const buttons = Array.from(dialog.querySelectorAll<HTMLElement>('button')).filter((node) => {
    const text = (node.textContent ?? '').replace(/\s+/g, '');
    return (
      node.closest('.ant-modal-close, .ant-picker, label') === null &&
      text !== '' &&
      !DISMISS.test(text)
    );
  });
  expect(buttons, 'one submit button in the dialog').toHaveLength(1);
  return buttons[0]!;
}

it('[AC-F1-08db-BROWSER#1] /settle-bills：【查看】2026-08，【确认立即执行】弹确认框（说明一次确认全部待确认批次），提交后弹动态码，验证后 POST confirm 带两批次的 expected_batches 与令牌，两批次显示「已确认」；只发三个读、动态码与 confirm', async () => {
  await page.viewport(1440, 1080);
  const server = await show();
  const bill = page
    .getByRole('main')
    .getByRole('row')
    .filter({ hasText: /(?<![\d-])2026-08(?!-?\d)/ });
  await expect.element(bill, FIRST).toBeVisible();
  await bill
    .getByText(/^(?:查\s*看|详\s*情)$/)
    .first()
    .click();

  const taobao = batchRow(BATCH.issuedTaobao);
  await expect.element(taobao, FIRST).toBeVisible();
  const entry = page.getByRole('main').getByRole('button', { name: /确认立即执行/ });
  await expect.element(entry, FIRST).toBeVisible();
  await entry.click();

  const dialog = page.getByRole('dialog');
  await expect.element(dialog, FIRST).toBeVisible();
  await expect.element(dialog).toMatchTextContent(SCOPE);
  expect(server.requests('POST'), 'nothing sent when the dialog opens').toEqual([]);
  await page.elementLocator(submitIn(dialog.element())).click();

  const verification = page.getByRole('dialog', { name: '二次验证 · 动态码' });
  await expect.element(verification, FIRST).toBeVisible();
  expect(server.writes('confirm'), 'no confirm before the step-up').toEqual([]);
  await verification.getByLabelText('动态码', { exact: true }).fill(OTP);
  await verification.getByRole('button', { name: '验证并继续' }).click();

  const confirmed = namePattern('batchStatus', 'CONFIRMED');
  await expect.element(taobao, FIRST).toMatchTextContent(confirmed);
  await expect.element(batchRow(BATCH.issuedJd), FIRST).toMatchTextContent(confirmed);

  expect(server.writes('confirm')).toHaveLength(1);
  const request = server.writes('confirm')[0]!;
  expect(request.path).toBe(confirmPath('2026-08'));
  const expected = (request.body as { expected_batches: { batch_id: string }[] }).expected_batches
    .slice()
    .sort((a, b) => (a.batch_id < b.batch_id ? -1 : 1));
  expect(expected).toEqual([
    { batch_id: BATCH.issuedTaobao, expected_row_version: 0 },
    { batch_id: BATCH.issuedJd, expected_row_version: 3 },
  ]);
  expect(request.headers.get('X-Step-Up-Token')).toBe(server.issued[0]);
  expect(server.strays()).toEqual([]);
});
