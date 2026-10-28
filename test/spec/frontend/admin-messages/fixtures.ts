import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type {
  KnownPermission,
  PermissionSnapshot,
  StepUpAnnotation,
} from '../../../../apps/admin/src/providers/access-control/index.ts';

// Contract-shaped fixtures for the merged CT-24t (contracts/openapi.yaml, tag admin-notify):
// adminListNotifyChannels GET /admin/v1/notify-channels, adminSwitchNotifyChannels PATCH /{code},
// adminRegisterNotifySms PUT /{code}/sms?variant=, adminDiscardNotifySms DELETE
// /{code}/sms/pending, adminRetestNotifySms POST /{code}/sms/pending/test and
// adminEnableNotifySms POST /{code}/sms/pending/enable; the operator's verify phone comes from
// adminGetMyPermissions GET /admin/v1/me/permissions (verify_phone_masked). Item shapes are the
// generated contract types; the fake server checks in the order the descriptions give. Sign
// names, template CODEs (all-zero placeholders) and phone numbers are obvious samples.
export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const LIST = '/admin/v1/notify-channels';
export const VERIFY = '/admin/v1/auth/step-up';
export const ME = '/admin/v1/me/permissions';
export const PHONE = '138****5678';
export const SIGN = '凑狸';
export const BANNED_WORD = '最低价';
export const TEMPLATE = {
  wdFailedActive: 'SMS_000000001',
  wdFailedPending: 'SMS_000000002',
  wdRejected: 'SMS_000000003',
  wdRejectedNegative: 'SMS_000000004',
  unionActive: 'SMS_000000005',
  unionPending: 'SMS_000000006',
  wdSuccess: 'SMS_000000007',
  replacement: 'SMS_000000009',
  fresh: 'SMS_000000010',
} as const;
export const PREVIEW = {
  wdFailedActive: '【凑狸】你的提现打款未成功，${amount}已退回余额，请在App内查看原因。',
  wdFailedPending: '【凑狸】你的提现打款未成功，${amount}已退回余额，可在App内查看原因。',
  wdRejected: '【凑狸】你的提现未通过：${reason}，${amount}已退回余额。',
  wdRejectedNegative: '【凑狸】你的提现未通过：${reason}；抵扣后的余额以钱包显示为准。',
  unionActive: '【凑狸】你的${platform_name}联盟授权将于${expires_at}到期，请登录后台重新授权。',
  unionPending: '【凑狸】${platform_name}联盟授权将于${expires_at}到期，请及时登录后台授权。',
  wdSuccess: '【凑狸】提现已到账：${net}已转入你的${payout_channel_name}。',
} as const;

export const channelPath = (code: string): string => `${LIST}/${code}`;
export const smsPath = (code: string): string => `${LIST}/${code}/sms`;
export const pendingPath = (code: string): string => `${LIST}/${code}/sms/pending`;
export const retestPath = (code: string): string => `${LIST}/${code}/sms/pending/test`;
export const enablePath = (code: string): string => `${LIST}/${code}/sms/pending/enable`;

export type Channel = Schema<'AdminNotifyChannel'>;
export type ChannelItem = Schema<'AdminNotifyChannelItem'>;
export type SmsRow = Schema<'AdminNotifySmsVariantRow'>;
export type SmsActive = Schema<'AdminNotifySmsActive'>;
export type SmsPending = Schema<'AdminNotifySmsPending'>;
export type SmsTestStatus = Schema<'AdminNotifySmsTestStatus'>;

const ENABLED_AT = '2026-11-02T10:15:00+08:00';
const SAVED_AT = '2026-11-05T09:30:00+08:00';
const TESTED_AT = '2026-11-05T09:30:01+08:00';
const NOW = '2026-11-06T09:00:00+08:00';

export function active(
  template_code: string,
  preview_text: string,
  template_type: SmsActive['template_type'] = 'notice',
): SmsActive {
  return { sign_name: SIGN, template_code, template_type, preview_text, enabled_at: ENABLED_AT };
}
export function pending(
  template_code: string,
  preview_text: string,
  status: SmsTestStatus,
  template_type: SmsPending['template_type'] = 'notice',
): SmsPending {
  return {
    sign_name: SIGN,
    template_code,
    template_type,
    preview_text,
    saved_at: SAVED_AT,
    test: { status, tested_at: TESTED_AT },
  };
}
/** The default variant with nothing registered. */
export function unregistered(variables: string[]): SmsRow {
  return { variant: 'default', variables, active: null, pending: null };
}

