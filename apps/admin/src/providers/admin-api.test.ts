// Package tests for createAdminApi (F1-06zb): only HTTP 200 with code 0 extends the idle period
// (BR-ID-34), the data provider carries the guard's token, 20001 on the password step keeps the
// server's fields, and loadPermissions refuses without a session.
import { afterEach, expect, it, vi } from 'vitest';
import { createAdminApi, type AdminApi } from './admin-api.ts';

const BASE_URL = 'https://admin.example.test';
const NOW = Date.parse('2026-10-07T10:00:00+08:00');
const IDLE_SEC = 1800;
const SESSION = {
  admin_token: 'example-admin-token',
  expires_at: '2026-10-07T18:00:00+08:00',
  idle_timeout_sec: IDLE_SEC,
};
const ME = {
  admin_id: 'a',
  username: 'ops-yi',
  is_super: false,
  permissions: [],
};

function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: 't' });
}

function rejected(status: number, code: number, data?: unknown): Response {
  return Response.json(
    { code, msg: 'server', ...(data === undefined ? {} : { data }), trace_id: 't' },
    { status },
  );
}

const apis: AdminApi[] = [];
afterEach(() => {
  for (const api of apis.splice(0)) api.auth.dispose();
});

function setup(options: { next?: 'totp' | 'change_password'; list?: () => Response } = {}) {
  const calls: { path: string; authorization: string | null }[] = [];
  const values = new Map<string, string>();
  let now = NOW;
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    calls.push({ path, authorization: request.headers.get('Authorization') });
    switch (path) {
      case '/admin/v1/auth/login':
        return Promise.resolve(
          ok({
            next: options.next ?? 'totp',
            login_ticket: 'ticket-1',
            ticket_expires_at: SESSION.expires_at,
          }),
        );
      case '/admin/v1/auth/password':
        return Promise.resolve(rejected(400, 20001, { fields: ['new_password'] }));
      case '/admin/v1/auth/totp':
        return Promise.resolve(ok(SESSION));
      case '/admin/v1/me/permissions':
        return Promise.resolve(ok(ME));
      case '/admin/v1/admins':
        return Promise.resolve(options.list?.() ?? ok({ items: [], total: 0 }));
      default:
        return Promise.resolve(ok({}));
    }
  });
  const api = createAdminApi({
    baseUrl: BASE_URL,
    fetch,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    },
    clock: { now: () => now },
    manualStart: true,
  });
  apis.push(api);
  return {
    api,
    calls,
    advance(ms: number) {
      now += ms;
    },
  };
}

async function signIn(api: AdminApi): Promise<void> {
  await api.auth.login({ step: 'credentials', username: 'ops-yi', password: 'pw' });
  await api.auth.login({ step: 'totp', code: '123456' });
  expect(api.auth.getToken()).toBe(SESSION.admin_token);
}

const LIST = { resource: 'admins', pagination: { currentPage: 1, pageSize: 20 } } as const;

it('a successful data request (HTTP 200, code 0) extends the idle period', async () => {
  const { api, calls, advance } = setup();
  await signIn(api);
  advance((IDLE_SEC - 100) * 1000);
  await expect(api.data.getList(LIST)).resolves.toEqual({ data: [], total: 0 });
  expect(calls.at(-1)).toEqual({
    path: '/admin/v1/admins',
    authorization: `Bearer ${SESSION.admin_token}`,
  });
  advance(200 * 1000);
  expect(api.auth.getToken()).toBe(SESSION.admin_token);
});

it('a refused data request (10403) does not extend the idle period and keeps the session', async () => {
  const { api, advance } = setup({
    list: () => rejected(403, 10403, { reason: 'admin_permission_denied' }),
  });
  await signIn(api);
  advance((IDLE_SEC - 100) * 1000);
  await expect(api.data.getList(LIST)).rejects.toMatchObject({ code: 10403, httpStatus: 403 });
  expect(api.auth.getToken()).toBe(SESSION.admin_token);
  advance(200 * 1000);
  expect(api.auth.getToken()).toBeNull();
});

it('HTTP 200 with a non-zero code does not extend the idle period', async () => {
  const { api, advance } = setup({
    list: () => Response.json({ code: 20001, msg: 'x', data: { fields: ['page'] } }),
  });
  await signIn(api);
  advance((IDLE_SEC - 100) * 1000);
  await expect(api.data.getList(LIST)).rejects.toMatchObject({ code: 20001 });
  advance(200 * 1000);
  expect(api.auth.getToken()).toBeNull();
});

it('10001 on a data request ends the session through the guard', async () => {
  const { api } = setup({ list: () => rejected(401, 10001) });
  await signIn(api);
  await expect(api.data.getList(LIST)).rejects.toMatchObject({ code: 10001 });
  expect(api.auth.getToken()).toBeNull();
  await expect(api.loadPermissions()).rejects.toBeInstanceOf(Error);
});

it('20001 on the password step keeps the fields the server named and stays on that step', async () => {
  const { api } = setup({ next: 'change_password' });
  await api.auth.login({ step: 'credentials', username: 'ops-yi', password: 'pw' });
  expect(api.auth.getSnapshot().step).toBe('change_password');
  expect(await api.auth.login({ step: 'change_password', newPassword: 'short' })).toMatchObject({
    success: false,
  });
  expect(api.auth.getSnapshot()).toMatchObject({
    step: 'change_password',
    error: { key: 'error.20001', fields: ['new_password'] },
  });
});

it('loadPermissions reads /me/permissions every time and returns the account name', async () => {
  const { api, calls } = setup();
  await expect(api.loadPermissions()).rejects.toBeInstanceOf(Error);
  await signIn(api);
  await expect(api.loadPermissions()).resolves.toEqual({
    username: 'ops-yi',
    snapshot: { isSuper: false, permissions: [], stepUp: {} },
  });
  await api.loadPermissions();
  expect(calls.filter((call) => call.path === '/admin/v1/me/permissions')).toHaveLength(2);
});
