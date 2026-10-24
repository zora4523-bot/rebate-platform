import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';

// Contract-shaped fixtures for CT-24t (be draft, planned; not merged when these tests were
// written): adminListNotifyChannels GET /admin/v1/notify-channels, adminSwitchNotifyChannels
// PATCH /admin/v1/notify-channels/{code}, adminRegisterNotifySms PUT
// /admin/v1/notify-channels/{code}/sms?variant=. The schema is not generated yet, so the item
// shape is written out below from the draft (checked against the CT-24t draft diff of
// 2026-10-24, sha256 4776f13061ea…: order of checks, error codes, HTTP statuses). Sign names,
// template CODEs and phone numbers are obvious samples.
export const BASE_URL = 'https://admin-api.example.test';
export const TRACE_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const LIST = '/admin/v1/notify-channels';
export const VERIFY = '/admin/v1/auth/step-up';
export const PHONE = '138****5678';
export const SIGN = '凑狸';
export const BANNED_WORD = '最低价';
export const TEMPLATE = {
  smsCode: 'SMS_000000001',
  wdFailed: 'SMS_000000002',
  unionExpiring: 'SMS_000000003',
  replacement: 'SMS_000000009',
  fresh: 'SMS_000000010',
} as const;
export const PREVIEW = {
  smsCode: '您的验证码为${code}，5分钟内有效，请勿泄露。',
  wdFailed: '提现打款未成功：${reason}，${amount} 已退回余额',
  unionExpiring: '你的${platform_name}联盟授权将于${expires_at}到期，请登录后台重新授权。',
} as const;

export const channelPath = (code: string): string => `${LIST}/${code}`;
export const smsPath = (code: string): string => `${LIST}/${code}/sms`;

export type Channel = 'inbox' | 'push' | 'sms';
export interface SmsRegistration {
  sign_name: string;
  template_code: string;
  template_type: 'verify' | 'notice';
  preview_text: string;
  updated_at: string;
}
export interface SmsVariant {
  variant: string;
  variables: string[];
  registration: SmsRegistration | null;
}
export interface ChannelItem {
  code: string;
  category: 'service' | 'subscription' | 'marketing';
  default_channels: Channel[];
  channels: Channel[];
  push_switchable: boolean;
  sms_switchable: boolean;
  sms_fixed: boolean;
  sms_billing_confirm: boolean;
  fund_terms: boolean;
  sms_registrations: SmsVariant[];
  row_version: number;
}

const UPDATED_AT = '2026-10-20T10:00:00+08:00';

/**
 * One item per code, returned ordered by code as the contract's list is:
 * - SMS_CODE: SMS only, fixed on (change template only), registered (verify), not fund;
 * - WD_SUCCESS: push + inbox, push and SMS switchable, opening SMS needs the billing confirmation,
 *   fund, one unregistered variant;
 * - WD_FAILED: push + inbox + SMS (default), both switchable, no billing confirmation, fund,
 *   registered (notice);
 * - WD_REJECTED: push + inbox, two unregistered variants (default, negative_balance), fund;
 * - CLAIM_RESULT: inbox only by default, push and SMS allowed but off, billing confirmation;
 * - BALANCE_ADJUSTED: inbox only, nothing switchable, no SMS rows;
 * - UNION_AUTH_EXPIRING: SMS only, fixed on, registered, no inbox.
 */
export function items(): ChannelItem[] {
  const list: ChannelItem[] = [
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
      sms_registrations: [
        {
          variant: 'default',
          variables: ['code'],
          registration: {
            sign_name: SIGN,
            template_code: TEMPLATE.smsCode,
            template_type: 'verify',
            preview_text: PREVIEW.smsCode,
            updated_at: UPDATED_AT,
          },
        },
      ],
      row_version: 2,
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
      sms_registrations: [
        { variant: 'default', variables: ['net', 'payout_channel_name'], registration: null },
      ],
      row_version: 4,
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
      sms_registrations: [
        {
          variant: 'default',
          variables: ['reason', 'amount'],
          registration: {
            sign_name: SIGN,
            template_code: TEMPLATE.wdFailed,
            template_type: 'notice',
            preview_text: PREVIEW.wdFailed,
            updated_at: UPDATED_AT,
          },
        },
      ],
      row_version: 1,
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
      sms_registrations: [
        { variant: 'default', variables: ['reason', 'amount'], registration: null },
        { variant: 'negative_balance', variables: ['reason'], registration: null },
      ],
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
      sms_registrations: [{ variant: 'default', variables: ['rebate'], registration: null }],
      row_version: 0,
    },
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
      sms_registrations: [],
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
      sms_registrations: [
        {
          variant: 'default',
          variables: ['platform_name', 'expires_at'],
          registration: {
            sign_name: SIGN,
            template_code: TEMPLATE.unionExpiring,
            template_type: 'notice',
            preview_text: PREVIEW.unionExpiring,
            updated_at: UPDATED_AT,
          },
        },
      ],
      row_version: 3,
    },
  ];
  return list.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/** Every code of items(), in order. */
