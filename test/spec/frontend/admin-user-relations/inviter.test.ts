// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CHANGE_REASON,
  DETAIL,
  INVITER,
  NEW_PARENT,
  PARENT,
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
  click,
  close,
  dialog,
  disabled,
  expectFieldError,
  fillChange,
  inviterInput,
  openChange,
  reasonInput,
  required,
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
  '[AC-F1-07g-INVITER#11] 动态码校验未通过不发送改上级请求',
  async () => {
    const server = createRelationsServer();
    server.once('POST', VERIFY, () => failure(20002));
    await show(server);
    const { modal } = await openChange('inviter');
    await fillChange('inviter', modal);
    await submitChange(modal);
    await settled(server);
    expect(await dialog('二次验证 · 动态码')).toBeDefined();
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    expect(server.requests('POST', INVITER)).toEqual([]);
    expect(card('上级与直推').textContent).toContain(PARENT);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-INVITER#12] 取消动态码不改上级，关闭后归还焦点',
  async () => {
    const { server } = await show();
    const { trigger, modal } = await openChange('inviter');
    await fillChange('inviter', modal);
    await close(await startVerification(modal));
    const remaining = screen.queryByRole('dialog', { name: /改上级/ });
    if (remaining) await close(remaining);
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(card('上级与直推').textContent).toContain(PARENT);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-INVITER#1] 原因不能为空、空白或超过契约上限，均不验证不提交',
  async () => {
    const { server } = await show();
    const { modal } = await openChange('inviter');
    expect(REASON_MAX).toBeGreaterThan(0);
    await fillChange('inviter', modal);
    for (const value of ['', '  \n ', '理'.repeat(REASON_MAX + 1)]) {
      await change(reasonInput(modal), value);
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
  '[AC-F1-07g-INVITER#2] 改上级经动态码一次提交，详情用返回值刷新并关闭、归还焦点',
  async () => {
    const { server, directFetch } = await show();
    const { trigger, modal } = await openChange('inviter');
    await fillChange('inviter', modal);
    const verification = await startVerification(modal);
    expect(server.requests('POST')).toEqual([]);
    await verify(verification, true);
    await waitFor(() => expect(card('上级与直推').textContent).toContain(NEW_PARENT));
    expect(card('上级与直推').textContent).not.toContain(PARENT);
    await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await settled(server);
    expect(server.requests('POST').map((request) => request.path)).toEqual([VERIFY, INVITER]);
    expect(server.requests('POST', VERIFY)[0]!.body).toEqual({ tier: 'totp', code: '123456' });
    const request = server.requests('POST', INVITER)[0]!;
    expect(request.body).toEqual({ inviter_user_id: NEW_PARENT, reason: CHANGE_REASON });
    expect(request.headers.get('X-Step-Up-Token')).toBe('test-totp-1');
    expect(request.headers.has('Idempotency-Key')).toBe(false);
    expect(request.query).toEqual({});
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-INVITER#3] 解绑发送 null，恰好原因上限可提交，返回后显示无上级',
  async () => {
    const { server } = await show();
    const { modal } = await openChange('inviter');
    await fillChange('inviter', modal, '理'.repeat(REASON_MAX));
    await click(required(within(modal).queryByRole('radio', { name: /解绑/ }), 'unbind option'));
    await submitChange(modal);
    await waitFor(() => expect(server.requests('POST', INVITER)).toHaveLength(1));
    expect(server.requests('POST', INVITER)[0]!.body).toEqual({
      inviter_user_id: null,
      reason: '理'.repeat(REASON_MAX),
    });
    await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0));
    expect(card('上级与直推').textContent).not.toContain(PARENT);
    expect(card('上级与直推').textContent).toMatch(/—|无上级|暂无上级/);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-INVITER#4] 30409 只保留原因说明且不可再次提交，关闭再开仍为说明',
  async () => {
    const server = createRelationsServer();
    server.once('POST', INVITER, () => failure(30409));
    await show(server);
    const { trigger, modal } = await openChange('inviter');
    await fillChange('inviter', modal);
    await submitChange(modal);
    const explanation = await dialog('改上级');
    await waitFor(() => expect(explanation.textContent).toContain(errorText(30409)));
    expect(within(explanation).queryAllByRole('textbox')).toEqual([]);
    for (const submit of within(explanation).queryAllByRole('button', { name: SAVE })) {
      expect(disabled(submit)).toBe(true);
      await click(submit);
    }
    await close(explanation);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await click(trigger);
    const reopened = await dialog('改上级');
    expect(reopened.textContent).toContain(errorText(30409));
    expect(within(reopened).queryAllByRole('textbox')).toEqual([]);
    for (const submit of within(reopened).queryAllByRole('button', { name: SAVE })) {
      expect(disabled(submit)).toBe(true);
      await click(submit);
    }
    await settled(server);
    expect(server.requests('POST', INVITER)).toHaveLength(1);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    expect(card('上级与直推').textContent).toContain(PARENT);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-INVITER#5] 30401 在新上级输入旁显示契约提示并保留输入',
  async () => {
    const server = createRelationsServer();
    server.once('POST', INVITER, () => failure(30401));
    await show(server);
    const { modal } = await openChange('inviter');
    await fillChange('inviter', modal);
    await submitChange(modal);
    const form = await dialog('改上级');
    await waitFor(() => expectFieldError(inviterInput(form), errorText(30401)));
    expect(inviterInput(form).value).toBe(NEW_PARENT);
    expect(reasonInput(form).value).toBe(CHANGE_REASON);
    expect(server.requests('POST', INVITER)).toHaveLength(1);
    expect(card('上级与直推').textContent).toContain(PARENT);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-INVITER#6] 30403 在新上级输入旁显示契约提示并保留输入',
  async () => {
    const server = createRelationsServer();
    server.once('POST', INVITER, () => failure(30403));
    await show(server);
    const { modal } = await openChange('inviter');
    await fillChange('inviter', modal);
    await submitChange(modal);
    const form = await dialog('改上级');
    await waitFor(() => expectFieldError(inviterInput(form), errorText(30403)));
    expect(inviterInput(form).value).toBe(NEW_PARENT);
    expect(reasonInput(form).value).toBe(CHANGE_REASON);
    expect(server.requests('POST', INVITER)).toHaveLength(1);
    expect(card('上级与直推').textContent).toContain(PARENT);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-INVITER#7] 网络失败使用 message.error，输入保留且不自动重发',
  async () => {
    const server = createRelationsServer();
    server.once('POST', INVITER, () => Promise.reject(new TypeError('offline')));
    await show(server);
    const { modal } = await openChange('inviter');
    await fillChange('inviter', modal);
    await submitChange(modal);
    await waitFor(() =>
      expect(
        required(document.querySelector('.ant-message-error'), 'antd message.error').textContent,
      ).toMatch(/网络|失败|异常/),
    );
    const form = await dialog('改上级');
    expect(inviterInput(form).value).toBe(NEW_PARENT);
    expect(reasonInput(form).value).toBe(CHANGE_REASON);
    await settled(server);
    expect(server.requests('POST', INVITER)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-INVITER#8] 5xx 使用 message.error，输入保留且不自动重发',
  async () => {
    const server = createRelationsServer();
    server.once('POST', INVITER, () => new Response('unavailable', { status: 503 }));
    await show(server);
    const { modal } = await openChange('inviter');
    await fillChange('inviter', modal);
    await submitChange(modal);
    await waitFor(() =>
      expect(
        required(document.querySelector('.ant-message-error'), 'antd message.error').textContent,
      ).toMatch(/服务|失败|异常/),
    );
    const form = await dialog('改上级');
    expect(inviterInput(form).value).toBe(NEW_PARENT);
    expect(reasonInput(form).value).toBe(CHANGE_REASON);
    await settled(server);
    expect(server.requests('POST', INVITER)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-INVITER#9] 改上级请求在途时禁用按钮，重复点击不重复写入',
  async () => {
    const server = createRelationsServer();
    const release = server.hold('POST', INVITER);
    try {
      await show(server);
      const { modal } = await openChange('inviter');
      await fillChange('inviter', modal);
      await verify(await startVerification(modal), true);
      await waitFor(() => expect(server.requests('POST', INVITER)).toHaveLength(1));
      const submit = button(modal, SAVE);
      expect(disabled(submit)).toBe(true);
      await act(async () => {
        fireEvent.click(submit);
        fireEvent.click(submit);
      });
      expect(server.requests('POST', INVITER)).toHaveLength(1);
    } finally {
      release();
    }
    await settled(server);
    expect(server.requests('POST', INVITER)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-INVITER#10] 动态码失效重新验证后才重发，使用新凭证与原请求体',
  async () => {
    const server = createRelationsServer();
    server.once('POST', INVITER, () => failure(10003, { tier: 'totp' }));
    await show(server);
    const { modal } = await openChange('inviter');
    await fillChange('inviter', modal);
    await submitChange(modal);
    const again = await dialog('二次验证 · 动态码');
    await settled(server);
    expect(server.requests('POST', INVITER)).toHaveLength(1);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    await verify(again);
    await waitFor(() => expect(card('上级与直推').textContent).toContain(NEW_PARENT));
    expect(
      server.requests('POST', INVITER).map((request) => request.headers.get('X-Step-Up-Token')),
    ).toEqual(['test-totp-1', 'test-totp-2']);
    expect(server.requests('POST', INVITER).map((request) => request.body)).toEqual([
      { inviter_user_id: NEW_PARENT, reason: CHANGE_REASON },
      { inviter_user_id: NEW_PARENT, reason: CHANGE_REASON },
    ]);
  },
  FLOW_TIMEOUT,
);