/**
 * One item per code, ordered by code as the contract's list is (SMS_CODE, WD_FAILED, WD_REJECTED,
 * DATA_COPY_CODE and BALANCE_ADJUSTED as in the contract example):
 * - BALANCE_ADJUSTED: inbox only, nothing switchable, no SMS rows (fund);
 * - CLAIM_RESULT: inbox by default, push and SMS switchable, SMS off and not ready (unregistered),
 *   billing confirmation (fund);
 * - DATA_COPY_CODE: SMS fixed on, not ready (enabled_not_ready), unregistered, not fund;
 * - SMS_CODE: SMS fixed on, deployment fallback, unregistered, ttl 300 s, not fund;
 * - UNION_AUTH_EXPIRING: SMS fixed on, active plus a pending registration whose test was accepted,
 *   not fund;
 * - WATCH_DIGEST: subscription, push switchable, never SMS;
 * - WD_FAILED: push + inbox + SMS (default), both switchable, active plus a failed pending (fund);
 * - WD_REJECTED: push + inbox, SMS off and not ready, billing confirmation, two variants without
 *   an active registration: default pending accepted, negative_balance pending not sent (fund);
 * - WD_SUCCESS: push + inbox, SMS off but ready (active only), billing confirmation (fund).
 */
export function items(): ChannelItem[] {
  return [
    {
      code: 'BALANCE_ADJUSTED',
      category: 'service',
      default_channels: ['inbox'],
      channels: ['inbox'],
      push_switchable: false,
      sms_switchable: false,
      sms_fixed: false,
      sms_billing_confirm: false,
      fund_terms: true,
      sms_ready: false,
      sms_state: 'disabled',
      sms_deploy_fallback: false,
      sms_code_ttl_sec: null,
      sms_registrations: [],
      row_version: 0,
    },
    {
      code: 'CLAIM_RESULT',
      category: 'service',
      default_channels: ['inbox'],
      channels: ['inbox'],
      push_switchable: true,
      sms_switchable: true,
      sms_fixed: false,
      sms_billing_confirm: true,
      fund_terms: true,
      sms_ready: false,
      sms_state: 'disabled',
      sms_deploy_fallback: false,
      sms_code_ttl_sec: null,
      sms_registrations: [unregistered(['rebate'])],
      row_version: 0,
    },
    {
      code: 'DATA_COPY_CODE',
      category: 'service',
      default_channels: ['sms'],
      channels: ['sms'],
      push_switchable: false,
      sms_switchable: false,
      sms_fixed: true,
      sms_billing_confirm: false,
      fund_terms: false,
      sms_ready: false,
      sms_state: 'enabled_not_ready',
      sms_deploy_fallback: false,
      sms_code_ttl_sec: null,
      sms_registrations: [unregistered(['code', 'expires_at'])],
      row_version: 0,
    },
    {
      code: 'SMS_CODE',
      category: 'service',
      default_channels: ['sms'],
      channels: ['sms'],
      push_switchable: false,
      sms_switchable: false,
      sms_fixed: true,
      sms_billing_confirm: false,
      fund_terms: false,
      sms_ready: false,
      sms_state: 'enabled',
      sms_deploy_fallback: true,
      sms_code_ttl_sec: 300,
      sms_registrations: [unregistered(['code'])],
      row_version: 0,
    },
    {
      code: 'UNION_AUTH_EXPIRING',
      category: 'service',
      default_channels: ['sms'],
      channels: ['sms'],
      push_switchable: false,
      sms_switchable: false,
      sms_fixed: true,
      sms_billing_confirm: false,
      fund_terms: false,
      sms_ready: true,
      sms_state: 'enabled',
      sms_deploy_fallback: false,
      sms_code_ttl_sec: null,
      sms_registrations: [
        {
          variant: 'default',
          variables: ['platform_name', 'expires_at'],
          active: active(TEMPLATE.unionActive, PREVIEW.unionActive),
          pending: pending(TEMPLATE.unionPending, PREVIEW.unionPending, 'accepted'),
        },
      ],
      row_version: 3,
    },
    {
      code: 'WATCH_DIGEST',
      category: 'subscription',
      default_channels: ['push', 'inbox'],
      channels: ['push', 'inbox'],
      push_switchable: true,
      sms_switchable: false,
      sms_fixed: false,
      sms_billing_confirm: false,
      fund_terms: false,
      sms_ready: false,
      sms_state: 'disabled',
      sms_deploy_fallback: false,
      sms_code_ttl_sec: null,
      sms_registrations: [],
      row_version: 1,
    },
    {
      code: 'WD_FAILED',
      category: 'service',
      default_channels: ['push', 'inbox', 'sms'],
      channels: ['push', 'inbox', 'sms'],
      push_switchable: true,
      sms_switchable: true,
      sms_fixed: false,
      sms_billing_confirm: false,
      fund_terms: true,
      sms_ready: true,
      sms_state: 'enabled',
      sms_deploy_fallback: false,
      sms_code_ttl_sec: null,
      sms_registrations: [
        {
          variant: 'default',
          variables: ['amount'],
          active: active(TEMPLATE.wdFailedActive, PREVIEW.wdFailedActive),
          pending: pending(TEMPLATE.wdFailedPending, PREVIEW.wdFailedPending, 'failed'),
        },
      ],
      row_version: 5,
    },
    {
      code: 'WD_REJECTED',
      category: 'service',
      default_channels: ['push', 'inbox'],
      channels: ['push', 'inbox'],
      push_switchable: true,
      sms_switchable: true,
      sms_fixed: false,
      sms_billing_confirm: true,
      fund_terms: true,
      sms_ready: false,
      sms_state: 'disabled',
      sms_deploy_fallback: false,
      sms_code_ttl_sec: null,
      sms_registrations: [
        {
          variant: 'default',
          variables: ['reason', 'amount'],
          active: null,
          pending: pending(TEMPLATE.wdRejected, PREVIEW.wdRejected, 'accepted'),
        },
        {
          variant: 'negative_balance',
          variables: ['reason'],
          active: null,
          pending: pending(
            TEMPLATE.wdRejectedNegative,
            PREVIEW.wdRejectedNegative,
            'not_sent_no_verify_phone',
          ),
        },
      ],
      row_version: 4,
    },
    {
      code: 'WD_SUCCESS',
      category: 'service',
      default_channels: ['push', 'inbox'],
      channels: ['push', 'inbox'],
      push_switchable: true,
      sms_switchable: true,
      sms_fixed: false,
      sms_billing_confirm: true,
      fund_terms: true,
      sms_ready: true,
      sms_state: 'disabled',
      sms_deploy_fallback: false,
      sms_code_ttl_sec: null,
      sms_registrations: [
        {
          variant: 'default',
          variables: ['net', 'payout_channel_name'],
          active: active(TEMPLATE.wdSuccess, PREVIEW.wdSuccess),
          pending: null,
        },
      ],
      row_version: 2,
    },
  ];
}

