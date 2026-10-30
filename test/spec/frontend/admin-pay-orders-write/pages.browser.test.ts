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
  ORDER,
  TOTP_CODE,
  VERIFY,
  VIEW_REFUND_GRANTS,
  VIEW_RESOLVE_GRANTS,
  createServer,
  issuedStepUp,
  namePattern,
  newOutRefundNo,
  refundPath,
  resolvePath,
  snapshot,
  type Server,
} from './fixtures.ts';

// The real /pay-orders/{pay_order_id} route of the admin app in Chromium: 【发起退款】 on a partly
// refunded PAID pay order (12.34 yuan sent as 1234 fen with an Idempotency-Key, no step-up, the
// new PROCESSING refund listed), and 【立即查询】 on a needs_manual pay order (dynamic code, the
// fixed body with X-Step-Up-Token, settled as paid, the entry gone). Only the reads of F1-13a and
// the write of the case go out; the refund list is never read. Waits use expect.element and
// expect.poll only.
const FIRST = { timeout: 10_000 };
const TEST_TIMEOUT = 60_000;
let root: Root | undefined;
let auth: AdminAuthProvider | undefined;
/** The server of the case and the writes (method and path) it may receive. */
let shown: { server: Server; allowed: readonly (readonly [string, string])[] } | undefined;
afterEach(() => {
  const checked = shown;
  shown = undefined;
  root?.unmount();
  root = undefined;
  auth?.dispose();
  auth = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
  // Every case, its error and retry paths included: only the reads and the writes of the case.
  if (checked !== undefined) {
    expect(checked.server.refundReads(), 'the refund list is never read').toEqual([]);
    expect(checked.server.unexpected(checked.allowed)).toEqual([]);
  }
});

async function show(
  server: Server,
  path: string,
  allowed: readonly (readonly [string, string])[],
): Promise<Server> {
  shown = { server, allowed };
  auth = harness().create();
  await signIn(auth);
  window.history.replaceState(null, '', path);
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

/** Chooses `option` in the reason select (or radio group) of the open dialog. */
async function pickReason(option: RegExp): Promise<void> {
  const combo = page.getByRole('combobox', { name: /原因/ });
  if (combo.elements().length === 0) {
    await page.getByRole('radio', { name: option }).click();
    return;
  }
  await combo.click();
  const element = combo.element() as HTMLElement;
  const matches = (node: HTMLElement): boolean => option.test((node.textContent ?? '').trim());
  await expect.poll(() => optionNodes(element).some(matches), FIRST).toBe(true);
  await page.elementLocator(optionNodes(element).find(matches)!).click();
}

it(
  '[AC-F1-13b-BROWSER#1] /pay-orders/{id}：持 pay.refund 的账号在部分退款的已支付单上【发起退款】，填 12.34 元与原因提交（amount_fen=1234、Idempotency-Key、不弹动态码），退款记录出现新的一笔 12.34 处理中；不读退款单列表',
  async () => {
    await page.viewport(1440, 1080);
    const server = await show(
      createServer(undefined, { permissions: VIEW_REFUND_GRANTS }),
      `/pay-orders/${ORDER.refunded}`,
      [['POST', refundPath(ORDER.refunded)]],
    );
    const entry = page
      .getByRole('main')
      .getByRole('button', { name: /^(?:发起退款|原路退款|退\s*款)$/ })
      .first();
    await expect.element(entry, FIRST).toBeVisible();
    await entry.click();

    const amount = page.getByLabelText(/^(?!.*可退).*金额/);
    await expect.element(amount, FIRST).toBeVisible();
    await amount.fill('12.34');
    await pickReason(namePattern('refundReason', 'USER_REQUEST', true));
    expect(server.refunds()).toEqual([]);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^(?:确\s*认|确\s*定|提\s*交)/ })
      .first()
      .click();

    await expect.poll(() => server.refunds(ORDER.refunded).length, FIRST).toBe(1);
    const sent = server.refunds(ORDER.refunded)[0]!;
    expect(sent.body).toEqual({ amount_fen: 1234, reason_code: 'USER_REQUEST' });
    expect((sent.headers.get('Idempotency-Key') ?? '').trim()).not.toBe('');
    expect(sent.headers.has('X-Step-Up-Token')).toBe(false);
    expect(server.requests('POST', VERIFY)).toEqual([]);

    const row = page
      .getByRole('main')
      .getByRole('row')
      .filter({ hasText: newOutRefundNo(1) });
    await expect.element(row, FIRST).toBeVisible();
    await expect.element(row).toMatchTextContent(/12\.34/);
    await expect.element(row).toMatchTextContent(namePattern('refundStatus', 'PROCESSING'));
    expect(server.unexpected([['POST', refundPath(ORDER.refunded)]])).toEqual([]);
    expect(server.refundReads()).toEqual([]);
  },
  TEST_TIMEOUT,
);

