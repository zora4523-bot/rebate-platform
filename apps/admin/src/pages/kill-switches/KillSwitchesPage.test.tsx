import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createAdminShell } from '../../App.tsx';
import { AdminApiError, createDataProvider } from '../../providers/data/index.ts';
import { killSwitchesTexts as t } from '../../texts/kill-switches.ts';
import { KillSwitchesPage } from './KillSwitchesPage.tsx';
import { writeOutcomeUnknown, type SwitchRow } from './model.ts';

vi.setConfig({ testTimeout: 30_000 });

const KEY = 'payout.enabled';
const LIST = '/admin/v1/kill-switches';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function apiError(kind: 'api' | 'network' | 'parse' | 'http' | 'request', code: number) {
  return new AdminApiError({ kind, code, msg: '', data: null, httpStatus: 0 });
}

it('a write is unknown only when no refusal was read back', () => {
  expect(writeOutcomeUnknown(apiError('network', -1))).toBe(true);
  expect(writeOutcomeUnknown(apiError('parse', -2))).toBe(true);
  expect(writeOutcomeUnknown(apiError('http', -3))).toBe(true);
  expect(writeOutcomeUnknown(apiError('api', 50000))).toBe(true);
  expect(writeOutcomeUnknown(new Error('boom'))).toBe(true);
  expect(writeOutcomeUnknown(apiError('request', -4))).toBe(false);
  for (const code of [10003, 10403, 20001, 20902, 42901])
    expect(writeOutcomeUnknown(apiError('api', code))).toBe(false);
});

function row(value: boolean, version: number): SwitchRow {
  return {
    key: KEY,
    value,
    default: true,
    value_type: 'boolean',
    options: null,
    permissions: ['switch.all', 'switch.payout'],
    admin_editable: true,
    version,
    updated_by: 'ops-yi',
    updated_at: '2026-10-09T02:00:00Z',
  };
}

function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: 't' });
}

it('an unknown PUT result re-reads; if that read fails the row stays unconfirmed until a read succeeds', async () => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
  // Server side the change was applied (false, version 4) although the PUT answer was lost.
  const lists: (() => Promise<Response>)[] = [
    async () => ok({ items: [row(false, 3)], page: 1, page_size: 200, total: 1 }),
    () => Promise.reject(new TypeError('offline')),
    async () => ok({ items: [row(true, 4)], page: 1, page_size: 200, total: 1 }),
  ];
  const calls: { method: string; path: string }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, path: url.pathname });
    if (method === 'GET' && url.pathname === LIST) return lists.shift()!();
    if (method === 'POST')
      return Promise.resolve(
        ok({ step_up_token: 'token-1', tier: 'totp', expire_at: '2099-01-01T00:00:00Z' }),
      );
    return Promise.reject(new TypeError('connection reset'));
  };
  const dataProvider = createDataProvider({
    baseUrl: 'https://admin.example.test',
    fetch,
    getToken: () => 'admin-token',
    onError: () => {},
  });
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
        account: { username: 'ops-yi', displayName: 'ops-yi' },
        environment: 'test',
        onLogout: () => {},
        initialRoute: { menuId: 'switches' },
        dataProvider,
        renderPage: (_menu, access) => createElement(KillSwitchesPage, { access }),
      }),
    );
  });
  const control = () => screen.getByRole('switch', { name: KEY, hidden: true });
  await waitFor(() => expect(control().getAttribute('aria-checked')).toBe('false'));
  await act(async () => {
    fireEvent.click(control());
  });
  const confirmation = await screen.findByRole('dialog');
  await act(async () => {
    fireEvent.click(within(confirmation).getByRole('button', { name: /验证并/ }));
  });
  const verification = await screen.findByRole('dialog', { name: '二次验证 · 动态码' });
  await act(async () => {
    fireEvent.change(within(verification).getByLabelText('动态码', { exact: true }), {
      target: { value: '123456' },
    });
  });
  await act(async () => {
    fireEvent.click(within(verification).getByRole('button', { name: '验证并继续' }));
  });

  // PUT lost, re-read failed: unconfirmed, locked, and the PUT is not sent again.
  await waitFor(() => expect(screen.getAllByText(t.unconfirmed).length).toBeGreaterThan(0));
  expect(control().getAttribute('aria-checked')).toBe('false');
  expect((control() as HTMLButtonElement).disabled).toBe(true);
  expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: t.reload }));
  });
  await waitFor(() => expect(control().getAttribute('aria-checked')).toBe('true'));
  expect(screen.queryAllByText(t.unconfirmed)).toEqual([]);
  expect((control() as HTMLButtonElement).disabled).toBe(false);
  expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  expect(calls.filter((call) => call.method === 'GET')).toHaveLength(3);
});
