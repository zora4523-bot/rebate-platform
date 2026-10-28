// 「消息模板」页的数据形状与小工具（契约 CT-24t：adminListNotifyChannels、adminSwitchNotifyChannels、
// adminRegisterNotifySms、adminDiscardNotifySms、adminRetestNotifySms、adminEnableNotifySms）。
// 可改性一律只读接口字段，前端不写死编码名单。
import type { Schema } from '@couli/contracts-ts';
import { AdminApiError } from '../../providers/data/index.ts';

export type ChannelItem = Schema<'AdminNotifyChannelItem'>;
export type SmsVariantRow = Schema<'AdminNotifySmsVariantRow'>;
export type SmsActive = Schema<'AdminNotifySmsActive'>;
export type SmsPending = Schema<'AdminNotifySmsPending'>;
export type SwitchRequest = Schema<'AdminNotifyChannelSwitchRequest'>;
export type RegisterRequest = Schema<'AdminNotifySmsRegisterRequest'>;
export type RetestRequest = Schema<'AdminNotifySmsRetestRequest'>;
export type EnableRequest = Schema<'AdminNotifySmsEnableRequest'>;
export type SmsResult = Schema<'AdminNotifySmsResult'>;
export type TemplateType = Schema<'AdminSmsTemplateType'>;
export type Me = Schema<'AdminMe'>;
export type SwitchChannel = 'push' | 'sms';
export type NoticeType = 'success' | 'error' | 'warning';
/** 页面顶部的提示条；不传 type 时清掉。 */
export type Notify = (type?: NoticeType, text?: string) => void;
/** 抽屉里能填的部分（row_version 在写那一刻取）。 */
export type RegisterDraft = Omit<RegisterRequest, 'row_version'>;

export const LIST_URL = '/admin/v1/notify-channels';
export const ME_URL = '/admin/v1/me/permissions';
export const STEP_UP_URL = '/admin/v1/auth/step-up';
export const channelUrl = (code: string): string => `${LIST_URL}/${encodeURIComponent(code)}`;
export const smsUrl = (code: string): string => `${channelUrl(code)}/sms`;
export const pendingUrl = (code: string): string => `${smsUrl(code)}/pending`;
export const retestUrl = (code: string): string => `${pendingUrl(code)}/test`;
export const enableUrl = (code: string): string => `${pendingUrl(code)}/enable`;

export const SIGN_MAX = 32;
export const TEMPLATE_MAX = 64;
export const PREVIEW_MAX = 500;

export const codeOf = (error: unknown): number | undefined =>
  error instanceof AdminApiError ? error.code : undefined;

export function fieldsOf(error: unknown): readonly string[] {
  if (!(error instanceof AdminApiError)) return [];
  const data = error.data;
  if (typeof data === 'object' && data !== null && 'fields' in data && Array.isArray(data.fields))
    return data.fields.filter((field): field is string => typeof field === 'string');
  return [];
}

export function reasonOf(error: unknown): string | undefined {
  if (!(error instanceof AdminApiError)) return undefined;
  const data = error.data;
  if (typeof data === 'object' && data !== null && 'reason' in data)
    return typeof data.reason === 'string' ? data.reason : undefined;
  return undefined;
}

/** 10003 且不是「未登记验证手机号」：令牌失效，要再验证一次。 */
export const needsStepUpAgain = (error: unknown): boolean =>
  codeOf(error) === 10003 && reasonOf(error) !== 'verify_phone_missing';

/** 测试发送未受理（服务商拒收或出错 50301，超时或未知 50401）。 */
export const notAccepted = (error: unknown): boolean => {
  const code = codeOf(error);
  return code === 50301 || code === 50401;
};

/** 当前生效渠道里有没有这一渠道（开关的值）。 */
export const hasChannel = (item: ChannelItem, channel: 'inbox' | 'push' | 'sms'): boolean =>
  item.channels.includes(channel);

/** 打开短信要先二次确认（按条计费）：接口说要，且现在是关着的。 */
export const needsBillingConfirm = (item: ChannelItem, channel: SwitchChannel, on: boolean) =>
  channel === 'sms' && on && item.sms_billing_confirm && !hasChannel(item, 'sms');