/** Every code of items(), in order. */
export const CODES = [
  'BALANCE_ADJUSTED',
  'CLAIM_RESULT',
  'DATA_COPY_CODE',
  'SMS_CODE',
  'UNION_AUTH_EXPIRING',
  'WATCH_DIGEST',
  'WD_FAILED',
  'WD_REJECTED',
  'WD_SUCCESS',
] as const;

/** The same items with `patch` applied to the item of `code`. */
export function withItem(code: string, patch: Partial<ChannelItem>): ChannelItem[] {
  return items().map((item) => (item.code === code ? { ...item, ...patch } : item));
}

/** Permission snapshot with the totp step-up annotation of notify.channels (04 §11.2). */
export function snapshot(permissions: Grants): PermissionSnapshot {
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const key of permissions)
    stepUp[key] = { tier: key === 'notify.channels' ? 'totp' : null, operations: {} };
  return { isSuper: false, permissions, stepUp };
}
/** Permission points an account holds. */
export type Grants = readonly KnownPermission[];
/** notify.channels with content.fund_terms: every write of the page. */
export const FULL_GRANTS: Grants = ['notify.channels', 'content.fund_terms'];
/** notify.channels without content.fund_terms. */
export const NO_FUND_GRANTS: Grants = ['notify.channels'];
/** Reads the list (content.article) without notify.channels. */
export const READER_GRANTS: Grants = ['content.article', 'content.fund_terms'];
/** Shows the 消息模板 menu (content.fund_terms) but may not read the list. */
export const MENU_ONLY_GRANTS: Grants = ['content.fund_terms'];

