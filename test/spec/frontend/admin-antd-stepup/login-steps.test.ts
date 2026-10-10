// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoginPage } from '../../../../apps/admin/src/pages/login/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { CREDENTIALS, TITLES, harness } from '../admin-auth/fixtures.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';

const providers: AdminAuthProvider[] = [];
beforeEach(installMediaQuery);
afterEach(() => {
  cleanup();
  for (const auth of providers.splice(0)) auth.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(next: 'totp' | 'bind_totp') {
  const auth = harness(next).create();
  providers.push(auth);
  const view = render(
    createElement(LoginPage, { authProvider: auth, environment: 'test', onComplete: vi.fn() }),
  );
  return { view, user: userEvent.setup() };
}

function namedSteps(): HTMLElement {
  // A named list or an equivalent named region is allowed; do not pin the wrapper tag.
  const candidates = [
    ...screen.queryAllByRole('list', { name: '登录步骤' }),
    ...screen.queryAllByRole('region', { name: '登录步骤' }),
    ...screen.queryAllByRole('group', { name: '登录步骤' }),
    ...screen.queryAllByRole('navigation', { name: '登录步骤' }),
  ];
  expect(candidates).toHaveLength(1);
  const steps = candidates[0]!;
  expect(steps.matches('.ant-steps') || steps.querySelector('.ant-steps') !== null).toBe(true);
  return steps;
}

function currentStep(label: string): void {
  const steps = namedSteps();
  const current = steps.querySelectorAll('[aria-current="step"]');
  expect(current).toHaveLength(1);
  expect(current[0]?.textContent).toContain(label);
}

async function credentials(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/^账号/), CREDENTIALS.username);
  await user.type(screen.getByLabelText(/^密码/), CREDENTIALS.password);
  await user.click(screen.getByRole('button', { name: '下一步' }));
}

it('[AC-F1-06r-LOGIN-STEPS#1] 登录步骤可读，当前步从账号密码移到动态码', async () => {
  const { user } = mount('totp');
  currentStep('账号密码');
  await credentials(user);
  await screen.findByRole('heading', { name: TITLES.totp });
  await waitFor(() => currentStep('动态码'));
});

it('[AC-F1-06r-LOGIN-STEPS#2] 绑定流程保留具名 antd 步骤，完成页清除当前步', async () => {
  const { user, view } = mount('bind_totp');
  // The initial step assertion also makes this case red on the baseline: the done page
  // already lacks aria-current, and checking that alone would be a green test.
  currentStep('账号密码');
  await credentials(user);
  await screen.findByRole('heading', { name: TITLES.bind_totp });
  currentStep('绑定身份验证器');
  await user.type(screen.getByRole('textbox', { name: '动态码' }), '123456');
  await user.click(screen.getByRole('button', { name: '验证并绑定' }));
  await screen.findByRole('heading', { name: TITLES.done });
  expect(namedSteps().querySelectorAll('[aria-current="step"]')).toHaveLength(0);
  expect(view.container.querySelectorAll('[aria-current="step"]')).toHaveLength(0);
});