export const CODES = [
  'BALANCE_ADJUSTED',
  'CLAIM_RESULT',
  'SMS_CODE',
  'UNION_AUTH_EXPIRING',
  'WD_FAILED',
  'WD_REJECTED',
  'WD_SUCCESS',
] as const;

/** The same items with `patch` applied to the item of `code`. */
export function withItem(code: string, patch: Partial<ChannelItem>): ChannelItem[] {
  return items().map((item) => (item.code === code ? { ...item, ...patch } : item));
}

type StepUpMap = NonNullable<PermissionSnapshot['stepUp']>;

/**
 * Permission snapshot with a totp step-up annotation on every listed key (notify.channels is not
 * a contract key until CT-24t is merged, hence the cast).
 */
export function snapshot(permissions: readonly string[]): PermissionSnapshot {
  const stepUp: Record<string, { tier: 'totp'; operations: Record<string, never> }> = {};
  for (const key of permissions) stepUp[key] = { tier: 'totp', operations: {} };
  return { isSuper: false, permissions, stepUp: stepUp as StepUpMap };
}
/** notify.channels with content.fund_terms: every write of the page. */
export const FULL = snapshot(['notify.channels', 'content.fund_terms']);
/** notify.channels without content.fund_terms: switches only for fund codes. */
export const NO_FUND = snapshot(['notify.channels']);
/** Shows the 消息模板 menu but holds no notify.channels. */
export const ARTICLE_ONLY = snapshot(['content.article', 'content.fund_terms']);

export function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE_ID });
}
// HTTP statuses as in contracts/error-codes.yaml.
const STATUS: Record<number, number> = {
  10003: 403,
  10403: 403,
  20902: 409,
  42901: 429,
  50001: 500,
  50301: 503,
  50401: 504,
};
export function failure(
  code: number,
  data: unknown = null,
  msg = '操作失败',
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { code, msg, data, trace_id: TRACE_ID },
    { status: STATUS[code] ?? 400, headers },
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

export interface ServerOptions {
  /** The operator's verification phone (masked); null = none registered. */
  readonly verifyPhone?: string | null;
  /** The account holds content.fund_terms (the server answers 10403 otherwise). */
  readonly fundTerms?: boolean;
}

const SWITCH_KEYS = ['push', 'sms', 'confirm_sms_billing', 'row_version'];
const SMS_KEYS = [
  'sign_name',
  'template_code',
  'template_type',
  'preview_text',
  'sample',
  'row_version',
];

/** Words the fake server refuses in preview_text (named after the field in data.fields). */
const FORBIDDEN_WORDS = [BANNED_WORD, '官方'];
/** The code validity of SMS_CODE in minutes (BR-ID-05). */
const SMS_CODE_MINUTES = 5;

function variablesOf(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(/\$\{([A-Za-z0-9_]+)\}/g), (m) => m[1]!))].sort();
}
function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

/**
 * Fake /admin/v1 server with the CT-24t checks: the list (not paged), the channel switches and
 * the SMS registration with a synchronous test send. Every write needs a totp step-up value that
 * is good for one write only (none, an old or a reused one is 10003 tier=totp).
 */
