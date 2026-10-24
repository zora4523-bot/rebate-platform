// 联盟账号页的数据形状与小工具：后台字典读取（BR-TEXT-25，缺键显示编码）、北京时间、错误分类。
import type { Schema } from '@couli/contracts-ts';
import type { DataProvider } from '@refinedev/core';
import { AdminApiError } from '../../providers/data/index.ts';
import { ordersTexts } from '../../texts/orders.ts';
import { unionsTexts as t } from '../../texts/unions.ts';

export type UnionAccount = Schema<'AdminUnionAccount'>;
/** 推广位登记用的联盟账号选项（CT-24s adminListUnionAccountOptions）：只有编号、平台、名称。 */
export type UnionAccountOption = Schema<'AdminUnionAccountOption'>;
export type ReauthSession = Schema<'AdminUnionReauthSession'>;
export type ReauthResult = Schema<'AdminUnionReauthResult'>;
export type AlertPhones = Schema<'AdminUnionAlertPhones'>;
export type AlertPhone = AlertPhones['items'][number];

export const ACCOUNTS_URL = '/admin/v1/union-accounts';
export const PHONES_URL = `${ACCOUNTS_URL}/alert-phones`;
export const CALLBACK_URL = `${ACCOUNTS_URL}/oauth/callback`;
/** union.pid 或 union.account_auth 任一即可读；不分页。 */
export const ACCOUNT_OPTIONS_URL = '/admin/v1/union/account-options';
export const STEP_UP_URL = '/admin/v1/auth/step-up';
export const REASON_MAX = 200;
export const CREDENTIAL_MAX = 512;

export const startUrl = (accountId: string): string =>
  `${ACCOUNTS_URL}/${encodeURIComponent(accountId)}/reauthorize`;
export const pollUrl = (accountId: string, sessionId: string): string =>
  `${startUrl(accountId)}/${encodeURIComponent(sessionId)}`;
export const credentialUrl = (accountId: string): string =>
  `${ACCOUNTS_URL}/${encodeURIComponent(accountId)}/credential`;

interface AdminDictionary {
  readonly texts: Readonly<Record<string, string>>;
}

// 随包的后台字典（contracts/texts.admin.default.json）。用 Vite glob 让 JSON 留在本包 TS 工程之外，
// 由 Vite 与 Vitest 内联（同 pages/orders/model.ts）。
const loaded = import.meta.glob<AdminDictionary>(
  '../../../../../contracts/texts.admin.default.json',
  { eager: true, import: 'default' },
);
const dictionary: Readonly<Record<string, string>> = Object.values(loaded)[0]?.texts ?? {};

/** admin_dict.union_accounts.<field>.<code> 的名字；字典没有这一行时显示编码本身。 */
export function dictLabel(field: 'auth_status' | 'last_probe_ok', code: string): string {
  const key = `admin_dict.union_accounts.${field}.${code}`;
  return Object.hasOwn(dictionary, key) ? dictionary[key]! : code;
}

export function platformLabel(code: string): string {
  const platforms: Readonly<Record<string, string>> = ordersTexts.platforms;
  return platforms[code] ?? code;
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const two = (value: number): string => String(value).padStart(2, '0');

/** YYYY-MM-DD HH:mm（北京时间）；null 显示破折号，读不懂的原样显示。 */
export function beijingTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return t.dash;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms + BEIJING_OFFSET_MS);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

/**
 * datetime-local 的值（按北京时间理解，YYYY-MM-DDTHH:mm[:ss]）转成 ISO 8601（UTC）；空串为
 * undefined，读不懂为 null。
 */