export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
// HTTP statuses as in contracts/error-codes.yaml.
const STATUS: Record<number, number> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20902: 409,
  50001: 500,
  50301: 503,
  50401: 504,
};
/** An error envelope; `data` is left out when undefined (20902 and 5xx carry none). */
export function failure(code: number, data?: unknown, msg = '参数错误'): Response {
  const envelope: Record<string, unknown> = { code, msg, trace_id: TRACE_ID };
  if (data !== undefined) envelope['data'] = data;
  return Response.json(envelope, { status: STATUS[code] ?? 400 });
}
/** 20001 naming `fields`, with `data.reason` when given. */
function rejected(fields: readonly string[], reason?: string): Response {
  return failure(20001, reason === undefined ? { fields } : { fields, reason });
}
function conflict(): Response {
  return failure(20902, undefined, '状态已变化，请刷新后重试');
}
function denied(): Response {
  return failure(10403, { reason: 'admin_permission_denied' }, '无权限');
}
// The CT-24t examples of AdminNotifySmsTestNotAccepted.
export const PROVIDER_REJECTED = {
  code: 50301,
  msg: '短信服务暂不可用，原配置继续生效',
} as const;
export const PROVIDER_TIMEOUT = {
  code: 50401,
  msg: '短信服务响应超时，原配置继续生效',
} as const;

export interface RequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Headers;
  body: unknown;
}
type Reply = (request: RequestLog) => Response | Promise<Response>;

/** What the SMS provider does with the next test sends. */
export type ProviderOutcome = 'accepted' | 'rejected' | 'timeout';

export interface ServerOptions {
  /** Permission points of the account (the server checks them; 10403 otherwise). */
  readonly permissions?: Grants;
  /** The verify phone the server sends tests to (masked); null = none registered. */
  readonly verifyPhone?: string | null;
  /** verify_phone_masked of GET /me/permissions; defaults to verifyPhone. */
  readonly mePhone?: string | null;
  readonly provider?: ProviderOutcome;
}

const SWITCH_FIELDS = ['push', 'sms', 'confirm_sms_billing', 'row_version'];
const REGISTER_FIELDS = [
  'sign_name',
  'template_code',
  'template_type',
  'preview_text',
  'sample',
  'row_version',
];
const RETEST_FIELDS = ['sample', 'row_version'];
const ENABLE_FIELDS = ['row_version'];
/** `METHOD suffix` of a write below /admin/v1/notify-channels/{code} → its operation. */
const OPERATIONS = new Map<string, 'switch' | 'register' | 'discard' | 'retest' | 'enable'>([
  ['PATCH ', 'switch'],
  ['PUT /sms', 'register'],
  ['DELETE /sms/pending', 'discard'],
  ['POST /sms/pending/test', 'retest'],
  ['POST /sms/pending/enable', 'enable'],
]);
const WRITE = /^\/admin\/v1\/notify-channels\/([^/]+)(\/sms(?:\/pending(?:\/(?:test|enable))?)?)?$/;

/** Words the fake server refuses in preview_text (named after the field in data.fields). */
const FORBIDDEN_WORDS = [BANNED_WORD, '官方'];

function variablesOf(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(/\$\{([A-Za-z0-9_]+)\}/g), (m) => m[1]!))].sort();
}
function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}
function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** sms_ready / sms_deploy_fallback / sms_state as the list derives them (CT-24t). */
function derive(item: ChannelItem): void {
  const rows = item.sms_registrations;
  item.sms_ready = rows.length > 0 && rows.every((row) => row.active !== null);
  if (item.sms_deploy_fallback && item.sms_ready) item.sms_deploy_fallback = false;
  if (!item.channels.includes('sms')) item.sms_state = 'disabled';
  else if (item.sms_ready || item.sms_deploy_fallback) item.sms_state = 'enabled';
  else item.sms_state = 'enabled_not_ready';
}

