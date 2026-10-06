import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';

// Literal copies of contracts/openapi.yaml examples. Individual tests label boundary mutations.
export const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const BASE_URL = 'https://admin-api.example.test';

// GET /admin/v1/admins, responses.200.content.application/json.example
export const ADMIN_PAGE = {
  code: 0,
  msg: '',
  data: {
    items: [
      {
        admin_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01',
        username: 'finance-jia',
        is_super: false,
        status: 'active',
        totp_bound: true,
        verify_phone_masked: '138****5678',
        locked_until: null,
        permissions: ['fund.view', 'fund.adjust'],
        created_at: '2026-10-05T09:00:00+08:00',
      },
      {
        admin_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b02',
        username: 'ops-yi',
        is_super: false,
        status: 'active',
        totp_bound: false,
        verify_phone_masked: null,
        locked_until: '2026-10-07T10:30:00+08:00',
        permissions: [],
        created_at: '2026-10-06T14:00:00+08:00',
      },
    ],
    page: 1,
    page_size: 20,
    total: 2,
  },
  trace_id: TRACE_ID,
} satisfies Schema<'AdminAccountPageResponse'>;

// GET /admin/v1/admins/{admin_id}, responses.200.content.application/json.example
export const ADMIN_ONE = {
  code: 0,
  msg: '',
  data: {
    admin_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b00',
    username: 'owner',
    is_super: true,
    status: 'active',
    totp_bound: true,
    verify_phone_masked: '139****0000',
    locked_until: null,
    permissions: [],
    created_at: '2026-10-01T09:00:00+08:00',
  },
  trace_id: TRACE_ID,
} satisfies Schema<'AdminAccountResponse'>;

// GET /admin/v1/me/permissions, examples.finance.value
export const FINANCE_ME = {
  code: 0,
  msg: '',
  data: {
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
  },
  trace_id: TRACE_ID,
} satisfies Schema<'AdminMeResponse'>;

// Same endpoint, examples.noPermission.value
export const EMPTY_ME = {
  code: 0,
  msg: '',
  data: {
    admin_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b02',
    username: 'ops-yi',
    is_super: false,
    verify_phone_masked: null,
    permissions: [],
  },
  trace_id: TRACE_ID,
} satisfies Schema<'AdminMeResponse'>;

// components.examples: AdminPermissionDenied, AdminIpNotAllowed,
// AdminLoginTicketExpired, AdminVerifyPhoneMissing (each .value).
export const API_ERRORS = [
  {
    code: 10403,
    msg: '当前账号没有这项操作的权限，请联系超级管理员开通',
    data: { reason: 'admin_permission_denied' },
    trace_id: TRACE_ID,
  },
  {
    code: 10403,
    msg: '仅限公司网络访问',
    data: { reason: 'admin_ip_not_allowed' },
    trace_id: TRACE_ID,
  },
  {
    code: 10001,
    msg: '登录步骤已过期，请重新登录',
    data: { reason: 'login_ticket_expired' },
    trace_id: TRACE_ID,
  },
  {
    code: 10003,
    msg: '这项操作需要短信验证，请先登记验证手机号',
    data: { tier: 'sms', reason: 'verify_phone_missing' },
    trace_id: TRACE_ID,
  },
] satisfies Schema<'ErrorEnvelope'>[];

// components.responses.TooManyRequests.content.application/json.example
export const RATE_LIMITED = {
  code: 42901,
  msg: '请求过于频繁',
  trace_id: TRACE_ID,
} satisfies Schema<'ErrorEnvelope'>;

// POST /admin/v1/auth/step-up, requestBody and responses.200 examples.totp.value
export const STEP_UP_REQUEST = {
  tier: 'totp',
  code: '123456',
} satisfies Schema<'AdminStepUpRequest'>;
export const STEP_UP_RESPONSE = {
  code: 0,
  msg: '',
  data: {
    step_up_token: 'example-admin-step-up-token-totp',
    tier: 'totp',
    expire_at: '2026-10-07T10:35:00+08:00',
  },
  trace_id: TRACE_ID,
} satisfies Schema<'AdminStepUpResponse'>;

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function requestFrom(input: Parameters<typeof fetch>[0], init?: RequestInit): Request {
  return new Request(input, init);
}