export function createServer(initial: ChannelItem[] = items(), options: ServerOptions = {}) {
  const state = structuredClone(initial);
  const log: RequestLog[] = [];
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  const spent = new Set<string>();
  const verifyPhone = options.verifyPhone === undefined ? PHONE : options.verifyPhone;
  const fundTerms = options.fundTerms ?? true;
  let issued = 0;
  let pending = 0;

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

  // Checks in the order of the CT-24t descriptions; the first hit is returned.
  function switchChannels(item: ChannelItem, body: Record<string, unknown>): Response {
    const unknown = Object.keys(body).filter((key) => !SWITCH_KEYS.includes(key));
    if (unknown.length > 0) return failure(20001, { fields: unknown });
    const push = body['push'];
    const sms = body['sms'];
    const confirm = body['confirm_sms_billing'];
    const version = body['row_version'];
    if (push === undefined && sms === undefined) return failure(20001, { fields: ['push', 'sms'] });
    if (push !== undefined && typeof push !== 'boolean')
      return failure(20001, { fields: ['push'] });
    if (sms !== undefined && typeof sms !== 'boolean') return failure(20001, { fields: ['sms'] });
    if (confirm !== undefined && typeof confirm !== 'boolean')
      return failure(20001, { fields: ['confirm_sms_billing'] });
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0)
      return failure(20001, { fields: ['row_version'] });
    if (push !== undefined && !item.push_switchable) return failure(20001, { fields: ['push'] });
    if (sms !== undefined && !item.sms_switchable) return failure(20001, { fields: ['sms'] });
    if (sms === true && !item.channels.includes('sms') && item.sms_billing_confirm && !confirm)
      return failure(20001, { fields: ['confirm_sms_billing'] });
    if (version !== item.row_version) return failure(20902, { resource: 'notify' });
    const set = new Set(item.channels);
    if (push === true) set.add('push');
    if (push === false) set.delete('push');
    if (sms === true) set.add('sms');
    if (sms === false) set.delete('sms');
    const next = (['push', 'inbox', 'sms'] as const).filter((channel) => set.has(channel));
    // A switch already at the requested value is left as it is (no write, row_version kept).
    if (next.join(',') !== item.channels.join(',')) {
      item.channels = next;
      item.row_version += 1;
    }
    return ok(item);
  }

  function register(item: ChannelItem, variant: string, request: RequestLog): Response {
    const body = bodyOf(request);
    if (!item.sms_fixed && !item.sms_switchable) return failure(20001, { fields: ['code'] });
    const row = item.sms_registrations.find((entry) => entry.variant === variant);
    if (row === undefined) return failure(20001, { fields: ['variant'] });
    const unknown = Object.keys(body).filter((key) => !SMS_KEYS.includes(key));
    if (unknown.length > 0) return failure(20001, { fields: unknown });
    const sign = body['sign_name'];
    const template = body['template_code'];
    const type = body['template_type'];
    const preview = body['preview_text'];
    const sample = body['sample'];
    const version = body['row_version'];
    const invalid = [
      ...(isText(sign, 32) ? [] : ['sign_name']),
      ...(isText(template, 64) ? [] : ['template_code']),
      ...(type === 'verify' || type === 'notice' ? [] : ['template_type']),
      ...(isText(preview, 500) ? [] : ['preview_text']),
      ...(typeof version === 'number' && Number.isInteger(version) && version >= 0
        ? []
        : ['row_version']),
    ];
    if (invalid.length > 0) return failure(20001, { fields: invalid });
    if (sample !== undefined) {
      const entries =
        typeof sample === 'object' && sample !== null && !Array.isArray(sample)
          ? Object.entries(sample)
          : null;
      if (
        entries === null ||
        entries.some(([name, value]) => !row.variables.includes(name) || !isText(value, 64))
      )
        return failure(20001, { fields: ['sample'] });
    }
    const text = preview as string;
    if (variablesOf(text).join(',') !== [...row.variables].sort().join(','))
      return failure(20001, { fields: ['preview_text'] });
    if (
      item.code === 'SMS_CODE' &&
      Array.from(text.matchAll(/(\d+)\s*分钟/g)).some((m) => Number(m[1]) !== SMS_CODE_MINUTES)
    )
      return failure(20001, { fields: ['preview_text'] });
    const found = FORBIDDEN_WORDS.filter((word) => text.includes(word));
    if (found.length > 0) return failure(20001, { fields: ['preview_text', ...found] });
    if (version !== item.row_version) return failure(20902, { resource: 'notify' });
    const current = row.registration;
    const testSend =
      current === null || current.sign_name !== sign || current.template_code !== template;
    if (testSend && verifyPhone === null)
      return failure(10003, { tier: 'totp', reason: 'verify_phone_missing' }, '请先登记验证手机号');
    row.registration = {
      sign_name: sign as string,
      template_code: template as string,
      template_type: type as SmsRegistration['template_type'],
      preview_text: text,
      updated_at: '2026-10-24T20:00:00+08:00',
    };
    item.row_version += 1;
    return ok({ item, test_send_phone_masked: testSend ? verifyPhone : null });
  }

  function normal(request: RequestLog): Response {
    const { method, path } = request;
    if (request.headers.get('Authorization') !== 'Bearer example-admin-token')
      return failure(20001, { fields: ['Authorization'] });
    if (method === 'GET' && path === LIST) return ok({ items: state });
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
    const match = /^\/admin\/v1\/notify-channels\/([^/]+)(\/sms)?$/.exec(path);
    if (match === null) return failure(20001, { fields: ['path'] });
    const write =
      (method === 'PATCH' && match[2] === undefined) || (method === 'PUT' && match[2] === '/sms');
    if (!write) return failure(20001, { fields: ['path'] });
    // Permission, step-up → code → (PUT) fund code without content.fund_terms → the rest.
    if (!presented(request)) return failure(10003, { tier: 'totp' });
    const item = state.find((entry) => entry.code === decodeURIComponent(match[1]!));
    if (item === undefined) return failure(20001, { fields: ['code'] });
    if (method === 'PATCH') return switchChannels(item, bodyOf(request));
    if (item.fund_terms && !fundTerms) return failure(10403, { reason: 'admin_permission_denied' });
    return register(item, request.query['variant'] ?? 'default', request);
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
    log,
    fetch,
    get pending() {
      return pending;
    },
    requests(method: string, path?: string) {
      return log.filter((r) => r.method === method && (path === undefined || r.path === path));
    },
    /** Every request to /admin/v1/notify-channels or below it. */
    channelRequests() {
      return log.filter((r) => r.path === LIST || r.path.startsWith(`${LIST}/`));
    },
    /** Writes (PATCH / PUT) to /admin/v1/notify-channels/…. */
    writes() {
      return log.filter((r) => r.method !== 'GET' && r.path.startsWith(`${LIST}/`));
    },
    item(code: string): ChannelItem {
      const found = state.find((entry) => entry.code === code);
      if (found === undefined) throw new Error(`fixture code ${code}`);
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