export function beijingInputToIso(value: string): string | undefined | null {
  const text = value.trim();
  if (text === '') return undefined;
  const found = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(text);
  if (found === null) return null;
  const ms = Date.parse(`${found[1]}T${found[2]}:${found[3] ?? '00'}+08:00`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

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

export const codeOf = (error: unknown): number | undefined =>
  error instanceof AdminApiError ? error.code : undefined;

export const isNetwork = (error: unknown): boolean =>
  !(error instanceof AdminApiError) || error.kind !== 'api';

/** 只接受 http(s) 地址作为授权页面，其他（如 javascript:）一律不打开。 */
export function safeAuthUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Form.Item 的错误态：有提示时标红并把提示放在字段下方（.ant-form-item-explain-error）。 */
export function fieldStatus(error: string | undefined): {
  validateStatus?: 'error';
  help?: string;
} {
  return error === undefined ? {} : { validateStatus: 'error', help: error };
}

/** 后台数据层的 custom 调用（/admin/v1 下任意地址）；没有时是装配错误。 */
export function customOf(provider: DataProvider): NonNullable<DataProvider['custom']> {
  const call = provider.custom;
  if (call === undefined) throw new Error('Missing custom data provider');
  return call;
}

/**
 * 在新窗口打开联盟授权页面（F1-10ga r1 S1）。后台登录态只在本窗口的 sessionStorage 里：用
 * noopener 打开的窗口拿不到副本，联盟跳回 /unions/oauth-callback 时就成了未登录。所以先开一个
 * 保留 opener 的同源空白页（浏览器在建窗时把本页的 sessionStorage 复制过去），立即切断
 * 它的 opener（第三方页面加载之前），再把它导航到授权地址。地址只取自发起授权的响应，并且
 * 只接受 http(s)（safeAuthUrl）。窗口被拦截时返回 false，由对话框里的按钮在点击时重试。
 */
export function openAuthWindow(authUrl: string): boolean {
  const url = safeAuthUrl(authUrl);
  if (url === undefined) return false;
  const popup = window.open('', '_blank');
  if (popup === null) return false;
  try {
    popup.opener = null;
  } catch {
    // 个别浏览器不允许改写；空白页本身不加载任何内容，下面的跳转照常进行。
  }
  popup.location.href = url;
  return true;
}

// —— 推广位（F1-10gb；契约 adminListUnionPids 等，CT-24h）——

export type UnionPid = Schema<'AdminUnionPid'>;
export type PidPlatform = UnionPid['platform'];
export type PidScene = UnionPid['pid_scene'];
export type PidStatus = UnionPid['status'];
export type PidCreateRequest = Schema<'AdminUnionPidCreateRequest'>;
export type PidUpdateRequest = Schema<'AdminUnionPidUpdateRequest'>;
export type PidRetireRequest = Schema<'AdminUnionPidRetireRequest'>;

export const PIDS_URL = '/admin/v1/union-pids';
export const PID_PERMISSION = 'union.pid';
export const pidUrl = (pidId: string): string => `${PIDS_URL}/${encodeURIComponent(pidId)}`;
export const activateUrl = (pidId: string): string => `${pidUrl(pidId)}/activate`;
export const retireUrl = (pidId: string): string => `${pidUrl(pidId)}/retire`;

// 枚举取值同契约 AdminUnionPid（platform、AdminUnionPidScene、AdminUnionPidStatus）。
export const PID_PLATFORMS: readonly PidPlatform[] = ['taobao', 'jd', 'pdd'];
export const PID_SCENES: readonly PidScene[] = [
  'self_buy',
  'agent',
  'share',
  'taolijin',
  'fallback',
  'query',
];
/** AdminUnionPidCode：PID 与 site_id 的写法。 */
export const PID_CODE = /^[0-9A-Za-z_-]{1,64}$/;
/** 花卷云忽略截图：PNG / JPEG，不超过 5 MB（等于 5 MB 可以）。 */
export const EVIDENCE_TYPES: readonly string[] = ['image/png', 'image/jpeg'];
export const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;

function dictionaryValue(keys: readonly string[], code: string): string {
  for (const key of keys) if (Object.hasOwn(dictionary, key)) return dictionary[key]!;
  return code;
}

/** 推广位状态名（admin_dict.union_pids.status.<code>），缺键显示编码。 */
export function pidStatusLabel(code: string): string {
  return dictionaryValue([`admin_dict.union_pids.status.${code}`], code);
}

/**
 * 推广位场景名：BR-TEXT-25 的 admin_dict.<enum>.<code> 可用表列名或枚举名两种写法，先表列名
 * （admin_dict.union_pids.pid_scene.<code>）再枚举名（admin_dict.pid_scene.<code>）；都缺时显示编码。
 */
export function sceneLabel(code: string): string {
  return dictionaryValue(
    [`admin_dict.union_pids.pid_scene.${code}`, `admin_dict.pid_scene.${code}`],
    code,
  );
}

/** 下拉选项里的场景：字典有名字时带上编码，便于核对。 */
export function sceneOption(code: string): string {
  const name = sceneLabel(code);
  return name === code ? code : t.pids.sceneOption(name, code);
}
