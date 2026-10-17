// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LIST, TARGET, VERIFY, createServer, failure } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  button,
  checked,
  click,
  dialog,
  mount,
  settled,
  stepUp,
  verify,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it(
  '[AC-F1-06zf-ERRORS#1] PUT 10003 不当成功，不带旧 token 自动重试，重新验证后才重放',
  async () => {
    const server = createServer();
    server.once('PUT', `${LIST}/${TARGET}`, () =>
      failure(10003, { tier: 'totp' }, '请完成二次验证'),
    );
    await mount(server);
    await verify(await stepUp());
    await waitFor(() => expect(server.requests('PUT')).toHaveLength(1));
    await settled(server);
    checked(TARGET, true);
    const modal = await dialog('二次验证 · 动态码');
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    expect(server.requests('PUT')).toHaveLength(1);
    await verify(modal);
    await waitFor(() => {
      expect(server.requests('PUT')).toHaveLength(2);
      checked(TARGET, false);
    });
    expect(server.requests('PUT').map((request) => request.headers.get('X-Step-Up-Token'))).toEqual(
      ['test-totp-1', 'test-totp-2'],
    );
    expect(server.requests('PUT')[1]!.body).toMatchObject({ value: false, expected_version: 3 });
  },
  FLOW_TIMEOUT,
);

it.each([
  {
    label: '10403',
    code: 10403,
    data: { reason: 'admin_permission_denied' },
    message: '没有操作权限',
    pattern: /没有.*权限|无权限|权限不足/,
  },
  {
    label: '20001 key',
    code: 20001,
    data: { fields: ['key'] },
    message: '参数错误',
    pattern: /开关.*(?:无效|不可|不允许|未登记|只读)|key/,
  },
  {
    label: '20001 value',
    code: 20001,
    data: { fields: ['value'] },
    message: '参数错误',
    pattern: /值.*(?:无效|不合法|错误|不允许)|value/,
  },
])(
  '[AC-F1-06zf-ERRORS#2] $label 显示对应错误，旧值不变且不盲目重试',
  async ({ code, data, message, pattern }) => {
    const server = createServer();
    server.once('PUT', `${LIST}/${TARGET}`, () => failure(code, data, message));
    await mount(server);
    await verify(await stepUp());
    await waitFor(() =>
      expect(
        screen.queryAllByRole('alert').some((alert) => pattern.test(alert.textContent ?? '')),
      ).toBe(true),
    );
    await settled(server);
    checked(TARGET, true);
    expect(server.requests('PUT')).toHaveLength(1);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zf-ERRORS#3] PUT 网络失败保留旧值并提示，不自动重发写操作',
  async () => {
    const server = createServer();
    server.once('PUT', `${LIST}/${TARGET}`, () => Promise.reject(new TypeError('offline')));
    await mount(server);
    await verify(await stepUp());
    await waitFor(() =>
      expect(
        screen.queryAllByRole('alert').some((alert) => /网络|失败/.test(alert.textContent ?? '')),
      ).toBe(true),
    );
    await settled(server);
    checked(TARGET, true);
    expect(server.requests('PUT')).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zf-ERRORS#4] 20902 提示冲突并重读，下一次显式修改携带刷新后的 version',
  async () => {
    const server = createServer();
    server.once('PUT', `${LIST}/${TARGET}`, () => {
      const entry = server.state.find((row) => row.key === TARGET)!;
      entry.value = false;
      entry.version = 12;
      return failure(20902, { resource: 'kill_switch' }, '状态已变化，请刷新后重试');
    });
    await mount(server);
    await verify(await stepUp());
    await waitFor(() =>
      expect(
        screen
          .queryAllByRole('alert')
          .some((alert) => /状态.*变化|冲突|已被.*修改/.test(alert.textContent ?? '')),
      ).toBe(true),
    );
    await waitFor(() => {
      expect(server.requests('GET', LIST).length).toBeGreaterThan(1);
      checked(TARGET, false);
    });
    await settled(server);
    expect(server.requests('PUT')).toHaveLength(1);
    // Clear any conflict dialog through its cancel/close button before a deliberate new action.
    const open = screen.queryByRole('dialog');
    if (open !== null) {
      await click(button(open, /取消|关闭/));
    }
    await verify(await stepUp());
    await waitFor(() => {
      expect(server.requests('PUT')).toHaveLength(2);
      checked(TARGET, true);
    });
    expect(server.requests('PUT')[1]!.body).toMatchObject({ value: true, expected_version: 12 });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zf-ERRORS#5] 动态码验证失败时保持弹窗、原值，不发送 PUT',
  async () => {
    const server = createServer();
    server.once('POST', VERIFY, () => failure(20002, null, '验证码错误'));
    await mount(server);
    await verify(await stepUp());
    await waitFor(() => expect(screen.queryByText('验证码错误，请重新输入')).not.toBeNull());
    expect(await dialog('二次验证 · 动态码')).toBeDefined();
    checked(TARGET, true);
    expect(server.requests('PUT')).toEqual([]);
  },
  FLOW_TIMEOUT,
);
