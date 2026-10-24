/// <reference types="@vitest/browser-playwright" />
// F1-10gc in a real Chromium: the real /unions route of the admin app for an admin holding only
// union.pid. The 推广位 tab shows the account names from GET /admin/v1/union/account-options, the
// register dialog lists that platform's accounts and registers; GET /admin/v1/union-accounts is
// never read. Waits use expect.element / expect.poll only.
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import {
  BASE_URL,
  JD_NAME,
  NOW,
  PDD_NAME,
  PID,
  PIDS,
  SITE,
  TAOBAO_ACCOUNT,
  TAOBAO_NAME,
} from '../admin-union-pids/fixtures.ts';
import { backend, type Backend } from './server.ts';

const FIRST = { timeout: 10_000 };
const TEST_TIMEOUT = 60_000;
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

async function show(): Promise<Backend> {
  const api = backend({ granted: ['union.pid'] });
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
      permissionsProvider: async () => ({ isSuper: false, permissions: ['union.pid'] }),
      account: { username: 'ops-yi', displayName: '运营' },
      environment: 'test',
      onLogout: () => {},
      clock: { now: () => NOW },
      dataProvider: createDataProvider({
        baseUrl: BASE_URL,
        fetch: api.fetch,
        getToken: () => 'example-admin-token',
        onError: () => {},
      }),
    }),
  );
  return api;
}

function tabPanel() {
  return page.getByRole('main').getByRole('tabpanel');
}
function pidRow(pid: string) {
  return tabPanel().getByRole('row').filter({ hasText: pid });
}

/** The visible option contents of the dropdown that `combo` controls. */
function optionNodes(combo: HTMLElement): HTMLElement[] {
  const id = combo.getAttribute('aria-controls') ?? combo.getAttribute('aria-owns');
  const list = id === null || id === '' ? null : document.getElementById(id);
  const own = list?.closest<HTMLElement>('.ant-select-dropdown') ?? null;
  const scopes =
    own !== null
      ? [own]
      : Array.from(
          document.querySelectorAll<HTMLElement>(
            '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
          ),
        );
  return scopes.flatMap((scope) =>
    Array.from(scope.querySelectorAll<HTMLElement>('.ant-select-item-option-content')),
  );
}

type Locator = ReturnType<typeof page.getByRole>;

/** Opens the select, waits for an option matching `option`, clicks it; returns what was offered. */
async function pick(combo: Locator, option: RegExp): Promise<string[]> {
  await expect.element(combo, FIRST).toBeVisible();
  await combo.click();
  const element = combo.element() as HTMLElement;
  const matches = (node: HTMLElement): boolean => option.test((node.textContent ?? '').trim());
  await expect.poll(() => optionNodes(element).some(matches), FIRST).toBe(true);
  const nodes = optionNodes(element);
  const offered = nodes.map((node) => (node.textContent ?? '').trim());
  await page.elementLocator(nodes.find(matches)!).click();
  return offered;
}

it(
  '[AC-F1-10gc-BROWSER#1] 只持 union.pid：真实 /unions 推广位页签显示所属账号名，登记对话框只列淘宝账号并完成登记，不读 union-accounts',
  async () => {
    await page.viewport(1440, 1080);
    const api = await show();
    const tab = page.getByRole('main').getByRole('tab', { name: '推广位' });
    await expect.element(tab, FIRST).toBeVisible();
    await tab.click();
    await expect.element(tabPanel(), FIRST).toMatchTextContent(PID.active);
    await expect.element(pidRow(PID.active), FIRST).toMatchTextContent(TAOBAO_NAME);
    await expect.element(pidRow(PID.pendingJd), FIRST).toMatchTextContent(JD_NAME);
    await tabPanel()
      .getByRole('button', { name: /^(?:登记|新增|添加)/ })
      .click();
    const modal = page.getByRole('dialog', { name: /登记|新增|添加/ });
    await expect.element(modal, FIRST).toBeVisible();
    await pick(modal.getByRole('combobox', { name: /平台/ }), /^(?:淘宝|taobao)$/i);
    const offered = await pick(
      modal.getByRole('combobox', { name: /联盟账号|账号/ }),
      new RegExp(TAOBAO_NAME),
    );
    expect(offered.join('|')).not.toContain(JD_NAME);
    expect(offered.join('|')).not.toContain(PDD_NAME);
    await expect.element(modal, FIRST).toMatchTextContent(TAOBAO_NAME);
    await modal.getByLabelText(/site_?id|站点|网站/i).fill(SITE);
    await modal.getByLabelText(/PID/i).fill('2005');
    await pick(modal.getByRole('combobox', { name: /场景/ }), /share/);
    await modal.getByRole('button', { name: /^(?:验证并|确认|提交|保存)/ }).click();
    const verification = page.getByRole('dialog', { name: '二次验证 · 动态码' });
    await expect.element(verification, FIRST).toBeVisible();
    expect(api.server.requests('POST', PIDS)).toEqual([]);
    await verification.getByLabelText('动态码', { exact: true }).fill('123456');
    await verification.getByRole('button', { name: '验证并继续' }).click();
    await expect.element(pidRow('2005'), FIRST).toMatchTextContent(TAOBAO_NAME);
    const sent = api.server.requests('POST', PIDS);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({
      platform: 'taobao',
      union_account_id: TAOBAO_ACCOUNT,
      site_id: SITE,
      pid: '2005',
      pid_scene: 'share',
    });
    expect(sent[0]!.headers.get('X-Step-Up-Token')).toBe('test-totp-1');
    expect(api.optionReads().length).toBeGreaterThan(0);
    expect(api.accountReads()).toEqual([]);
  },
  TEST_TIMEOUT,
);