/**
 * Fake /admin/v1 server with the CT-24t checks. Every write but the discard needs a totp step-up
 * value that is good for one write only (none, an old or a reused one is 10003 tier=totp).
 */
export function createServer(initial: ChannelItem[] = items(), options: ServerOptions = {}) {
  const state = structuredClone(initial);
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  const spent = new Set<string>();
  const permissions = options.permissions ?? FULL_GRANTS;
  const verifyPhone = options.verifyPhone === undefined ? PHONE : options.verifyPhone;
  const mePhone = options.mePhone === undefined ? verifyPhone : options.mePhone;
  let provider: ProviderOutcome = options.provider ?? 'accepted';
  let issued = 0;
  let inFlight = 0;

  const holds = (key: KnownPermission): boolean => permissions.includes(key);
  function itemOf(code: string): ChannelItem {
    const found = state.find((entry) => entry.code === code);
    if (found === undefined) throw new Error(`fixture code ${code}`);
    return found;
  }

  function presented(request: RequestLog): boolean {
    const value = request.headers.get('X-Step-Up-Token');
    if (value === null || value !== `test-totp-${issued}` || spent.has(value)) return false;
    spent.add(value);
    return true;
  }
  function bodyOf(request: RequestLog): Record<string, unknown> {
    return typeof request.body === 'object' && request.body !== null
      ? (request.body as Record<string, unknown>)
      : {};
  }
  function unknownKeys(body: Record<string, unknown>, allowed: readonly string[]): string[] {
    return Object.keys(body).filter((key) => !allowed.includes(key));
  }
  function badSample(row: SmsRow, sample: unknown): boolean {
    if (sample === undefined) return false;
    if (typeof sample !== 'object' || sample === null || Array.isArray(sample)) return true;
    const entries = Object.entries(sample);
    return entries.some(([name, value]) => !row.variables.includes(name) || !isText(value, 64));
  }
  /** GET /me/permissions (adminGetMyPermissions). */
  function me() {
    return {
      admin_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01',
      username: 'ops-yi',
      is_super: false,
      verify_phone_masked: mePhone,
      permissions: permissions.map((key) => ({
        key,
        step_up_tier: key === 'notify.channels' ? 'totp' : null,
        step_up_operations: [],
      })),
    };
  }

  /** The synchronous test send of a pending registration; the result is saved either way. */
  function testSend(item: ChannelItem, entry: SmsPending): Response {
    item.row_version += 1;
    if (provider === 'accepted') {
      entry.test = { status: 'accepted', tested_at: NOW };
      return ok({ item, test_send_phone_masked: verifyPhone });
    }
    entry.test = { status: 'failed', tested_at: NOW };
    const reply = provider === 'rejected' ? PROVIDER_REJECTED : PROVIDER_TIMEOUT;
    return failure(reply.code, undefined, reply.msg);
  }

  function switchChannels(item: ChannelItem, body: Record<string, unknown>): Response {
    const unknown = unknownKeys(body, SWITCH_FIELDS);
    if (unknown.length > 0) return rejected(unknown);
    const { push, sms, confirm_sms_billing: confirm, row_version: version } = body;
    if (push === undefined && sms === undefined) return rejected(['push', 'sms']);
    if (push !== undefined && typeof push !== 'boolean') return rejected(['push']);
    if (sms !== undefined && typeof sms !== 'boolean') return rejected(['sms']);
    if (confirm !== undefined && typeof confirm !== 'boolean') {
      return rejected(['confirm_sms_billing']);
    }
    if (!isVersion(version)) return rejected(['row_version']);
    if (push !== undefined && !item.push_switchable) {
      return rejected(['push'], 'notify_channel_locked');
    }
    if (sms !== undefined && !item.sms_switchable) {
      return rejected(['sms'], 'notify_channel_locked');
    }
    const smsOff = !item.channels.includes('sms');
    // Not ready: 20001 without a reason (the console greys the switch out).
    if (sms === true && smsOff && !item.sms_ready) return rejected(['sms']);
    if (sms === true && smsOff && item.sms_billing_confirm && confirm !== true) {
      return rejected(['confirm_sms_billing']);
    }
    if (version !== item.row_version) return conflict();
    const set = new Set<Channel>(item.channels);
    if (push === true) set.add('push');
    if (push === false) set.delete('push');
    if (sms === true) set.add('sms');
    if (sms === false) set.delete('sms');
    const next = (['push', 'inbox', 'sms'] as const).filter((channel) => set.has(channel));
    // A switch already at the requested value is left as it is (no write, row_version kept).
    if (next.join(',') !== item.channels.join(',')) {
      item.channels = next;
      item.row_version += 1;
      derive(item);
    }
    return ok(item);
  }

  function register(item: ChannelItem, row: SmsRow, body: Record<string, unknown>): Response {
    const unknown = unknownKeys(body, REGISTER_FIELDS);
    if (unknown.length > 0) return rejected(unknown);
    const { sign_name: sign, template_code: template, template_type: type } = body;
    const { preview_text: preview, sample, row_version: version } = body;
    const invalid = [
      ...(isText(sign, 32) ? [] : ['sign_name']),
      ...(isText(template, 64) ? [] : ['template_code']),
      ...(type === 'verify' || type === 'notice' ? [] : ['template_type']),
      ...(isText(preview, 500) ? [] : ['preview_text']),
      ...(isVersion(version) ? [] : ['row_version']),
    ];
    if (invalid.length > 0) return rejected(invalid);
    if (badSample(row, sample)) return rejected(['sample']);
    const text = preview as string;
    const expected = [...row.variables].sort().join(',');
    if (variablesOf(text).join(',') !== expected) {
      return rejected(['preview_text'], 'notify_preview_vars_mismatch');
    }
    // SMS_CODE: a validity written as N分钟 must be sms_code_ttl_sec (BR-ID-05).
    const ttl = item.sms_code_ttl_sec;
    const minutes = Array.from(text.matchAll(/(\d+)\s*分钟/g), (m) => Number(m[1]));
    if (ttl !== null && minutes.some((value) => value * 60 !== ttl)) {
      return rejected(['preview_text'], 'notify_code_ttl_mismatch');
    }
    const found = FORBIDDEN_WORDS.filter((word) => text.includes(word));
    if (found.length > 0) return rejected(['preview_text', ...found]);
    if (version !== item.row_version) return conflict();
    const kind = type as SmsActive['template_type'];
    const current = row.active;
    if (current !== null && current.sign_name === sign && current.template_code === template) {
      // Same signature and CODE: replaced in place, no test send, the pending one left alone.
      row.active = { ...current, template_type: kind, preview_text: text, enabled_at: NOW };
      item.row_version += 1;
      return ok({ item, test_send_phone_masked: null });
    }
    const entry: SmsPending = {
      sign_name: sign as string,
      template_code: template as string,
      template_type: kind,
      preview_text: text,
      saved_at: NOW,
      test: { status: 'not_sent_no_verify_phone', tested_at: NOW },
    };
    row.pending = entry;
    if (verifyPhone === null) {
      // Saved as pending, nothing sent (never 10003 here, D10-339 ⑤).
      item.row_version += 1;
      return ok({ item, test_send_phone_masked: null });
    }
    return testSend(item, entry);
  }

  function discard(item: ChannelItem, row: SmsRow, request: RequestLog): Response {
    const raw = request.query['row_version'];
    const version = raw === undefined || !/^\d+$/.test(raw) ? null : Number(raw);
    if (version === null) return rejected(['row_version']);
    if (version !== item.row_version) return conflict();
    if (row.pending !== null) {
      row.pending = null;
      item.row_version += 1;
    }
    return ok(item);
  }

  function retest(item: ChannelItem, row: SmsRow, body: Record<string, unknown>): Response {
    const unknown = unknownKeys(body, RETEST_FIELDS);
    if (unknown.length > 0) return rejected(unknown);
    if (!isVersion(body['row_version'])) return rejected(['row_version']);
    if (badSample(row, body['sample'])) return rejected(['sample']);
    if (row.pending === null) return rejected(['variant']);
    if (body['row_version'] !== item.row_version) return conflict();
    if (verifyPhone === null) {
      // Only the separate test send answers this (D10-339 ⑤).
      const data = { tier: 'totp', reason: 'verify_phone_missing' };
      return failure(10003, data, '请先登记验证手机号');
    }
    return testSend(item, row.pending);
  }

  function enable(item: ChannelItem, row: SmsRow, body: Record<string, unknown>): Response {
    const unknown = unknownKeys(body, ENABLE_FIELDS);
    if (unknown.length > 0) return rejected(unknown);
    if (!isVersion(body['row_version'])) return rejected(['row_version']);
    const entry = row.pending;
    if (entry === null || entry.test.status !== 'accepted') return rejected(['variant']);
    if (body['row_version'] !== item.row_version) return conflict();
    row.active = {
      sign_name: entry.sign_name,
      template_code: entry.template_code,
      template_type: entry.template_type,
      preview_text: entry.preview_text,
      enabled_at: NOW,
    };
    row.pending = null;
    item.row_version += 1;
    derive(item);
    return ok(item);
  }

  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (request.headers.get('Authorization') !== 'Bearer example-admin-token') {
      return failure(10001, undefined, '未登录');
    }
    if (method === 'GET' && path === ME) return ok(me());
    if (method === 'GET' && path === LIST) {
      if (!holds('content.article') && !holds('notify.channels')) return denied();
      return ok({ items: state });
    }
    if (method === 'POST' && path === VERIFY) {
      const body = bodyOf(request);
      if (body['tier'] !== 'totp' || body['code'] !== '123456') return failure(20002);
      issued += 1;
      return ok({
        step_up_token: `test-totp-${issued}`,
        tier: 'totp',
        expire_at: '2099-01-01T00:00:00Z',
      });
    }
    const match = WRITE.exec(path);
    const operation = OPERATIONS.get(`${method} ${match?.[2] ?? ''}`);
    if (match === null || operation === undefined) return rejected(['path']);
    // Permission, step-up (not for the discard) → code → … in the order of each description.
    if (!holds('notify.channels')) return denied();
    if (operation !== 'discard' && !presented(request)) {
      return failure(10003, { tier: 'totp' }, '需要二次验证');
    }
    const item = state.find((entry) => entry.code === decodeURIComponent(match[1]!));
    if (item === undefined) return rejected(['code']);
    const body = bodyOf(request);
    if (operation === 'switch') return switchChannels(item, body);
    // Saving and enabling a fund code's registration also need content.fund_terms.
    const fundWrite = operation === 'register' || operation === 'enable';
    if (fundWrite && item.fund_terms && !holds('content.fund_terms')) return denied();
    if (operation === 'register' && !item.sms_fixed && !item.sms_switchable) {
      return rejected(['code'], 'notify_channel_locked');
    }
    const variant = request.query['variant'] ?? 'default';
    const row = item.sms_registrations.find((entry) => entry.variant === variant);
    if (row === undefined) return rejected(['variant']);
    if (operation === 'register') return register(item, row, body);
    if (operation === 'discard') return discard(item, row, request);
    if (operation === 'retest') return retest(item, row, body);
    return enable(item, row, body);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw = init?.body;
    const request: RequestLog = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers),
      body: typeof raw === 'string' && raw !== '' ? (JSON.parse(raw) as unknown) : undefined,
    };
    log.push(request);
    inFlight += 1;
    try {
      const index = overrides.findIndex(
        (entry) => entry.method === request.method && entry.path === request.path,
      );
      return await (index < 0 ? normal(request) : overrides.splice(index, 1)[0]!.reply(request));
    } finally {
      inFlight -= 1;
    }
  };

  return {
    state,
    log,
    fetch,
    permissions,
    get pending() {
      return inFlight;
    },
    /** What the SMS provider does with the following test sends. */
    setProvider(outcome: ProviderOutcome) {
      provider = outcome;
    },
    requests(method: string, path?: string) {
      return log.filter((r) => r.method === method && (path === undefined || r.path === path));
    },
    /** Every request to /admin/v1/notify-channels or below it. */
    channelRequests() {
      return log.filter((r) => r.path === LIST || r.path.startsWith(`${LIST}/`));
    },
    /** Writes (PATCH / PUT / POST / DELETE) to /admin/v1/notify-channels/…. */
    writes() {
      return log.filter((r) => r.method !== 'GET' && r.path.startsWith(`${LIST}/`));
    },
    item: itemOf,
    row(code: string, variant = 'default'): SmsRow {
      const found = itemOf(code).sms_registrations.find((entry) => entry.variant === variant);
      if (found === undefined) throw new Error(`fixture row ${code} · ${variant}`);
      return found;
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
