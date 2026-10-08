import { vi } from 'vitest';
import {
  createAuthProvider,
  type AdminAuthProvider,
  type AdminIdentity,
  type AdminSession,
  type AdminBindingSecret,
  type AdminLoginStepData,
} from '../../../../apps/admin/src/providers/auth/index.ts';

// Public, synthetic CT-02f examples from contracts/openapi.yaml. No real credentials.
export const NOW = Date.parse('2026-10-07T10:00:00+08:00');
export const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const CREDENTIALS = {
  step: 'credentials',
  username: 'ops-yi',
  password: 'example-password',
} as const;
export const SESSION: AdminSession = {
  admin_token: 'example-admin-token',
  expires_at: '2026-10-07T18:00:00+08:00',
  idle_timeout_sec: 1800,
};
export const SECRET: AdminBindingSecret = {
  totp_secret: 'JBSWY3DPEHPK3PXP',
  otpauth_uri:
    'otpauth://totp/Couli%20Admin:ops-yi?secret=JBSWY3DPEHPK3PXP&issuer=Couli%20Admin&digits=6&period=30',
};
export const ME: AdminIdentity = {
  admin_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01',
  username: 'finance-jia',
  is_super: false,
  verify_phone_masked: '138****5678',
  permissions: [
    { key: 'fund.view', step_up_tier: null, step_up_operations: [] },
    { key: 'fund.adjust', step_up_tier: 'sms', step_up_operations: [] },
    {
      key: 'fund.recon',
      step_up_tier: null,
      step_up_operations: [{ operation: 'fund.recon.balance_recalc', tier: 'sms' }],
    },
    {
      key: 'content.app_version',
      step_up_tier: null,
      step_up_operations: [
        { operation: 'content.app_version.raise_min_supported_version', tier: 'totp' },
      ],
    },
    { key: 'withdraw.review', step_up_tier: 'totp', step_up_operations: [] },
  ],
};
export const COPY = {
  'error.10001': '请先登录',
  'error.10008': '账号或密码不正确',
  'error.10009': '连续输错次数过多，账号已锁定，请在 {unlock_time} 后再试',
  'error.10001.login_ticket_expired': '登录步骤已过期，请重新登录',
  'error.20002.totp_invalid': '动态码不正确，请输入验证器上最新的 6 位动态码',
  'error.20002.totp_bind_invalid':
    '动态码不正确，绑定没有完成。请确认手机时间准确，再输入验证器上最新的 6 位动态码。',
  'error.10403.admin_ip_not_allowed': '仅限公司网络访问',
  'error.42901': '操作太频繁，请稍后再试',
} as const;
export const TITLES = {
  credentials: '请使用后台账号登录',
  change_password: '设置新密码',
  totp: '第二步：输入动态码',
  bind_totp: '第二步：绑定身份验证器（首次登录）',
  done: '身份验证器已绑定',
} as const;

export function stepData(next: AdminLoginStepData['next']): AdminLoginStepData {
  return {
    next,
    login_ticket: `example-login-ticket-${next === 'change_password' ? 'password' : next === 'bind_totp' ? 'bind' : 'totp'}`,
    ticket_expires_at: '2026-10-07T10:05:00+08:00',
  };
}

export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE });
}

export function rejected(code: number, data?: unknown, headers?: HeadersInit): Response {
  return Response.json(
    {
      code,
      msg: 'server-message-must-not-replace-dictionary',
      ...(data === undefined ? {} : { data }),
      trace_id: TRACE,
    },
    { status: code === 42901 ? 429 : 401, ...(headers === undefined ? {} : { headers }) },
  );
}

export function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
}

export function harness(next: AdminLoginStepData['next'] = 'totp', me = ME) {
  let now = NOW;
  const requests: { path: string; method: string; body: unknown; authorization: string | null }[] =
    [];
  const responses = new Map<string, (() => Response | Promise<Response>)[]>();
  const storage = memoryStorage();
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const raw = await request.text();
    requests.push({
      path,
      method: request.method,
      body: raw === '' ? undefined : JSON.parse(raw),
      authorization: request.headers.get('Authorization'),
    });
    const queued = responses.get(path)?.shift();
    if (queued) return queued();
    switch (path) {
      case '/admin/v1/auth/login':
        return ok(stepData(next));
      case '/admin/v1/auth/password':
        return ok({ ...stepData('bind_totp'), ticket_expires_at: '2026-10-07T10:10:00+08:00' });
      case '/admin/v1/auth/totp/secret':
        return ok(SECRET);
      case '/admin/v1/auth/totp':
      case '/admin/v1/auth/totp/bind':
        return ok(SESSION);
      case '/admin/v1/me/permissions':
        return ok(me);
      case '/admin/v1/auth/logout':
        return ok({});
      default:
        return rejected(50001);
    }
  });
  const options = {
    api: { baseUrl: 'https://admin.example.test', fetch },
    storage,
    clock: { now: () => now },
  };
  return {
    options,
    storage,
    fetch,
    requests,
    create: () => createAuthProvider(options),
    setNow: (value: number) => {
      now = value;
    },
    queue(path: string, response: () => Response | Promise<Response>) {
      const queue = responses.get(path) ?? [];
      queue.push(response);
      responses.set(path, queue);
    },
  };
}

export async function signIn(auth: AdminAuthProvider): Promise<void> {
  await auth.login(CREDENTIALS);
  await auth.login({ step: 'totp', code: '123456' });
}
