/// <reference types="@vitest/browser-playwright" />
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { commands, page } from 'vitest/browser';
import { LoginPage } from '../../../../apps/admin/src/pages/login/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import '../../../../apps/admin/src/styles/admin.css';
import { COPY, TITLES, harness, rejected } from './fixtures.ts';

let root: Root | undefined;
let auth: AdminAuthProvider | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  auth?.dispose();
  auth = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

// Review against AdmLogin / AdmLoginTotp / AdmLoginTotpBind / AdmLoginTotpBindInvalid.
// The binding artboards are taller than 900: keep the requested viewport, capture full content.
// Screenshot comparison is review evidence; the red cause is the semantic assertions below.
for (const state of ['credentials', 'totp', 'bind_totp', 'bind_invalid'] as const) {
  it(`[AC-F1-06h-BROWSER#1] ${state} 1440×900 登录画板`, async () => {
    await page.viewport(1440, 900);
    const h = harness(state === 'bind_totp' || state === 'bind_invalid' ? 'bind_totp' : 'totp');
    if (state === 'bind_invalid')
      h.queue('/admin/v1/auth/totp/bind', () => rejected(20002, { reason: 'totp_bind_invalid' }));
    auth = h.create();
    const container = document.createElement('div');
    container.id = 'root';
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(LoginPage, {
          authProvider: auth!,
          environment: 'test',
          onComplete: () => undefined,
        }),
      );
    });
    await expect.element(page.getByRole('heading', { name: TITLES.credentials })).toBeVisible();
    await expect.element(page.getByRole('heading', { name: TITLES.credentials })).toHaveFocus();
    await expect.element(page.getByText('凑狸管理后台', { exact: true })).toBeVisible();
    await expect.element(page.getByText('测试环境', { exact: true })).toBeVisible();
    if (state === 'credentials') {
      await expect.element(page.getByLabelText(/^账号/)).toBeVisible();
      await expect.element(page.getByLabelText(/^密码/)).toHaveAttribute('type', 'password');
      await expect.element(page.getByRole('button', { name: '下一步', exact: true })).toBeVisible();
      await expect
        .element(
          page.getByText(
            '仅限公司网络访问。连续输错 5 次，账号锁定 30 分钟。忘记密码请联系超级管理员重置。',
          ),
        )
        .toBeVisible();
    } else {
      await act(async () => {
        await page.getByLabelText(/^账号/).fill('ops-yi');
        await page.getByLabelText(/^密码/).fill('example-password');
        await page.getByRole('button', { name: '下一步', exact: true }).click();
      });
      const title = page.getByRole('heading', {
        name: state === 'totp' ? TITLES.totp : TITLES.bind_totp,
      });
      await expect.element(title).toBeVisible();
      await expect.element(title).toHaveFocus();
      const input = page.getByRole('textbox', { name: '动态码' });
      // OtpInput uses a transparent single native input over six visible cells.
      await expect.element(input).toBeInTheDocument();
      await expect.element(input).toHaveAttribute('maxlength', '6');
      await expect.element(input).toHaveAttribute('inputmode', 'numeric');
      await expect.element(page.getByRole('button', { name: '返回上一步' })).toBeVisible();
      if (state === 'totp') {
        await expect.element(page.getByText('请输入身份验证器中的 6 位动态码')).toBeVisible();
        await expect.element(page.getByText('无法获取动态码？请联系超级管理员')).toBeVisible();
        await expect.element(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
      } else {
        const qr = page.getByRole('img', { name: /二维码/ });
        await expect.element(qr).toBeVisible();
        await expect.element(qr).toHaveStyle({ width: '148px', height: '148px' });
        await expect.element(page.getByText(/手动输入密钥/)).toBeVisible();
        await expect.element(page.getByText('凑狸管理后台（ops-yi）')).toBeVisible();
        await expect.element(page.getByText('JBSW Y3DP EHPK 3PXP')).toBeVisible();
        await expect.element(page.getByRole('button', { name: '复制密钥' })).toBeVisible();
        await expect
          .element(page.getByText('类型：基于时间（TOTP），6 位，30 秒一换'))
          .toBeVisible();
        if (state === 'bind_invalid') {
          await act(async () => {
            await input.fill('000000');
            await page.getByRole('button', { name: '验证并绑定' }).click();
          });
          await expect
            .element(page.getByRole('alert'))
            .toHaveTextContent(COPY['error.20002.totp_bind_invalid']);
          await expect.element(page.getByText('绑定未完成', { exact: true })).toBeVisible();
          await expect.element(input).toHaveValue('');
          await expect
            .element(page.getByText('身份验证器已绑定', { exact: true }))
            .not.toBeInTheDocument();
        }
      }
    }
    await expect.element(page.getByText('凑狸内部系统 · 所有操作都会记入操作日志')).toBeVisible();
    await document.fonts.ready;
    const name = {
      credentials: 'admin-login',
      totp: 'admin-login-totp',
      bind_totp: 'admin-login-bind',
      bind_invalid: 'admin-login-bind-invalid',
    }[state];
    const screenshot = await page.screenshot({ base64: true, fullPage: true });
    const fixedPath = screenshot.path.replace(/[^/]+$/, `${name}.png`);
    await commands.writeFile(fixedPath, screenshot.base64, 'base64');
    if (fixedPath !== screenshot.path) await commands.removeFile(screenshot.path);
  });
}
