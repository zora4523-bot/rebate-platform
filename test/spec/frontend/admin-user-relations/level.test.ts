// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CHANGE_REASON,
  DETAIL,
  LEVEL,
  VERIFY,
  createRelationsServer,
  failure,
} from './relations-fixtures.ts';
import { REASON_MAX, errorText } from './relations-contract.ts';
import {
  FLOW_TIMEOUT,
  SAVE,
  button,
  card,
  change,
  close,
  dialog,
  disabled,
  expectFieldError,
  fillChange,
  openChange,
  reasonInput,
  required,
  selectLevel,
  settled,
  show,
  startVerification,
  submitChange,
  verify,
} from './relations-helpers.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it(
  '[AC-F1-07g-LEVEL#8] 调等级网络异常用 message.error 且保留输入，不自动重发',
  async () => {
    const server = createRelationsServer();
    server.once('POST', LEVEL, () => Promise.reject(new TypeError('offline')));
    await show(server);
    const { modal } = await openChange('level');
    await fillChange('level', modal);
    await submitChange(modal);
    await waitFor(() =>
      expect(
        required(document.querySelector('.ant-message-error'), 'antd message.error').textContent,
      ).toMatch(/网络|失败|异常/),
    );
    const form = await dialog('调等级');
    expect(form.textContent).toContain('L3');
    expect(reasonInput(form).value).toBe(CHANGE_REASON);
    await settled(server);
    expect(server.requests('POST', LEVEL)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-LEVEL#9] 调等级 5xx 用 message.error 且保留输入，不自动重发',
  async () => {
    const server = createRelationsServer();
    server.once('POST', LEVEL, () => new Response('unavailable', { status: 503 }));
    await show(server);
    const { modal } = await openChange('level');
    await fillChange('level', modal);
    await submitChange(modal);
    await waitFor(() =>
      expect(
        required(document.querySelector('.ant-message-error'), 'antd message.error').textContent,
      ).toMatch(/服务|失败|异常/),
    );
    const form = await dialog('调等级');
    expect(form.textContent).toContain('L3');
    expect(reasonInput(form).value).toBe(CHANGE_REASON);
    await settled(server);
    expect(server.requests('POST', LEVEL)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-LEVEL#10] 动态码校验未通过不发送调等级请求',
  async () => {
    const server = createRelationsServer();
    server.once('POST', VERIFY, () => failure(20002));
    await show(server);
    const { modal } = await openChange('level');
    await fillChange('level', modal);
    await submitChange(modal);
    await settled(server);
    expect(await dialog('二次验证 · 动态码')).toBeDefined();
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    expect(server.requests('POST', LEVEL)).toEqual([]);
    expect(card('基本信息').textContent).toContain('L2');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-LEVEL#1] 空原因与全空白原因均不可提交，不请求动态码或写接口',
  async () => {
    const { server } = await show();
    const { modal } = await openChange('level');
    await selectLevel(modal);
    for (const reason of ['', '   \n  ']) {
      await change(reasonInput(modal), reason);
      await act(async () => {
        fireEvent.click(button(modal, SAVE));
      });
      await settled(server);
      expect(server.requests('POST')).toEqual([]);
      expect(screen.queryByRole('dialog', { name: '二次验证 · 动态码' })).toBeNull();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-LEVEL#2] 原因超过契约上限禁止提交，恰好上限可以验证并发送',
  async () => {
    const { server } = await show();
    const { modal } = await openChange('level');
    expect(REASON_MAX).toBeGreaterThan(0);
    await fillChange('level', modal, '理'.repeat(REASON_MAX + 1));
    await act(async () => {
      fireEvent.click(button(modal, SAVE));
    });
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    expect(screen.queryByRole('dialog', { name: '二次验证 · 动态码' })).toBeNull();
    await waitFor(() => expectFieldError(reasonInput(modal), String(REASON_MAX)));
    await change(reasonInput(modal), '理'.repeat(REASON_MAX));
    await submitChange(modal);
    await waitFor(() => expect(server.requests('POST', LEVEL)).toHaveLength(1));
    expect(server.requests('POST', LEVEL)[0]!.body).toEqual({
      level: 'L3',
      reason: '理'.repeat(REASON_MAX),
    });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-LEVEL#3] totp 后只发送一次契约请求，使用返回详情刷新等级、关闭并归还焦点',
  async () => {
    const { server, directFetch } = await show();
    const { trigger, modal } = await openChange('level');
    await fillChange('level', modal);
    const verification = await startVerification(modal);
    expect(server.requests('POST')).toEqual([]);
    await verify(verification, true);
    await waitFor(() => expect(card('基本信息').textContent).toContain('L3'));
    await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await settled(server);
    expect(server.requests('POST').map((request) => request.path)).toEqual([VERIFY, LEVEL]);
    expect(server.requests('POST', VERIFY)[0]!.body).toEqual({ tier: 'totp', code: '123456' });
    const request = server.requests('POST', LEVEL)[0]!;
    expect(request.body).toEqual({ level: 'L3', reason: CHANGE_REASON });
    expect(request.headers.get('X-Step-Up-Token')).toBe('test-totp-1');
    expect(request.headers.has('Idempotency-Key')).toBe(false);
    expect(request.query).toEqual({});
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-LEVEL#4] 写入在途时禁用提交，重复点击只产生一次写请求',
  async () => {
    const server = createRelationsServer();
    const release = server.hold('POST', LEVEL);
    try {
      await show(server);
      const { modal } = await openChange('level');
      await fillChange('level', modal);
      await verify(await startVerification(modal), true);
      await waitFor(() => expect(server.requests('POST', LEVEL)).toHaveLength(1));
      const submit = button(modal, SAVE);
      expect(disabled(submit)).toBe(true);
      await act(async () => {
        fireEvent.click(submit);
        fireEvent.click(submit);
      });
      expect(server.requests('POST', LEVEL)).toHaveLength(1);
    } finally {
      release();
    }
    await settled(server);
    expect(server.requests('POST', LEVEL)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-LEVEL#5] 20001 fields level 在选择旁提示并保留等级与原因',
  async () => {
    const server = createRelationsServer();
    server.once('POST', LEVEL, () => failure(20001, { fields: ['level'] }));
    await show(server);
    const { modal } = await openChange('level');
    await fillChange('level', modal);
    await submitChange(modal);
    const form = await dialog('调等级');
    await waitFor(() =>
      expectFieldError(form.querySelector('[role="combobox"]'), errorText(20001)),
    );
    expect(form.textContent).toContain('L3');
    expect(reasonInput(form).value).toBe(CHANGE_REASON);
    expect(card('基本信息').textContent).toContain('L2');
    expect(server.requests('POST', LEVEL)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-LEVEL#6] 10003 凭证失效后重新验证，验证前不重发，重发携带新 token',
  async () => {
    const server = createRelationsServer();
    server.once('POST', LEVEL, () => failure(10003, { tier: 'totp' }));
    await show(server);
    const { modal } = await openChange('level');
    await fillChange('level', modal);
    await submitChange(modal);
    const again = await dialog('二次验证 · 动态码');
    await settled(server);
    expect(server.requests('POST', LEVEL)).toHaveLength(1);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    await verify(again);
    await waitFor(() => expect(card('基本信息').textContent).toContain('L3'));
    expect(
      server.requests('POST', LEVEL).map((request) => request.headers.get('X-Step-Up-Token')),
    ).toEqual(['test-totp-1', 'test-totp-2']);
    expect(server.requests('POST', LEVEL).map((request) => request.body)).toEqual([
      { level: 'L3', reason: CHANGE_REASON },
      { level: 'L3', reason: CHANGE_REASON },
    ]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-LEVEL#7] 取消动态码不修改等级，关闭对话框回到触发按钮',
  async () => {
    const { server } = await show();
    const { trigger, modal } = await openChange('level');
    await fillChange('level', modal);
    await close(await startVerification(modal));
    const remaining = screen.queryByRole('dialog', { name: /调等级/ });
    if (remaining) await close(remaining);
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(card('基本信息').textContent).toContain('L2');
  },
  FLOW_TIMEOUT,
);
