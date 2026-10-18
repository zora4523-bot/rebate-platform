// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PHONE, REASON, REVEAL, VERIFY, UID, PARENT, createServer, failure } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  backToList,
  button,
  click,
  detailLoaded,
  dialog,
  loaded,
  mainElement,
  mount,
  openDetail,
  settled,
  startReveal,
  verify,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it(
  '[AC-F1-07i-REVEAL#10] 切换到上级详情时清除当前用户完整手机号',
  async () => {
    const { server } = await mount();
    await openDetail();
    await detailLoaded();
    await verify(await startReveal());
    await waitFor(() => expect(mainElement().textContent).toContain(PHONE));
    // F1-07k: the title row may repeat a UID; click the inviter link itself.
    const parentLink = within(mainElement())
      .getAllByText(PARENT, { exact: true })
      .find((node) => node.closest('button, a') !== null);
    expect(parentLink, 'inviter link').toBeDefined();
    await click(parentLink!);
    await detailLoaded('P3RT8N');
    expect(mainElement().textContent).not.toContain(PHONE);
    expect(server.requests('POST', REVEAL)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07i-REVEAL#11] 动态码验证失败时保留弹窗，不发送 reveal',
  async () => {
    const server = createServer();
    server.once('POST', VERIFY, () => failure(20002));
    await mount(server);
    await openDetail();
    await detailLoaded();
    await verify(await startReveal());
    await waitFor(() => expect(screen.queryByText('验证码错误，请重新输入')).not.toBeNull());
    expect(await dialog('二次验证 · 动态码')).toBeDefined();
    expect(server.requests('POST', REVEAL)).toEqual([]);
    expect(mainElement().textContent).not.toContain(PHONE);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07i-REVEAL#1] 查看经 totp 验证后仅 POST 一次，携带 token、field 与查看原因',
  async () => {
    const { server, directFetch } = await mount();
    await openDetail();
    await detailLoaded();
    const modal = await startReveal();
    expect(server.requests('POST')).toEqual([]);
    await verify(modal);
    await waitFor(() => expect(mainElement().textContent).toContain(PHONE));
    await settled(server);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    expect(server.requests('POST', VERIFY)[0]!.body).toEqual({ tier: 'totp', code: '123456' });
    expect(server.requests('POST', REVEAL)).toHaveLength(1);
    const request = server.requests('POST', REVEAL)[0]!;
    expect(request.body).toEqual({ field: 'phone', reason: REASON });
    expect(request.headers.get('X-Step-Up-Token')).toBe('test-totp-1');
    expect(request.headers.has('Idempotency-Key')).toBe(false);
    expect(request.query).toEqual({});
    expect(server.requests('POST').map((entry) => entry.path)).toEqual([VERIFY, REVEAL]);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it.each(['reason', 'totp'])(
  '[AC-F1-07i-REVEAL#2] 取消 $0 步骤不验证、不 reveal',
  async (stage) => {
    const { server } = await mount();
    await openDetail();
    await detailLoaded();
    if (stage === 'totp') await startReveal();
    else await click(button(mainElement(), /^查看(?:完整手机号)?$/));
    await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(1));
    await click(button(screen.getByRole('dialog'), '取消'));
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    expect(mainElement().textContent).not.toContain(PHONE);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07i-REVEAL#3] 二次验证进行中取消，迟到 token 不触发 reveal',
  async () => {
    const server = createServer();
    const release = server.hold('POST', VERIFY);
    try {
      await mount(server);
      await openDetail();
      await detailLoaded();
      const modal = await startReveal();
      await verify(modal);
      await waitFor(() => expect(server.requests('POST', VERIFY)).toHaveLength(1));
      await click(button(modal, '取消'));
    } finally {
      release();
    }
    await settled(server);
    expect(server.requests('POST', REVEAL)).toEqual([]);
    expect(mainElement().textContent).not.toContain(PHONE);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07i-REVEAL#4] 双击验证并继续只发送一次验证与一次 reveal',
  async () => {
    const server = createServer();
    const release = server.hold('POST', REVEAL);
    try {
      await mount(server);
      await openDetail();
      await detailLoaded();
      await verify(await startReveal(), true);
      await waitFor(() => expect(server.requests('POST', REVEAL)).toHaveLength(1));
      expect(server.requests('POST', VERIFY)).toHaveLength(1);
    } finally {
      release();
    }
    await waitFor(() => expect(mainElement().textContent).toContain(PHONE));
    await settled(server);
    expect(server.requests('POST', REVEAL)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07i-REVEAL#5] 10003 重新打开 totp 验证，新的 token 到达后才再次 reveal',
  async () => {
    const server = createServer();
    server.once('POST', REVEAL, () => failure(10003, { tier: 'totp' }));
    await mount(server);
    await openDetail();
    await detailLoaded();
    await verify(await startReveal());
    await waitFor(() => expect(server.requests('POST', REVEAL)).toHaveLength(1));
    const modal = await dialog('二次验证 · 动态码');
    await settled(server);
    expect(mainElement().textContent).not.toContain(PHONE);
    expect(server.requests('POST', REVEAL)).toHaveLength(1);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    await verify(modal);
    await waitFor(() => expect(mainElement().textContent).toContain(PHONE));
    expect(
      server.requests('POST', REVEAL).map((request) => request.headers.get('X-Step-Up-Token')),
    ).toEqual(['test-totp-1', 'test-totp-2']);
    expect(server.requests('POST', REVEAL).map((request) => request.body)).toEqual([
      { field: 'phone', reason: REASON },
      { field: 'phone', reason: REASON },
    ]);
  },
  FLOW_TIMEOUT,
);

it.each([
  {
    label: '10403',
    reply: () => failure(10403, { reason: 'admin_permission_denied' }),
    pattern: /没有.*权限|无权限|权限不足/,
  },
  {
    label: '网络错误',
    reply: () => Promise.reject(new TypeError('offline')),
    pattern: /网络|失败/,
  },
  {
    label: '未绑定手机号',
    reply: () => failure(20001, { fields: ['field'] }),
    pattern: /未绑定|没有.*手机号|无.*手机号|没有.*可.*查看/,
  },
])(
  '[AC-F1-07i-REVEAL#6] $label 对应提示，不显示完整号也不自动重发',
  async ({ reply, pattern }) => {
    const server = createServer();
    server.once('POST', REVEAL, reply);
    await mount(server);
    await openDetail();
    await detailLoaded();
    await verify(await startReveal());
    await waitFor(() =>
      expect(
        screen.queryAllByRole('alert').some((node) => pattern.test(node.textContent ?? '')),
      ).toBe(true),
    );
    await settled(server);
    expect(mainElement().textContent).not.toContain(PHONE);
    expect(mainElement().textContent).toContain('138****5678');
    expect(server.requests('POST', REVEAL)).toHaveLength(1);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07i-REVEAL#7] 完整手机号不落存储或 URL，离开详情再进入必须重新查看',
  async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    const { server } = await mount();
    await openDetail();
    await detailLoaded();
    await verify(await startReveal());
    await waitFor(() => expect(mainElement().textContent).toContain(PHONE));
    expect(JSON.stringify(storage.mock.calls)).not.toContain(PHONE);
    expect(JSON.stringify(push.mock.calls)).not.toContain(PHONE);
    expect(JSON.stringify(replace.mock.calls)).not.toContain(PHONE);
    expect(JSON.stringify(localStorage)).not.toContain(PHONE);
    expect(JSON.stringify(sessionStorage)).not.toContain(PHONE);
    expect(window.location.href).not.toContain(PHONE);
    for (const link of mainElement().querySelectorAll('a')) expect(link.href).not.toContain(PHONE);
    await backToList();
    await loaded(UID);
    expect(mainElement().textContent).not.toContain(PHONE);
    await openDetail();
    await detailLoaded();
    expect(mainElement().textContent).not.toContain(PHONE);
    expect(mainElement().textContent).toContain('138****5678');
    expect(server.requests('POST', REVEAL)).toHaveLength(1);
    await verify(await startReveal());
    await waitFor(() => expect(mainElement().textContent).toContain(PHONE));
    expect(server.requests('POST', REVEAL)).toHaveLength(2);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07i-REVEAL#8] 离开详情后收到迟到 reveal 不显示也不污染再次进入的视图',
  async () => {
    const server = createServer();
    const release = server.hold('POST', REVEAL);
    try {
      await mount(server);
      await openDetail();
      await detailLoaded();
      await verify(await startReveal());
      await waitFor(() => expect(server.requests('POST', REVEAL)).toHaveLength(1));
      await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0));
      await backToList();
      await loaded();
    } finally {
      release();
    }
    await settled(server);
    expect(mainElement().textContent).not.toContain(PHONE);
    await openDetail();
    await detailLoaded();
    expect(mainElement().textContent).not.toContain(PHONE);
    expect(server.requests('POST', REVEAL)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it.each(['', 'x'.repeat(201)])(
  '[AC-F1-07i-REVEAL#9] 查看原因长度不合法时不能提交敏感信息请求（%s）',
  async (reason) => {
    const { server } = await mount();
    await openDetail();
    await detailLoaded();
    await click(button(mainElement(), /^查看(?:完整手机号)?$/));
    await waitFor(() => expect(screen.queryAllByRole('textbox', { name: /原因/ })).toHaveLength(1));
    const input = screen.getByRole('textbox', { name: /原因/ });
    await act(async () => {
      fireEvent.change(input, { target: { value: reason } });
    });
    const scope = input.closest<HTMLElement>('[role="dialog"]') ?? mainElement();
    await click(button(scope, /^(验证并查看|确认|继续|下一步|验证并继续)$/));
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    expect(within(document.body).queryByRole('dialog', { name: '二次验证 · 动态码' })).toBeNull();
    expect(
      input.getAttribute('aria-invalid') === 'true' ||
        /原因|200|必填/.test(scope.textContent ?? ''),
    ).toBe(true);
  },
  FLOW_TIMEOUT,
);
