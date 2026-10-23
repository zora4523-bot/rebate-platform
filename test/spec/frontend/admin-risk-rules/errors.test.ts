// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DISABLE, ENABLE, LIST, TARGET, VERIFY, createServer, failure } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  button,
  click,
  closeNoticeDialog,
  dialog,
  enabled,
  loaded,
  mainElement,
  mount,
  notice,
  row,
  settled,
  start,
  verify,
} from './helpers.ts';

it(
  '[AC-F1-10fa-ERROR#1] 20902 risk_rule 提示刷新并重读，不盲目重发；下一次带刷新后的版本',
  async () => {
    const server = createServer();
    server.once('POST', DISABLE, () => {
      Object.assign(server.state[0]!, {
        status: 'disabled',
        version: 31,
        name: '另一运营修改后的规则',
      });
      return failure(20902, { resource: 'risk_rule' });
    });
    await mount(server);
    await verify(await start());
    await notice(/已被他人修改.*刷新.*重试/);
    await waitFor(() => expect(row().textContent).toContain('另一运营修改后的规则'));
    enabled(false);
    await settled(server);
    expect(server.requests('GET', LIST)).toHaveLength(2);
    expect(server.writes()).toHaveLength(1);
    await closeNoticeDialog();
    await verify(await start('enable'));
    await waitFor(() => {
      expect(server.requests('POST', ENABLE)).toHaveLength(1);
      enabled(true);
    });
    expect(server.requests('POST', ENABLE)[0]!.body).toEqual({ expected_version: 31 });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10fa-ERROR#2] 冲突后的重读失败清除旧行，重试失败仍不展示旧数据',
  async () => {
    const server = createServer();
    await mount(server);
    await loaded();
    server.once('POST', DISABLE, () => failure(20902, { resource: 'risk_rule' }));
    server.once('GET', LIST, () => failure(50000));
    server.once('GET', LIST, () => Promise.reject(new TypeError('offline')));
    await verify(await start());
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(2));
    await settled(server);
    expect(within(mainElement()).queryByText(TARGET, { exact: true })).toBeNull();
    expect(mainElement().textContent).toMatch(/失败|网络/);
    await closeNoticeDialog();
    await click(button(mainElement(), /重试|重新加载|重新读取/));
    await settled(server);
    expect(server.requests('GET', LIST)).toHaveLength(3);
    expect(within(mainElement()).queryByText(TARGET, { exact: true })).toBeNull();
    expect(mainElement().textContent).toMatch(/失败|网络/);
    expect(server.writes()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10fa-ERROR#3] 20001 fields=[rule_id] 提示规则不存在并刷新，删除过期行',
  async () => {
    const server = createServer();
    server.once('POST', DISABLE, () => {
      server.state.splice(0, 1);
      return failure(20001, { fields: ['rule_id'] });
    });
    await mount(server);
    await verify(await start());
    await notice(/规则.*不存在|不存在.*规则/);
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(2));
    await settled(server);
    expect(within(mainElement()).queryByText(TARGET, { exact: true })).toBeNull();
    expect(row('inv_08_self').textContent).toContain('开放场景规则');
    expect(server.writes()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it.each(['enable', 'disable'] as const)(
  '[AC-F1-10fa-ERROR#4] %s 收到 10003 totp 不复用旧凭据，重新验证后才发相同请求',
  async (operation) => {
    const server = createServer();
    server.state[0]!.status = operation === 'enable' ? 'disabled' : 'enabled';
    const path = operation === 'enable' ? ENABLE : DISABLE;
    server.once('POST', path, () => failure(10003, { tier: 'totp' }));
    await mount(server);
    await verify(await start(operation, '保留本次原因'));
    await waitFor(() => expect(server.requests('POST', path)).toHaveLength(1));
    await settled(server);
    enabled(operation === 'disable', TARGET, true);
    const modal = await dialog('二次验证 · 动态码');
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    expect(server.writes()).toHaveLength(1);
    await verify(modal);
    await waitFor(() => {
      expect(server.requests('POST', path)).toHaveLength(2);
      enabled(operation === 'enable');
    });
    expect(server.writes().map((request) => request.headers.get('X-Step-Up-Token'))).toEqual([
      'test-totp-1',
      'test-totp-2',
    ]);
    expect(server.writes().map((request) => request.body)).toEqual([
      { expected_version: 7, reason: '保留本次原因' },
      { expected_version: 7, reason: '保留本次原因' },
    ]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10fa-ERROR#5] 写入 10403 明确无权限，不把它当动态码过期再次验证',
  async () => {
    const server = createServer();
    server.once('POST', DISABLE, () => failure(10403, { reason: 'admin_permission_denied' }));
    await mount(server);
    await verify(await start());
    await notice(/无权限|没有.*权限|权限不足/);
    await settled(server);
    expect(server.writes()).toHaveLength(1);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    expect(screen.queryByLabelText('动态码', { exact: true })).toBeNull();
    // An implementation may keep the unchanged row or clear it on lost permission.
    if (within(mainElement()).queryByText(TARGET, { exact: true })) enabled(true);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10fa-ERROR#6] 动态码错误不发启停，原状态不变且保留验证提示',
  async () => {
    const server = createServer();
    server.once('POST', VERIFY, () => failure(20002));
    await mount(server);
    await verify(await start());
    await waitFor(() => expect(screen.queryByText('验证码错误，请重新输入')).not.toBeNull());
    expect(await dialog('二次验证 · 动态码')).toBeDefined();
    enabled(true, TARGET, true);
    expect(server.writes()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10fa-ERROR#7] 启停网络失败显示错误，不宣称成功或自动重发',
  async () => {
    const server = createServer();
    server.once('POST', DISABLE, () => Promise.reject(new TypeError('offline')));
    await mount(server);
    await verify(await start());
    await notice(/失败|网络|未确认|未知/);
    await settled(server);
    expect(server.writes()).toHaveLength(1);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    if (within(mainElement()).queryByText(TARGET, { exact: true })) enabled(true);
  },
  FLOW_TIMEOUT,
);
