// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { LoginPage } from '../../../../apps/admin/src/pages/login/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { COPY, CREDENTIALS, SECRET, TITLES, harness, rejected } from './fixtures.ts';

const providers: AdminAuthProvider[] = [];
afterEach(() => {
  cleanup();
  for (const auth of providers.splice(0)) auth.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mount(h = harness(), environment: 'test' | 'production' = 'test') {
  const auth = h.create();
  providers.push(auth);
  const onComplete = vi.fn();
  const view = render(createElement(LoginPage, { authProvider: auth, environment, onComplete }));
  return { ...h, auth, onComplete, view, user: userEvent.setup() };
}

async function credentials(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^账号/), CREDENTIALS.username);
  await user.type(screen.getByLabelText(/^密码/), CREDENTIALS.password);
  await user.click(screen.getByRole('button', { name: '下一步' }));
}

async function heading(step: keyof typeof TITLES) {
  const title = await screen.findByRole('heading', { name: TITLES[step] });
  await waitFor(() => expect(document.activeElement).toBe(title));
}

it('[AC-F1-06h-UI#1] 首屏品牌、必填字段、说明和测试环境；空值不能提交', async () => {
  const h = mount();
  await heading('credentials');
  expect(screen.getByText('凑狸管理后台')).toBeTruthy();
  expect(screen.getByText('账号密码')).toBeTruthy();
  expect(screen.getByText('动态码')).toBeTruthy();
  expect(screen.getByText('测试环境')).toBeTruthy();
  expect(screen.getByText('凑狸内部系统 · 所有操作都会记入操作日志')).toBeTruthy();
  expect(
    screen.getByText(
      '仅限公司网络访问。连续输错 5 次，账号锁定 30 分钟。忘记密码请联系超级管理员重置。',
    ),
  ).toBeTruthy();
  expect((screen.getByLabelText(/^密码/) as HTMLInputElement).type).toBe('password');
  await h.user.click(screen.getByRole('button', { name: '下一步' }));
  expect(h.fetch).not.toHaveBeenCalled();
  expect(h.onComplete).not.toHaveBeenCalled();
});

it('[AC-F1-06h-UI#2] 生产环境不显示测试环境标签', async () => {
  mount(harness(), 'production');
  await heading('credentials');
  expect(screen.queryByText('测试环境')).toBeNull();
});

it('[AC-F1-06h-UI#3] 初始密码账号先设置新密码，确认一致后才请求，再进入绑定', async () => {
  const h = mount(harness('change_password'));
  await credentials(h.user);
  await heading('change_password');
  expect(screen.queryByRole('textbox', { name: '动态码' })).toBeNull();
  expect(h.requests.some((r) => r.path.endsWith('/totp/secret'))).toBe(false);
  await h.user.type(screen.getByLabelText('新密码', { exact: true }), 'example-new-password');
  await h.user.type(screen.getByLabelText('再次输入', { exact: true }), 'mismatch');
  await h.user.click(screen.getByRole('button', { name: '下一步' }));
  expect(h.requests.filter((r) => r.path.endsWith('/auth/password'))).toHaveLength(0);
  await h.user.clear(screen.getByLabelText('再次输入', { exact: true }));
  await h.user.type(screen.getByLabelText('再次输入', { exact: true }), 'example-new-password');
  await h.user.click(screen.getByRole('button', { name: '下一步' }));
  await heading('bind_totp');
  expect(h.auth.getToken()).toBeNull();
  expect(h.onComplete).not.toHaveBeenCalled();
});

for (const step of ['totp', 'bind_totp'] as const) {
  it(`[AC-F1-06h-UI#4] ${step} 错误 role=alert、清空动态码、不完成，重试成功`, async () => {
    const h0 = harness(step);
    const reason = step === 'totp' ? 'totp_invalid' : 'totp_bind_invalid';
    h0.queue(step === 'totp' ? '/admin/v1/auth/totp' : '/admin/v1/auth/totp/bind', () =>
      rejected(20002, { reason }),
    );
    const h = mount(h0);
    await credentials(h.user);
    await heading(step);
    const input = screen.getByRole('textbox', { name: '动态码' }) as HTMLInputElement;
    expect(input.getAttribute('inputmode')).toBe('numeric');
    expect(input.getAttribute('autocomplete')).toBe('one-time-code');
    expect(document.querySelectorAll('[data-otp-cell]')).toHaveLength(6);
    const submit = screen.getByRole('button', { name: step === 'totp' ? '登录' : '验证并绑定' });
    await h.user.type(input, '12345');
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await h.user.click(submit);
    expect(
      h.requests.some(
        (request) =>
          request.path === '/admin/v1/auth/totp' || request.path === '/admin/v1/auth/totp/bind',
      ),
    ).toBe(false);
    await h.user.clear(input);
    await h.user.type(input, '000000');
    await h.user.click(submit);
    expect((await screen.findByRole('alert')).textContent).toContain(COPY[`error.20002.${reason}`]);
    expect(input.value).toBe('');
    expect(h.auth.getToken()).toBeNull();
    expect(h.onComplete).not.toHaveBeenCalled();
    if (step === 'bind_totp') {
      expect(screen.getByText('绑定未完成')).toBeTruthy();
      expect(screen.queryByText('身份验证器已绑定')).toBeNull();
    }
    await h.user.type(input, '123456');
    await h.user.click(submit);
    if (step === 'bind_totp') {
      await heading('done');
      expect(
        screen.getByText('已勾选权限点的账号：打开左侧菜单里有权限的第一个页面。'),
      ).toBeTruthy();
      expect(
        screen.getByText(
          '还没有任何权限点（新建账号默认如此）：打开「暂无权限」提示页，只能看报表和本人的操作日志。',
        ),
      ).toBeTruthy();
      expect(h.onComplete).not.toHaveBeenCalled();
      await h.user.click(screen.getByRole('button', { name: '进入后台' }));
    }
    await waitFor(() => expect(h.onComplete).toHaveBeenCalledTimes(1));
  });
}

