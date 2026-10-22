import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';

// Contract fixtures, not recordings of a real platform. No production adapters are involved.
export const BASE_URL = 'https://admin.example.test';
export const LIST = '/admin/v1/union-accounts';
export const PHONES = `${LIST}/alert-phones`;
export const CALLBACK = `${LIST}/oauth/callback`;
export const VERIFY = '/admin/v1/auth/step-up';
export const ACCOUNT_ID_WEB_GRANT = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a01';
export const MANUAL_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a02';
export const NONE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a03';
export const ADMIN_ID = '0199a3b4-0000-7000-8000-0000a0000b01';
export const SESSION_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6c01';
export const START = `${LIST}/${ACCOUNT_ID_WEB_GRANT}/reauthorize`;
export const POLL = `${START}/${SESSION_ID}`;
export const CREDENTIAL = `${LIST}/${MANUAL_ID}/credential`;
export const NOW = Date.parse('2026-10-23T02:00:00Z');
export const NEW_EXPIRY = '2027-04-03T16:30:00Z';
export const PHONE = '13900002222';
export const SECRET = 'fixture-new-credential-do-not-display';
export const GRANT = 'fixture-single-use-grant+with/slash';
export const STATE = 'fixture-state+opaque/value';
export const SESSION: Schema<'AdminUnionReauthSession'> = {
  session_id: SESSION_ID,
  auth_url: 'https://oauth.union.example.test/authorize?state=fixture-state',
  expires_at: '2026-10-23T02:10:00Z',
};
export type Account = Schema<'AdminUnionAccount'>;
export function rows(): Account[] {
  const common = {
    status: 'active',
    sync_start_at: null,
    auth_expires_at: '2026-12-30T16:30:00Z',
    auth_expires_estimated: false,
    auth_status: 'active',
    auth_renewed_at: '2026-10-20T16:20:00Z',
    auth_renewed_by: ADMIN_ID,
    last_probe_at: '2026-10-22T17:10:00Z',
    last_probe_ok: true,
    last_probe_error: null,
    alert_phones_configured: true,
  } as const;
  return [
    {
      ...common,
      union_account_id: ACCOUNT_ID_WEB_GRANT,
      platform: 'taobao',
      account_name: '测试 OAuth 账号',
      reauth_mode: 'oauth',
    },
    {
      ...common,
      union_account_id: MANUAL_ID,
      platform: 'jd',
      account_name: '测试手工账号',
      reauth_mode: 'manual',
      auth_status: 'expired',
      auth_expires_estimated: true,
      last_probe_ok: false,
      last_probe_error: 'fixture_probe_rejected',
    },
    {
      ...common,
      union_account_id: NONE_ID,
      platform: 'pdd',
      account_name: '测试免授权账号',
      reauth_mode: 'none',
      auth_status: 'expiring',
      auth_expires_at: null,
      auth_renewed_by: null,
      last_probe_at: null,
      last_probe_ok: null,
    },
  ];
}
export function result(
  status: Schema<'AdminUnionAuthSessionStatus'> = 'pending',
): Schema<'AdminUnionReauthResult'> {
  return {
    session_id: SESSION_ID,
    union_account_id: ACCOUNT_ID_WEB_GRANT,
    status,
    error: status === 'failed' ? 'fixture_grant_declined' : null,
    expires_at: SESSION.expires_at,
    finished_at: status === 'pending' ? null : '2026-10-23T02:01:00Z',
  };
}
export function ok(data: unknown): Response {
  return Response.json({
    code: 0,
    msg: '',
    data,
    trace_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b',
  });
}
export function failure(code: number, data: unknown = null): Response {
  return Response.json(
    { code, msg: '操作失败', data, trace_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b' },
    { status: code === 10403 ? 403 : 400 },
  );
}
export interface RequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Headers;
  body: unknown;
}
type Reply = (request: RequestLog) => Response | Promise<Response>;
export function createServer(initial = rows()) {
  const state = structuredClone(initial);
  const phones: Schema<'AdminUnionAlertPhones'> = {
    version: 3,
    items: [{ phone_id: 'hm-existing', phone_masked: '138****5678' }],
  };
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  let tokens = 0;
  let pending = 0;
  let polls = 0;
  let terminal: Schema<'AdminUnionAuthSessionStatus'> = 'succeeded';
  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (method === 'GET' && path === LIST) return ok({ items: state });
    if (method === 'GET' && path === PHONES) return ok(phones);
    if (method === 'POST' && path === VERIFY) {
      const body = request.body as Schema<'AdminStepUpRequest'>;
      if (body?.tier !== 'totp' || body.code !== '123456') return failure(20002);
      tokens += 1;
      return ok({
        step_up_token: `test-totp-${tokens}`,
        tier: 'totp',
        expire_at: '2099-01-01T00:00:00Z',
      });
    }
    if (method === 'GET' && path === POLL) {
      polls += 1;
      const status = polls === 1 ? 'pending' : terminal;
      if (status === 'succeeded')
        state[0] = { ...state[0]!, auth_expires_at: NEW_EXPIRY, auth_expires_estimated: false };
      return ok(result(status));
    }
    if (method === 'POST' && path === CALLBACK) return ok(result(terminal));
    if (['POST', 'PUT', 'DELETE'].includes(method)) {
      if (tokens === 0 || request.headers.get('X-Step-Up-Token') !== `test-totp-${tokens}`)
        return failure(10003, { tier: 'totp' });
      if (method === 'POST' && path === START) {
        polls = 0;
        return ok(SESSION);
      }
      if (method === 'PUT' && path === CREDENTIAL) {
        const body = request.body as Schema<'AdminUnionCredentialRequest'>;
        const index = state.findIndex((row) => row.union_account_id === MANUAL_ID);
        state[index] = {
          ...state[index]!,
          auth_status: 'active',
          auth_expires_at: body.expires_at ?? NEW_EXPIRY,
          auth_expires_estimated: body.expires_at === undefined,
          auth_renewed_by: ADMIN_ID,
        };
        return ok(state[index]);
      }
      if (path === PHONES) {
        const body = request.body as Schema<'AdminUnionAlertPhoneAddRequest'> | undefined;
        const version =
          method === 'DELETE' ? Number(request.query['expected_version']) : body?.expected_version;
        if (version !== phones.version) return failure(20902, { resource: 'config_item' });
        if (method === 'POST')
          phones.items.push({ phone_id: 'hm-added', phone_masked: '139****2222' });
        if (method === 'DELETE')
          phones.items = phones.items.filter(
            (phone) => phone.phone_id !== request.query['phone_id'],
          );
        phones.version += 1;
        for (const account of state) account.alert_phones_configured = phones.items.length > 0;
        return ok(phones);
      }
    }
    return failure(20001, { fields: ['path'] });
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const request: RequestLog = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    log.push(request);
    pending += 1;
    try {
      const index = overrides.findIndex(
        (entry) => entry.method === request.method && entry.path === request.path,
      );
      return await (index < 0 ? normal(request) : overrides.splice(index, 1)[0]!.reply(request));
    } finally {
      pending -= 1;
    }
  };
  return {
    state,
    phones,
    log,
    fetch,
    get pending() {
      return pending;
    },
    terminal(status: Schema<'AdminUnionAuthSessionStatus'>) {
      terminal = status;
    },
    requests(method: string, path?: string) {
      return log.filter((r) => r.method === method && (path === undefined || r.path === path));
    },
    once(method: string, path: string, reply: Reply) {
      overrides.push({ method, path, reply });
    },
    hold(method: string, path: string, reply: Reply = normal) {
      const gate = Promise.withResolvers<void>();
      overrides.push({
        method,
        path,
        reply: async (request) => {
          await gate.promise;
          return reply(request);
        },
      });
      return gate.resolve;
    },
  };
}
export type Server = ReturnType<typeof createServer>;
