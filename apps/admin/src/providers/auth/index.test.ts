// Package tests for the review round 2 fixes (F1-06h): 20001 fields, binding-secret retry,
// session end on the done step, identity refresh, overlapping identity and logout calls.
import { afterEach, expect, it, vi } from 'vitest';
import { createAuthProvider, type AdminAuthProvider } from './index.ts';

const BASE_URL = 'https://admin.example.test';
const NOW = Date.parse('2026-10-07T10:00:00+08:00');
const SESSION = {
  admin_token: 'example-admin-token',
  expires_at: '2026-10-07T18:00:00+08:00',
  idle_timeout_sec: 1800,
};
const SECRET = { totp_secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/example' };
const ME = { admin_id: 'a', username: 'ops-yi', is_super: false, permissions: [] };

function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: 't' });
}

function rejected(code: number, data?: unknown): Response {
  return Response.json(
    { code, msg: 'server', ...(data === undefined ? {} : { data }), trace_id: 't' },
    { status: 400 },
  );
}

type Handler = () => Response | Promise<Response>;

function setup(next: 'totp' | 'change_password' | 'bind_totp' = 'totp') {
  const queues = new Map<string, Handler[]>();
  const calls: { path: string; body: unknown; authorization: string | null }[] = [];
  const values = new Map<string, string>();
  let now = NOW;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const raw = await request.text();
    calls.push({
      path,
      body: raw === '' ? undefined : JSON.parse(raw),
      authorization: request.headers.get('Authorization'),
    });
    const queued = queues.get(path)?.shift();
    if (queued !== undefined) return queued();
    switch (path) {
      case '/admin/v1/auth/login':
        return ok({ next, login_ticket: `ticket-${next}`, ticket_expires_at: SESSION.expires_at });
      case '/admin/v1/auth/password':
        return ok({ next: 'bind_totp', login_ticket: 'ticket-bind', ticket_expires_at: 'x' });
      case '/admin/v1/auth/totp/secret':
        return ok(SECRET);
      case '/admin/v1/auth/totp':
      case '/admin/v1/auth/totp/bind':
        return ok(SESSION);
      case '/admin/v1/me/permissions':
        return ok(ME);
      default:
        return ok({});
    }
  });
  const auth = createAuthProvider({
    api: { baseUrl: BASE_URL, fetch },
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    },
    clock: { now: () => now },
  });
  providers.push(auth);
  return {
    auth,
    calls,
    values,
    queue(path: string, handler: Handler) {
      queues.set(path, [...(queues.get(path) ?? []), handler]);
    },
    setNow(value: number) {
      now = value;
    },
  };
}

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const providers: AdminAuthProvider[] = [];
afterEach(() => {
  for (const auth of providers.splice(0)) auth.dispose();
  vi.useRealTimers();
});

const CREDENTIALS = { step: 'credentials', username: 'ops-yi', password: 'p' } as const;

it('20001 keeps data.fields for every step', async () => {
  const h = setup('change_password');
  h.queue('/admin/v1/auth/login', () => rejected(20001, { fields: ['username'] }));
  await h.auth.login(CREDENTIALS);
  expect(h.auth.getSnapshot().error).toEqual({ key: 'error.20001', fields: ['username'] });
  await h.auth.login(CREDENTIALS);
  h.queue('/admin/v1/auth/password', () => rejected(20001, { fields: ['new_password'] }));
  await h.auth.login({ step: 'change_password', newPassword: 'n' });
  expect(h.auth.getSnapshot()).toMatchObject({
    step: 'change_password',
    error: { key: 'error.20001', fields: ['new_password'] },
  });
});

it('a failed secret fetch after the password change stays on binding and retries the secret only', async () => {
  const h = setup('change_password');
  await h.auth.login(CREDENTIALS);
  h.queue('/admin/v1/auth/totp/secret', () => rejected(50001));
  const result = await h.auth.login({ step: 'change_password', newPassword: 'n' });
  expect(result.success).toBe(false);
  expect(h.auth.getSnapshot()).toMatchObject({ step: 'bind_totp', error: { key: 'error.5xxxx' } });
  expect(h.auth.getSnapshot().secret).toBeUndefined();
  expect((await h.auth.retryBindingSecret()).success).toBe(true);
  expect(h.auth.getSnapshot()).toMatchObject({ step: 'bind_totp', secret: SECRET });
  expect(h.auth.getSnapshot().error).toBeUndefined();
  expect(h.calls.filter((c) => c.path.endsWith('/auth/password'))).toHaveLength(1);
  expect(h.calls.filter((c) => c.path.endsWith('/totp/secret')).map((c) => c.body)).toEqual([
    { login_ticket: 'ticket-bind' },
    { login_ticket: 'ticket-bind' },
  ]);
  await h.auth.login({ step: 'bind_totp', code: '123456' });
  expect(h.auth.getSnapshot()).toMatchObject({ step: 'done', bound: true });
});