/** 短信开关置灰：关着且未就绪（sms_ready 为假时接口拒绝打开）。 */
export const smsGreyed = (item: ChannelItem): boolean =>
  !hasChannel(item, 'sms') && !item.sms_ready;

/** 「短信」页签的一行：code × variant（只列 sms_registrations 非空的编码）。 */
export interface SmsRow {
  readonly key: string;
  readonly item: ChannelItem;
  readonly row: SmsVariantRow;
}

export function smsRowsOf(items: readonly ChannelItem[]): SmsRow[] {
  return items.flatMap((item) =>
    item.sms_registrations.map((row) => ({ key: `${item.code}/${row.variant}`, item, row })),
  );
}

export const variantOf = (item: ChannelItem, variant: string): SmsVariantRow | undefined =>
  item.sms_registrations.find((row) => row.variant === variant);

/** 行状态（设计 §2 状态列；不新增状态词）。 */
export type SmsStatus = 'enabled' | 'pending' | 'failed' | 'unregistered';
export function statusOf(row: SmsVariantRow): SmsStatus {
  if (row.pending !== null) return row.pending.test.status === 'failed' ? 'failed' : 'pending';
  return row.active === null ? 'unregistered' : 'enabled';
}

/** 「待测试」登记的测试已受理：可以启用。 */
export const enableReady = (row: SmsVariantRow): boolean => row.pending?.test.status === 'accepted';

/**
 * 模板类型后台不能选（BR-TEXT-20 细则「登记」）：沿用已登记的类型；还没有登记时，带验证码有效期的
 * 编码（接口只给 SMS_CODE 的 sms_code_ttl_sec）锁「验证码」，其余锁「通知」。
 */
export function lockedType(item: ChannelItem, row: SmsVariantRow): TemplateType {
  const registered = row.pending ?? row.active;
  if (registered !== null) return registered.template_type;
  return item.sms_code_ttl_sec === null ? 'notice' : 'verify';
}

/** 保存要测试发送：首次登记，或签名、模板 CODE 与在用配置不同（契约：否则只原地替换）。 */
export const needsTestSend = (row: SmsVariantRow, draft: RegisterDraft): boolean =>
  row.active === null ||
  row.active.sign_name !== draft.sign_name ||
  row.active.template_code !== draft.template_code;

/** 预览正文里的占位（`${name}`，与阿里云模板写法一致），去重。 */
export function placeholdersOf(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(/\$\{([A-Za-z0-9_]+)\}/g), (match) => match[1]!))];
}

/** 前端预检：占位与该变体定义的变量逐个对照（最终以服务端校验为准）。 */
export function variableMismatch(
  text: string,
  variables: readonly string[],
): { extra: string[]; missing: string[] } | undefined {
  const used = placeholdersOf(text);
  const extra = used.filter((name) => !variables.includes(name));
  const missing = variables.filter((name) => !used.includes(name));
  return extra.length === 0 && missing.length === 0 ? undefined : { extra, missing };
}

/** 前端预检：正文写的「N分钟」与验证码有效期（秒）不一致时返回写的分钟数。 */
export function ttlMismatch(text: string, ttlSeconds: number | null): number | undefined {
  if (ttlSeconds === null) return undefined;
  const minutes = Array.from(text.matchAll(/(\d+)\s*分钟/g), (match) => Number(match[1]));
  return minutes.find((value) => value * 60 !== ttlSeconds);
}

/** 20001 的 data.fields 里 preview_text 后面跟着的禁用词（不是字段名的项）。 */
const BODY_FIELDS = new Set([
  'code',
  'variant',
  'sign_name',
  'template_code',
  'template_type',
  'preview_text',
  'sample',
  'row_version',
]);
export function forbiddenWordsOf(fields: readonly string[]): string[] {
  const index = fields.indexOf('preview_text');
  if (index < 0) return [];
  return fields.slice(index + 1).filter((field) => !BODY_FIELDS.has(field));
}
