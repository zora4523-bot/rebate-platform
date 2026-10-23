/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import {
  BASE_URL,
  NOW,
  PENDING_JD_ID,
  PID,
  SITE,
  activateUrl,
  createServer,
  screenshot,
} from './fixtures.ts';

// The real /unions route of the admin app in Chromium: the 推广位 tab, its list and the
// activation with a real file input and a real multipart body. Waits use expect.element only.
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
  window.history.replaceState(null, '', '/unions');
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'browser',
      authProvider: auth,
      permissionsProvider: async () => ({
        isSuper: false,
        permissions: ['union.account_auth', 'union.pid'],
      }),
      account: { username: 'ops-yi', displayName: '运营' },
      environment: 'test',
      onLogout: () => {},
      clock: { now: () => NOW },
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

function tabPanel() {
  return page.getByRole('main').getByRole('tabpanel');
}
function pidRow(pid: string) {
  return tabPanel().getByRole('row').filter({ hasText: pid });
}
async function openPids(): Promise<void> {
  const tab = page.getByRole('main').getByRole('tab', { name: '推广位' });
  await expect.element(tab, FIRST).toBeVisible();
  await tab.click();
  await expect.element(tabPanel(), FIRST).toMatchTextContent(PID.active);
}

it('[AC-F1-10gb-BROWSER#1] /unions 推广位页签：真实路由显示列表字段与按状态的入口，没有删除', async () => {
  await page.viewport(1440, 1080);
  await show();
  await openPids();
  const panel = tabPanel();
  await expect.element(panel).toMatchTextContent(PID.pendingJd);
  await expect.element(panel).toMatchTextContent(PID.retired);
  await expect.element(panel).toMatchTextContent(SITE);
  await expect.element(panel).toMatchTextContent('self_buy');
  await expect.element(panel).toMatchTextContent('待确认');
  await expect
    .element(pidRow(PID.pendingJd).getByRole('button', { name: /^修改/ }), FIRST)
    .toBeVisible();
  await expect.element(pidRow(PID.pendingJd).getByRole('button', { name: /^启用/ })).toBeVisible();
  await expect.element(pidRow(PID.active).getByRole('button', { name: /^停用/ })).toBeVisible();
  await expect
    .element(pidRow(PID.retired).getByRole('button', { name: /修改|启用|停用|删除/ }))
    .not.toBeInTheDocument();
  await expect.element(panel.getByRole('button', { name: /删除|移除/ })).not.toBeInTheDocument();
  await expect.element(panel.getByRole('button', { name: /^(?:登记|新增|添加)/ })).toBeVisible();
});

it('[AC-F1-10gb-BROWSER#2] 真实浏览器启用：填确认时间、选截图、动态码后 multipart 提交，行变为启用中', async () => {
  await page.viewport(1440, 1080);
  const server = await show();
  await openPids();
  const entry = pidRow(PID.pendingJd).getByRole('button', { name: /^启用/ });
  await expect.element(entry, FIRST).toBeVisible();
  await entry.click();
  await expect.element(page.getByRole('dialog'), FIRST).toBeVisible();
  const modal = page.elementLocator(page.getByRole('dialog').element());
  const time = modal.getByLabelText(/确认时间|忽略.*时间/);
  await expect.element(time, FIRST).toBeVisible();
  if ((time.element() as HTMLInputElement).type === 'datetime-local') {
    await time.fill('2026-10-22T09:30');
  } else {
    await time.click();
    await time.fill('2026-10-22 09:30:00');
    await userEvent.keyboard('{Enter}');
  }
  const inputs = modal.element().querySelectorAll<HTMLInputElement>('input[type="file"]');
  expect(inputs).toHaveLength(1);
  const transfer = new DataTransfer();
  transfer.items.add(screenshot('hjy.png', 'image/png', 2048));
  inputs[0]!.files = transfer.files;
  inputs[0]!.dispatchEvent(new Event('change', { bubbles: true }));
  await modal.getByRole('button', { name: /^(?:验证并|确认|提交|保存)/ }).click();
  const verification = page.getByRole('dialog', { name: '二次验证 · 动态码' });
  await expect.element(verification, FIRST).toBeVisible();
  expect(server.requests('POST', activateUrl(PENDING_JD_ID))).toEqual([]);
  await verification.getByLabelText('动态码', { exact: true }).fill('123456');
  await verification.getByRole('button', { name: '验证并继续' }).click();
  await expect
    .element(pidRow(PID.pendingJd).getByRole('button', { name: /^停用/ }), FIRST)
    .toBeVisible();
  const sent = server.requests('POST', activateUrl(PENDING_JD_ID));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.headers.get('X-Step-Up-Token')).toBe('test-totp-1');
  expect(sent[0]!.headers.has('Idempotency-Key')).toBe(false);
  const parts = sent[0]!.form!;
  expect([...new Set(parts.keys())].sort()).toEqual([
    'expected_row_version',
    'hjy_ignore_confirmed_at',
    'hjy_ignore_evidence',
  ]);
  expect(parts.get('expected_row_version')).toBe('0');
  expect(Date.parse(parts.get('hjy_ignore_confirmed_at') as string)).toBe(
    Date.parse('2026-10-22T09:30:00+08:00'),
  );
  expect((parts.get('hjy_ignore_evidence') as Blob).type).toBe('image/png');
  expect((parts.get('hjy_ignore_evidence') as Blob).size).toBe(2048);
});
