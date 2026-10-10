// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoginPage } from '../../../../apps/admin/src/pages/login/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { COPY, CREDENTIALS, TITLES, harness, rejected } from '../admin-auth/fixtures.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';

const providers: AdminAuthProvider[] = [];
beforeEach(installMediaQuery);
afterEach(() => {
  cleanup();
  for (const auth of providers.splice(0)) auth.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(h = harness()) {
  const auth = h.create();
  providers.push(auth);
  const view = render(
    createElement(LoginPage, { authProvider: auth, environment: 'test', onComplete: vi.fn() }),
  );
  return { ...h, auth, view, user: userEvent.setup() };
}

async function credentials(h: ReturnType<typeof mount>) {
  await h.user.type(screen.getByLabelText(/^账号/), CREDENTIALS.username);
  await h.user.type(screen.getByLabelText(/^密码/), CREDENTIALS.password);
  await h.user.click(screen.getByRole('button', { name: '下一步' }));
}

async function ready(step: keyof typeof TITLES) {
  await waitFor(() => expect(screen.queryByRole('heading', { name: TITLES[step] })).not.toBeNull());
}

function passwordInput(label: string | RegExp) {
  const input = screen.getByLabelText(label, { exact: true });
  expect(input.matches('input')).toBe(true);
  expect(input.getAttribute('type')).toBe('password');
  expect(input.closest('.ant-input-password, .ant-input-affix-wrapper')).not.toBeNull();
  expect(input.closest('.ant-form-item')).not.toBeNull();
}

const stages = [
  { step: 'credentials', next: 'totp', button: '下一步', current: '账号密码', finished: 0 },
  {
    step: 'change_password',
    next: 'change_password',
    button: '下一步',
    current: '设置新密码',
    finished: 1,
  },
  { step: 'totp', next: 'totp', button: '登录', current: '动态码', finished: 1 },
  {
    step: 'bind_totp',
    next: 'bind_totp',
    button: '验证并绑定',
    current: '绑定身份验证器',
    finished: 1,
  },
  { step: 'done', next: 'bind_totp', button: '进入后台', current: null, finished: 2 },
] as const;

for (const stage of stages) {
  it(`[AC-F1-06p-LOGIN#1] ${stage.step} 使用 Form、主按钮、Steps 和对应 antd 输入控件`, async () => {
    const h = mount(harness(stage.next));
    if (stage.step !== 'credentials') await credentials(h);
    if (stage.step === 'done') {
      await ready('bind_totp');
      await h.user.type(screen.getByRole('textbox', { name: '动态码' }), '123456');
      await h.user.click(screen.getByRole('button', { name: '验证并绑定' }));
    }
    await ready(stage.step);
    const button = screen.getByRole('button', { name: stage.button });
    expect(button.matches('button.ant-btn-primary')).toBe(true);
    expect(button.closest('.ant-form')).not.toBeNull();
    const steps = h.view.container.querySelector('.ant-steps');
    expect(steps).not.toBeNull();
    expect(steps?.querySelectorAll('.ant-steps-item-process')).toHaveLength(
      stage.current === null ? 0 : 1,
    );
    expect(steps?.querySelectorAll('.ant-steps-item-finish')).toHaveLength(stage.finished);
    if (stage.current !== null)
      expect(steps?.querySelector('.ant-steps-item-process')?.textContent).toContain(stage.current);
    if (stage.finished > 0)
      expect(steps?.querySelector('.ant-steps-item-finish')?.textContent).toContain('账号密码');

    if (stage.step === 'credentials') {
      const account = screen.getByLabelText(/^账号/);
      expect(account.matches('input.ant-input')).toBe(true);
      expect(account.closest('.ant-form-item')).not.toBeNull();
      passwordInput(/^密码/);
      expect(
        screen
          .getByText(
            '仅限公司网络访问。连续输错 5 次，账号锁定 30 分钟。忘记密码请联系超级管理员重置。',
          )
          .closest('.ant-alert'),
      ).not.toBeNull();
    }
    if (stage.step === 'change_password') {
      passwordInput('新密码');
      passwordInput('再次输入');
      expect(
        screen
          .getByText(
            '这是本账号第一次登录，请先把初始密码换成只有你知道的新密码，再绑定身份验证器。',
          )
          .closest('.ant-alert'),
      ).not.toBeNull();
    }
    if (stage.step === 'totp' || stage.step === 'bind_totp')
      expect(screen.getByRole('textbox', { name: '动态码' }).matches('input.ant-input')).toBe(true);
    if (stage.step === 'bind_totp') {
      expect(
        screen
          .getByText(
            '这是本账号第一次登录，需要先绑定身份验证器。绑定后，每次登录和后台二次验证都要用它生成的 6 位动态码。',
          )
          .closest('.ant-alert'),
      ).not.toBeNull();
      await waitFor(() => {
        const region = screen.queryByRole('img', { name: /二维码/ });
        expect(region).not.toBeNull();
        expect(region?.matches('.ant-qrcode') || region?.querySelector('.ant-qrcode') != null).toBe(
          true,
        );
      });
    }
  });
}

function fieldError(label: string | RegExp, message: string) {
  const input = screen.getByLabelText(label, { exact: true });
  const item = input.closest('.ant-form-item');
  expect(item).not.toBeNull();
  expect(item?.classList.contains('ant-form-item-has-error')).toBe(true);
  expect(item?.querySelector('.ant-form-item-explain-error')?.textContent).toContain(message);
  expect(input.getAttribute('aria-invalid')).toBe('true');
}

it('[AC-F1-06p-LOGIN#2] 空提交在账号和密码各自的 Form.Item 显示本地错误', async () => {
  const h = mount();
  await h.user.click(screen.getByRole('button', { name: '下一步' }));
  await waitFor(() => {
    fieldError(/^账号/, '请输入账号');
    fieldError(/^密码/, '请输入密码');
  });
  expect(h.fetch).not.toHaveBeenCalled();
});

for (const field of ['username', 'password'] as const) {
  it(`[AC-F1-06p-LOGIN#3] 服务端 20001 fields=[${field}] 只标记对应 Form.Item`, async () => {
    const fixture = harness();
    fixture.queue('/admin/v1/auth/login', () => rejected(20001, { fields: [field] }));
    const h = mount(fixture);
    await credentials(h);
    await waitFor(() => expect(h.auth.getSnapshot().error?.key).toBe('error.20001'));
    await waitFor(() =>
      fieldError(field === 'username' ? /^账号/ : /^密码/, '这一项填写有误，请检查'),
    );
    const other = screen.getByLabelText(field === 'username' ? /^密码/ : /^账号/);
    expect(other.closest('.ant-form-item')).not.toBeNull();
    expect(other.closest('.ant-form-item')?.classList.contains('ant-form-item-has-error')).toBe(
      false,
    );
    expect(other.getAttribute('aria-invalid')).not.toBe('true');
  });
}

it('[AC-F1-06p-LOGIN#4] 账号密码错误横幅使用 Alert，保留可访问错误提示', async () => {
  const fixture = harness();
  fixture.queue('/admin/v1/auth/login', () => rejected(10008));
  const h = mount(fixture);
  await credentials(h);
  await waitFor(() => {
    const alert = screen
      .queryAllByRole('alert')
      .find((node) => node.textContent?.includes(COPY['error.10008']));
    expect(alert?.textContent).toContain(COPY['error.10008']);
    expect(alert?.closest('.ant-alert') ?? null).not.toBeNull();
  });
});

for (const step of ['totp', 'bind_totp'] as const) {
  it(`[AC-F1-06p-LOGIN#5] ${step} 验证失败提示使用 Alert`, async () => {
    const fixture = harness(step);
    const reason = step === 'totp' ? 'totp_invalid' : 'totp_bind_invalid';
    fixture.queue(step === 'totp' ? '/admin/v1/auth/totp' : '/admin/v1/auth/totp/bind', () =>
      rejected(20002, { reason }),
    );
    const h = mount(fixture);
    await credentials(h);
    await ready(step);
    await h.user.type(screen.getByRole('textbox', { name: '动态码' }), '000000');
    await h.user.click(
      screen.getByRole('button', { name: step === 'totp' ? '登录' : '验证并绑定' }),
    );
    await waitFor(() => {
      const message = screen.queryByText(COPY[`error.20002.${reason}`]);
      expect(message).not.toBeNull();
      expect(message?.closest('.ant-alert') ?? null).not.toBeNull();
      if (step === 'bind_totp')
        expect(screen.queryByText('绑定未完成')?.closest('.ant-alert') ?? null).not.toBeNull();
    });
  });
}
