// B1-12z · What the code fixes about each notification template code for the console's channel
// page (CT-24t adminListNotifyChannels; 08 BR-TEXT-09 细则 template table and its channel column,
// BR-TEXT-20 细则「短信渠道登记与后台渠道开关」, BR-TEXT-23 细则; orchestrator rulings D10-337,
// D10-341). The rows themselves (code × variant, category, channels in force, registrations) live
// in notify_templates; this file only holds what the console may not change: default channels,
// which codes are inbox-only or SMS-fixed, the SMS variables of each variant, the locked template
// type and the built-in sample values of the test send.
//
// Codes outside this catalog (for example a subscription code) keep their stored channels as their
// defaults and define no SMS variables.
//
// Pure module (no decorators, erasable syntax).

export type NotifyChannel = 'inbox' | 'push' | 'sms';
export type SmsTemplateType = 'verify' | 'notice';

export interface TemplateCodeDefinition {
  /** BR-TEXT-09 细则 channel column (or the code's definition elsewhere in 08). */
  readonly defaultChannels: readonly NotifyChannel[];
  /** 08 sends it as an inbox message only: neither push nor SMS may be switched on. */
  readonly inboxOnly?: true;
  /** SMS is always on; only its registration may be replaced. */
  readonly smsFixed?: true;
  /** SMS variables by variant; `default` also stands for a variant not listed. */
  readonly variables: Readonly<Record<string, readonly string[]>>;
}

/** Display order of channels in answers. */
export const CHANNEL_ORDER: readonly NotifyChannel[] = ['push', 'inbox', 'sms'];

export const DEFAULT_VARIANT = 'default';
export const VERIFY_CODE = 'SMS_CODE';

const PUSH_INBOX: readonly NotifyChannel[] = ['push', 'inbox'];
const INBOX: readonly NotifyChannel[] = ['inbox'];
const SMS: readonly NotifyChannel[] = ['sms'];

const CATALOG: Readonly<Record<string, TemplateCodeDefinition>> = {
  ORDER_TRACKED: { defaultChannels: PUSH_INBOX, variables: { default: ['title_short', 'rebate'] } },
  ORDER_INVALID: { defaultChannels: INBOX, variables: { default: ['reason'] } },
  CREDITED: { defaultChannels: PUSH_INBOX, variables: { default: ['n', 'sum'] } },
  CLAWBACK: { defaultChannels: PUSH_INBOX, variables: { default: ['amount', 'reason'] } },
  WD_SUCCESS: {
    defaultChannels: PUSH_INBOX,
    variables: { default: ['net', 'payout_channel_name'] },
  },
  // BR-TEXT-09 细则: the NEGATIVE_BALANCE line carries no amount (D10-235).
  WD_REJECTED: {
    defaultChannels: PUSH_INBOX,
    variables: { default: ['reason', 'amount'], negative_balance: ['reason'] },
  },
  // BR-TEXT-20 细则 WD_FAILED SMS example: the amount only (the reason is read in the App).
  WD_FAILED: { defaultChannels: ['push', 'inbox', 'sms'], variables: { default: ['amount'] } },
  WD_OVERDUE: { defaultChannels: PUSH_INBOX, variables: { default: [] } },
  CLAIM_RESULT: { defaultChannels: INBOX, variables: { default: ['rebate'] } },
  RISK_STATE_CHANGED: { defaultChannels: INBOX, inboxOnly: true, variables: {} },
  APPEAL_RESULT: { defaultChannels: INBOX, inboxOnly: true, variables: {} },
  DELETION_PROGRESS: { defaultChannels: INBOX, inboxOnly: true, variables: {} },
  BALANCE_ADJUSTED: { defaultChannels: INBOX, inboxOnly: true, variables: {} },
  DATA_COPY_READY: { defaultChannels: PUSH_INBOX, variables: { default: ['expires_at'] } },
  DATA_COPY_CODE: {
    defaultChannels: SMS,
    smsFixed: true,
    variables: { default: ['code', 'expires_at'] },
  },
  SMS_CODE: { defaultChannels: SMS, smsFixed: true, variables: { default: ['code'] } },
  UNION_AUTH_EXPIRING: {
    defaultChannels: SMS,
    smsFixed: true,
    variables: { default: ['platform_name', 'expires_at'] },
  },
  UNION_AUTH_EXPIRED: {
    defaultChannels: SMS,
    smsFixed: true,
    variables: { default: ['platform_name'] },
  },
};

/** The catalog entry of a code; undefined for a code the catalog does not know. */
export function definitionOf(code: string): TemplateCodeDefinition | undefined {
  return Object.hasOwn(CATALOG, code) ? CATALOG[code] : undefined;
}

/** The SMS variables the code defines for a variant (empty when it defines none). */
export function variablesOf(code: string, variant: string): readonly string[] {
  const variables = definitionOf(code)?.variables ?? {};
  if (Object.hasOwn(variables, variant)) return variables[variant] ?? [];
  return variables[DEFAULT_VARIANT] ?? [];
}

/** The template type the console may register (D10-337: SMS_CODE verification, others notice). */
export function lockedTemplateType(code: string): SmsTemplateType {
  return code === VERIFY_CODE ? 'verify' : 'notice';
}

/** Built-in sample values of the test send, by variable name (synthetic, no real data). */
const SAMPLES: Readonly<Record<string, string>> = {
  code: '123456',
  amount: '¥10',
  net: '¥10',
  sum: '¥10',
  rebate: '¥1',
  n: '2',
  reason: '收款账号信息有误',
  title_short: '示例商品',
  payout_channel_name: '支付宝',
  platform_name: '淘宝',
  expires_at: '2026-12-31 23:59',
};

/** The sample of one variable: the operator's, else the built-in one. */
export function sampleOf(name: string, given: Readonly<Record<string, string>>): string {
  if (Object.hasOwn(given, name)) {
    const value = given[name];
    if (typeof value === 'string') return value;
  }
  const builtIn = Object.hasOwn(SAMPLES, name) ? SAMPLES[name] : undefined;
  return builtIn ?? '示例';
}