it('a session ending on the done step sends the login page back to step one', async () => {
  vi.useFakeTimers({ now: NOW });
  const h = setup('bind_totp');
  await h.auth.login(CREDENTIALS);
  await h.auth.login({ step: 'bind_totp', code: '123456' });
  expect(h.auth.getSnapshot().step).toBe('done');
  h.setNow(NOW + 30 * 60_000);
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(h.auth.getToken()).toBeNull();
  expect(h.auth.getSnapshot()).toMatchObject({
    step: 'credentials',
    error: { key: 'error.10001' },
  });
});

it('refresh asks /me/permissions again; overlapping requests both succeed', async () => {
  const h = setup();
  await h.auth.login(CREDENTIALS);
  await h.auth.login({ step: 'totp', code: '123456' });
  expect(await h.auth.getIdentity()).toEqual(ME);
  expect(await h.auth.getIdentity()).toEqual(ME);
  expect(h.calls.filter((c) => c.path.endsWith('/me/permissions'))).toHaveLength(1);
  const first = deferred();
  const second = deferred();
  h.queue('/admin/v1/me/permissions', () => first.promise);
  h.queue('/admin/v1/me/permissions', () => second.promise);
  const a = h.auth.getIdentity({ refresh: true });
  const b = h.auth.getIdentity({ refresh: true });
  await vi.waitFor(() =>
    expect(h.calls.filter((c) => c.path.endsWith('/me/permissions'))).toHaveLength(3),
  );
  first.resolve(ok(ME));
  expect(await a).toEqual(ME);
  second.resolve(ok({ ...ME, is_super: true }));
  expect(await b).toEqual({ ...ME, is_super: true });
});

it('manualStart: an instance that is never started does not clear a restored session', async () => {
  vi.useFakeTimers({ now: NOW });
  const stored = JSON.stringify({
    admin_token: SESSION.admin_token,
    expires_at: SESSION.expires_at,
    idle_timeout_sec: 1800,
    last_active_at: new Date(NOW).toISOString(),
  });
  const values = new Map([['couli.admin.session', stored]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  const api = { baseUrl: BASE_URL, fetch: vi.fn<typeof globalThis.fetch>() };
  const discarded = createAuthProvider({ api, storage, manualStart: true });
  const kept = createAuthProvider({ api, storage, manualStart: true });
  providers.push(discarded, kept);
  const stop = kept.start();
  await vi.advanceTimersByTimeAsync(29 * 60_000);
  expect(values.has('couli.admin.session')).toBe(true);
  await vi.advanceTimersByTimeAsync(2 * 60_000);
  expect(kept.getToken()).toBeNull();
  expect(values.has('couli.admin.session')).toBe(false);
  stop();
});

it('overlapping logouts join; a late answer never ends a session started afterwards', async () => {
  const h = setup();
  await h.auth.login(CREDENTIALS);
  await h.auth.login({ step: 'totp', code: '123456' });
  const answer = deferred();
  h.queue('/admin/v1/auth/logout', () => answer.promise);
  const one = h.auth.logout({});
  const two = h.auth.logout({});
  expect(two).toBe(one);
  expect(h.auth.getToken()).toBeNull();
  await vi.waitFor(() =>
    expect(h.calls.filter((c) => c.path.endsWith('/auth/logout'))).toHaveLength(1),
  );
  expect(h.calls.find((c) => c.path.endsWith('/auth/logout'))?.authorization).toBe(
    `Bearer ${SESSION.admin_token}`,
  );
  await h.auth.login(CREDENTIALS);
  await h.auth.login({ step: 'totp', code: '123456' });
  answer.resolve(ok({}));
  await one;
  expect(h.auth.getToken()).toBe(SESSION.admin_token);
  expect(h.values.size).toBe(1);
});