it(
  '[AC-F1-13b-BROWSER#2] /pay-orders/{id}：持 pay.resolve 的账号在待人工处置单上【立即查询】，输入动态码后 POST …/resolve（X-Step-Up-Token、固定请求体、无 Idempotency-Key），渠道已支付 → 重新读取详情、状态变「已支付」、入口消失',
  async () => {
    await page.viewport(1440, 1080);
    const server = createServer(undefined, { permissions: VIEW_RESOLVE_GRANTS });
    server.setResolveOutcome('paid');
    await show(server, `/pay-orders/${ORDER.manual}`, [
      ['POST', VERIFY],
      ['POST', resolvePath(ORDER.manual)],
    ]);
    const entry = page.getByRole('main').getByRole('button', { name: /^立即查询$/ });
    await expect.element(entry, FIRST).toBeVisible();
    await entry.click();

    const verification = page.getByRole('dialog', { name: '二次验证 · 动态码' });
    // A confirmation before the dynamic code is accepted: confirm it.
    await expect
      .poll(
        () => verification.elements().length + page.getByRole('dialog').elements().length,
        FIRST,
      )
      .toBeGreaterThan(0);
    if (verification.elements().length === 0)
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /^(?:确\s*认|确\s*定|继\s*续|立即查询|查\s*询)/ })
        .first()
        .click();
    await expect.element(verification, FIRST).toBeVisible();
    expect(server.resolves()).toEqual([]);
    const reads = server.detailReads(ORDER.manual).length;
    await verification.getByLabelText('动态码', { exact: true }).fill(TOTP_CODE);
    await verification.getByRole('button', { name: '验证并继续' }).click();

    await expect.poll(() => server.resolves(ORDER.manual).length, FIRST).toBe(1);
    const sent = server.resolves(ORDER.manual)[0]!;
    expect(sent.body).toEqual({ expected_status: 'PENDING', action: 'query_and_settle' });
    expect(sent.headers.get('X-Step-Up-Token')).toBe(issuedStepUp(1));
    expect(sent.headers.has('Idempotency-Key')).toBe(false);
    await expect.poll(() => server.detailReads(ORDER.manual).length, FIRST).toBeGreaterThan(reads);
    await expect
      .element(page.getByRole('main').getByText(namePattern('payStatus', 'PAID')).first(), FIRST)
      .toBeVisible();
    await expect
      .poll(
        () =>
          page
            .getByRole('main')
            .getByRole('button', { name: /^立即查询$/ })
            .elements()
            .filter((node) => !(node as HTMLButtonElement).disabled).length,
        FIRST,
      )
      .toBe(0);
    expect(
      server.unexpected([
        ['POST', VERIFY],
        ['POST', resolvePath(ORDER.manual)],
      ]),
    ).toEqual([]);
    expect(server.refundReads()).toEqual([]);
  },
  TEST_TIMEOUT,
);
