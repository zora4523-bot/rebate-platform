// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DISABLE, ENABLE, LIST, TARGET, VERIFY, createServer, item, ok } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  SUPER,
  action,
  button,
  click,
  enabled,
  fill,
  loaded,
  mainElement,
  mount,
  row,
  settled,
  start,
  verify,
} from './helpers.ts';

it(
  '[AC-F1-10fa-CHANGE#1] 连续停用、启用各验证一次；带最新版本与选填原因，不带幂等头，成功按返回行更新',
  async () => {
    const server = createServer();
    server.once('POST', DISABLE, () => {
      Object.assign(server.state[0]!, {
        status: 'disabled',
        version: 19,
        name: '服务端返回的新规则名',
        updated_at: '2026-10-23T12:34:56+08:00',
      });
      return ok(server.state[0]);
    });
    await mount(server);
    const first = await start('disable', '复查后暂停观察');
    expect(server.requests('POST', VERIFY)).toEqual([]);
    expect(server.writes()).toEqual([]);
    enabled(true);
    await verify(first);
    await waitFor(() => expect(row().textContent).toContain('服务端返回的新规则名'));
    enabled(false);
    expect(row().textContent).toContain('12:34:56');
    expect(server.requests('POST', DISABLE)[0]!.body).toEqual({
      expected_version: 7,
      reason: '复查后暂停观察',
    });
    await settled(server);
    const second = await start('enable');
    // A previous proof must not silently authorize another action.
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    expect(server.writes()).toHaveLength(1);
    await verify(second);
    await waitFor(() => {
      expect(server.requests('POST', ENABLE)).toHaveLength(1);
      enabled(true);
    });
    await settled(server);
    expect(server.requests('POST', ENABLE)[0]!.body).toEqual({ expected_version: 19 });
    expect(server.requests('POST', VERIFY).map((request) => request.body)).toEqual([
      { tier: 'totp', code: '123456' },
      { tier: 'totp', code: '123456' },
    ]);
    expect(server.writes().map((request) => request.headers.get('X-Step-Up-Token'))).toEqual([
      'test-totp-1',
      'test-totp-2',
    ]);
    expect(server.writes().every((request) => !request.headers.has('Idempotency-Key'))).toBe(true);
    expect(server.writes().map((request) => request.path)).toEqual([DISABLE, ENABLE]);
    expect(server.requests('GET', LIST)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10fa-CHANGE#2] 超管从 version=0 启用仍必须动态码，允许正好 200 字的原因',
  async () => {
    const server = createServer([item({ status: 'disabled', version: 0 })]);
    await mount(server, SUPER);
    const reason = '核'.repeat(200);
    const modal = await start('enable', reason);
    expect(server.writes()).toEqual([]);
    await verify(modal);
    await waitFor(() => {
      expect(server.requests('POST', ENABLE)).toHaveLength(1);
      enabled(true);
    });
    expect(server.requests('POST', ENABLE)[0]!.body).toEqual({ expected_version: 0, reason });
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it('[AC-F1-10fa-CHANGE#3] 超过 200 字不能发送违规 reason；可限制输入或提示校验错误', async () => {
  const { server } = await mount();
  await loaded();
  await click(action('disable'));
  await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(1));
  const modal = screen.getByRole('dialog');
  const input = within(modal).queryByRole('textbox', { name: /原因|理由|备注/ });
  expect(input).not.toBeNull();
  if ((input as HTMLInputElement).maxLength === 200) {
    expect((input as HTMLInputElement).maxLength).toBe(200);
  } else {
    await fill(input!, '核'.repeat(201));
    await click(button(modal, /确认|验证并|继续/));
    await waitFor(() => expect(modal.textContent).toMatch(/200|过长|长度/));
    expect(screen.queryByLabelText('动态码', { exact: true })).toBeNull();
  }
  expect(server.writes()).toEqual([]);
  expect(server.requests('POST', VERIFY)).toEqual([]);
});

it.each(['enable', 'disable'] as const)(
  '[AC-F1-10fa-CHANGE#4] %s 返回目标状态且版本未增加也视为成功，下一次使用服务端原版本',
  async (operation) => {
    const initiallyEnabled = operation === 'disable';
    const server = createServer([item({ status: initiallyEnabled ? 'enabled' : 'disabled' })]);
    const path = `${LIST}/${TARGET}/${operation}`;
    // Model an idempotent success response at the client boundary: the server is already at
    // the target state. The client must not require version+1 or invent a newer version.
    server.once('POST', path, () => {
      server.state[0]!.status = initiallyEnabled ? 'disabled' : 'enabled';
      return ok(server.state[0]);
    });
    await mount(server);
    await verify(await start(operation));
    await waitFor(() => {
      expect(server.requests('POST', path)).toHaveLength(1);
      enabled(!initiallyEnabled);
    });
    await settled(server);
    expect(
      screen
        .queryAllByRole('alert')
        .some((node) => /失败|冲突|已被.*修改/.test(node.textContent ?? '')),
    ).toBe(false);
    await verify(await start(initiallyEnabled ? 'enable' : 'disable'));
    await waitFor(() => expect(server.writes()).toHaveLength(2));
    await settled(server);
    enabled(initiallyEnabled);
    expect(server.writes()[1]!.body).toEqual({ expected_version: 7 });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10fa-CHANGE#5] 取消动态码不写入、不乐观改状态，下一次操作仍需验证',
  async () => {
    const { server } = await mount();
    const modal = await start();
    await click(button(modal, /取消|关闭/));
    await settled(server);
    enabled(true);
    expect(server.writes()).toEqual([]);
    expect(server.requests('POST', VERIFY)).toEqual([]);
    expect(within(mainElement()).queryByText(TARGET, { exact: true })).not.toBeNull();
    expect(await start()).toBeDefined();
    expect(server.writes()).toEqual([]);
  },
  FLOW_TIMEOUT,
);