for (const step of ['totp', 'bind_totp'] as const) {
  for (const action of ['换账号', '返回上一步'] as const) {
    it(`[AC-F1-06h-UI#5] ${step} 的${action}回第一步并清 ticket 与密钥`, async () => {
      const h = mount(harness(step));
      await credentials(h.user);
      await heading(step);
      await h.user.click(screen.getByRole('button', { name: action }));
      await heading('credentials');
      expect(h.auth.getSnapshot().secret).toBeUndefined();
      expect(h.auth.getToken()).toBeNull();
      expect(h.storage.values.size).toBe(0);
      expect(screen.queryByText('JBSW Y3DP EHPK 3PXP')).toBeNull();
      expect((screen.getByLabelText(/^密码/) as HTMLInputElement).value).toBe('');
    });
  }
}

it('[AC-F1-06h-UI#6] 绑定手动路径展示真实返回密钥、四位分组，复制原值，卸载即丢弃', async () => {
  const h = mount(harness('bind_totp'));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await credentials(h.user);
  await heading('bind_totp');
  expect(screen.getByRole('img', { name: /二维码/ })).toBeTruthy();
  for (const instruction of [
    '在手机上打开身份验证器 App',
    '扫描二维码，添加本账号',
    '输入验证器上显示的 6 位动态码',
  ])
    expect(screen.getByText(instruction)).toBeTruthy();
  expect(screen.getByText(/手动输入密钥/)).toBeTruthy();
  expect(screen.getByText('凑狸管理后台（ops-yi）')).toBeTruthy();
  expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeTruthy();
  expect(screen.getByText('类型：基于时间（TOTP），6 位，30 秒一换')).toBeTruthy();
  expect(
    screen.getByText(
      '中途离开或返回上一步：绑定不生效，下次登录仍从这一步开始，二维码和密钥重新生成，本页的作废。',
    ),
  ).toBeTruthy();
  await h.user.click(screen.getByRole('button', { name: '复制密钥' }));
  expect(copy).toHaveBeenCalledWith(SECRET.totp_secret);
  h.view.unmount();
  expect(h.auth.getSnapshot().secret).toBeUndefined();
  expect(h.auth.getSnapshot().step).toBe('credentials');
});

for (const [code, data, text] of [
  [10008, undefined, COPY['error.10008']],
  [10403, { reason: 'admin_ip_not_allowed' }, COPY['error.10403.admin_ip_not_allowed']],
] as const) {
  it(`[AC-F1-06h-UI#7] ${code} 采用字典提示并留在第一步`, async () => {
    const h0 = harness();
    h0.queue('/admin/v1/auth/login', () => rejected(code, data));
    const h = mount(h0);
    await credentials(h.user);
    expect((await screen.findByRole('alert')).textContent).toContain(text);
    expect(h.auth.getSnapshot().step).toBe('credentials');
    expect(h.onComplete).not.toHaveBeenCalled();
  });
}

it('[AC-F1-06h-UI#8] 10009 显示服务端解锁时刻，按钮仍可点', async () => {
  const h0 = harness();
  h0.queue('/admin/v1/auth/login', () =>
    rejected(10009, { locked_until: '2026-10-07T10:30:00+08:00' }),
  );
  const h = mount(h0);
  await credentials(h.user);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('连续输错次数过多，账号已锁定，请在');
  expect(alert.textContent).toContain('10:30');
  expect(alert.textContent).not.toContain('{unlock_time}');
  expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(h.auth.getToken()).toBeNull();
});

it('[AC-F1-06h-UI#9] 登录步骤过期返回第一步并显示指定提示', async () => {
  const h0 = harness('bind_totp');
  h0.queue('/admin/v1/auth/totp/bind', () => rejected(10001, { reason: 'login_ticket_expired' }));
  const h = mount(h0);
  await credentials(h.user);
  await heading('bind_totp');
  await h.user.type(screen.getByRole('textbox', { name: '动态码' }), '123456');
  await h.user.click(screen.getByRole('button', { name: '验证并绑定' }));
  await heading('credentials');
  expect(screen.getByRole('alert').textContent).toContain(COPY['error.10001.login_ticket_expired']);
  expect(h.auth.getSnapshot().secret).toBeUndefined();
});

for (const retryAfter of [undefined, '9']) {
  it(`[AC-F1-06h-UI#10] 42901 禁用提交 Retry-After=${retryAfter ?? '缺省5秒'}`, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h0 = harness();
    h0.queue('/admin/v1/auth/login', () =>
      rejected(
        42901,
        undefined,
        retryAfter === undefined ? undefined : { 'Retry-After': retryAfter },
      ),
    );
    const h = mount(h0);
    // fireEvent avoids user-event's internal delays crossing the exact cooldown boundary.
    fireEvent.change(screen.getByLabelText(/^账号/), { target: { value: 'ops-yi' } });
    fireEvent.change(screen.getByLabelText(/^密码/), { target: { value: 'example-password' } });
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect((await screen.findByRole('alert')).textContent).toContain(COPY['error.42901']);
    const button = screen.getByRole('button', { name: /下一步/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync((retryAfter === undefined ? 5 : 9) * 1000);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(h.requests.filter((r) => r.path.endsWith('/auth/login'))).toHaveLength(1);
  });
}
