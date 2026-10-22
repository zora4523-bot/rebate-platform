// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CREDENTIAL,
  PHONES,
  PHONE,
  POLL,
  SECRET,
  START,
  createServer,
  failure,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  assertWrite,
  button,
  click,
  fill,
  mount,
  openAdd,
  openManual,
  openOAuth,
  openRemove,
  settle,
  stepUp,
  verify,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([
  { action: 'oauth', method: 'POST', path: START },
  { action: 'manual', method: 'PUT', path: CREDENTIAL },
  { action: 'add', method: 'POST', path: PHONES },
  { action: 'remove', method: 'DELETE', path: PHONES },
] as const)(
  '[AC-F1-10ga-STEPUP#1] $action 的 10003 totp 不自动重发；再次动态码后使用新 token',
  async ({ action, method, path }) => {
    const server = createServer();
    server.once(method, path, () => failure(10003, { tier: 'totp' }));
    // The test ends as soon as the re-verified write is observed; no external popup.
    vi.spyOn(window, 'open').mockReturnValue(null);
    await mount(server);
    const form =
      action === 'oauth'
        ? await openOAuth()
        : action === 'manual'
          ? await openManual()
          : action === 'add'
            ? await openAdd(server)
            : await openRemove(server);
    if (action === 'manual') await fill(within(form).getByLabelText(/^(?:新)?凭据$/), SECRET);
    if (action === 'add') await fill(within(form).getByLabelText(/^(?:告警)?手机号$/), PHONE);
    await verify(await stepUp(form));
    await waitFor(() => expect(server.requests(method, path)).toHaveLength(1));
    await settle();
    expect(server.requests('GET', POLL)).toEqual([]);
    // Permit the shared gate to reopen immediately or offer an explicit re-verification button.
    if (screen.queryByRole('dialog', { name: '二次验证 · 动态码' }) === null) {
      expect(document.body.textContent).toMatch(/动态码|二次验证|重新验证/);
      const current = screen.getAllByRole('dialog').at(-1)!;
      if (action === 'manual') await fill(within(current).getByLabelText(/^(?:新)?凭据$/), SECRET);
      await click(button(current, /重新验证|验证并|确认|提交|保存/));
    }
    const second = await screen.findByRole('dialog', { name: '二次验证 · 动态码' });
    expect(server.requests(method, path)).toHaveLength(1);
    await verify(second);
    await waitFor(() => expect(server.requests(method, path)).toHaveLength(2));
    assertWrite(server.requests(method, path)[0]!);
    assertWrite(server.requests(method, path)[1]!, 'test-totp-2');
  },
  FLOW_TIMEOUT,
);
