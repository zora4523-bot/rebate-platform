// 版本管理页的纯函数：契约类型、地址、x.y.z 版本比较、「是否提高了最低支持版本」（契约
// adminSaveAppVersion：原来没有行或为 null 也算提高）、保存前核对要列出的落后商店（BR-ID-01 细则
// 「【去更新】打开哪家商店与保存前的核对」，以服务端判定为准，这里只用来列出整组确认的商店）、
// 表单草稿与请求体互转、北京时间与字典名称。文案不放这里（texts/app-versions.ts）。
import type { Schema } from '@couli/contracts-ts';
import { AdminApiError } from '../../providers/data/index.ts';

export type AppVersionRow = Schema<'AdminAppVersion'>;
export type SaveRequest = Schema<'AdminAppVersionSaveRequest'>;
export type EditablePlatform = Schema<'AppVersionEditablePlatform'>;
export type ChannelCode = Schema<'InstallChannelCode'>;

export const LIST_URL = '/admin/v1/app-versions';
export const STEP_UP_URL = '/admin/v1/auth/step-up';
export const PERMISSION = 'content.app_version';
export const RAISE_OPERATION = 'content.app_version.raise_min_supported_version';
/** 本页菜单编号（resources/index.ts）与编辑子页地址 /app-versions/<platform>/<channel>。 */
export const MENU_ID = 'app-versions';

export const EDITABLE_PLATFORMS: readonly EditablePlatform[] = ['ios', 'android', 'harmony'];
const CHANNELS: readonly ChannelCode[] = ['appstore', 'official', 'huawei', 'agc'];

export function rowUrl(platform: string, channel: string): string {
  return `${LIST_URL}/${encodeURIComponent(platform)}/${encodeURIComponent(channel)}`;
}

export function isEditable(platform: string): platform is EditablePlatform {
  return (EDITABLE_PLATFORMS as readonly string[]).includes(platform);
}

export interface EditTarget {
  readonly platform: EditablePlatform;
  readonly channel: ChannelCode;
}

/** 编辑子页地址（不带开头斜杠的 app-versions/<platform>/<channel>）里的端与渠道，否则 undefined。 */
export function editTargetOf(path: string): EditTarget | undefined {
  const found = /^\/*app-versions\/([^/]+)\/([^/]+)\/?$/.exec(path);
  if (found === null) return undefined;
  const platform = found[1]!;
  const channel = found[2]!;
  if (!isEditable(platform) || !(CHANNELS as readonly string[]).includes(channel)) return undefined;
  return { platform, channel: channel as ChannelCode };
}

export function editPath(target: EditTarget): string {
  return `/${MENU_ID}/${target.platform}/${target.channel}`;
}

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** x.y.z 逐段按数字比较；任一边不是 x.y.z 时 undefined（不猜大小）。 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = SEMVER.exec(a);
  const right = SEMVER.exec(b);
  if (left === null || right === null) return undefined;
  for (let i = 1; i <= 3; i++) {
    // 每段可能超过安全整数，按长度再按字典序比较（无前导零）。
    const x = left[i]!;
    const y = right[i]!;
    if (x.length !== y.length) return x.length < y.length ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 这次保存是否提高了最低支持版本：保存后为 null 不算；原来没有行或为 null 算提高；
 * 无法比较（格式不对）而又与原值不同时按提高处理，先验证再交服务端判定。
 */
export function raisesMinimum(before: string | null | undefined, after: string | null): boolean {
  if (after === null) return false;
  if (before === null || before === undefined) return true;
  const order = compareVersions(after, before);
  if (order === undefined) return after !== before;
  return order > 0;
}

/**
 * 默认商店以外、已上架版本低于（保存后的）最低支持版本的商店，按登记顺序、不重复。
 * 未登记已上架版本（null）的商店不算落后。
 */
export function laggingStores(body: SaveRequest): { store: string; listed: string }[] {
  const minimum = body.min_supported_version;
  if (minimum === null) return [];
  const seen = new Set<string>();
  const result: { store: string; listed: string }[] = [];
  for (const listing of body.store_listings) {
    if (listing.store === body.default_store || seen.has(listing.store)) continue;
    if (listing.listed_version === null) continue;
    if (compareVersions(listing.listed_version, minimum) === -1) {
      seen.add(listing.store);
      result.push({ store: listing.store, listed: listing.listed_version });
    }
  }
  return result;
}

export interface ListingDraft {
  /** 本页内的行标识（增删、调序后 React 仍能对上同一行）。 */
  readonly id: number;
  readonly store: string;
  readonly listed: string;
}

export interface Draft {
  readonly latest: string;
  readonly minimum: string;
  readonly recommended: string;
  readonly title: string;
  readonly notes: string;
  readonly storeUrl: string;
  readonly defaultStore: string;
  readonly listings: readonly ListingDraft[];
}

let nextListingId = 1;
export function newListingId(): number {
  nextListingId += 1;
  return nextListingId;
}

export function draftOf(row: AppVersionRow | undefined): Draft {
  return {
    latest: row?.latest_version ?? '',
    minimum: row?.min_supported_version ?? '',
    recommended: row?.recommended_version ?? '',
    title: row?.update_title ?? '',
    notes: row?.update_notes ?? '',
    storeUrl: row?.store_url ?? '',
    defaultStore: row?.default_store ?? '',
    listings: (row?.store_listings ?? []).map((listing) => ({
      id: newListingId(),
      store: listing.store,
      listed: listing.listed_version ?? '',
    })),
  };
}

/** 留空（只有空白）即 null；其余照填写原样发送，由服务端校验。 */
function nullable(value: string): string | null {
  return value.trim() === '' ? null : value;
}

/** 整行请求体；`expected_row_version` 为读取到的 row_version，没有行时 null。 */
export function requestOf(draft: Draft, original: AppVersionRow | undefined): SaveRequest {
  return {
    latest_version: draft.latest,
    min_supported_version: nullable(draft.minimum),
    recommended_version: nullable(draft.recommended),
    update_title: draft.title,
    update_notes: draft.notes,
    store_url: draft.storeUrl,
    default_store: draft.defaultStore,
    store_listings: draft.listings.map((listing) => ({
      store: listing.store,
      listed_version: nullable(listing.listed),
    })),
    confirmed_stores: [],
    expected_row_version: original === undefined ? null : original.row_version,
  };
}

/** 页面在字段旁提示的字段（20001 data.fields 的首段，如 store_listings[1].store → store_listings）。 */
export const FIELD_NAMES = [
  'platform',
  'channel',
  'latest_version',
  'min_supported_version',
  'recommended_version',
  'update_title',
  'update_notes',
  'store_url',
  'default_store',
  'store_listings',
] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

export function fieldNameOf(field: string): FieldName | 'confirmed_stores' | undefined {
  const head = field.split(/[.[]/, 1)[0] ?? '';
  if (head === 'confirmed_stores') return head;
  return (FIELD_NAMES as readonly string[]).includes(head) ? (head as FieldName) : undefined;
}

export function codeOf(cause: unknown): number | undefined {
  return cause instanceof AdminApiError ? cause.code : undefined;
}

export function isNetwork(cause: unknown): boolean {
  return cause instanceof AdminApiError && cause.kind === 'network';
}

function dataOf(cause: unknown): Record<string, unknown> | undefined {
  if (!(cause instanceof AdminApiError)) return undefined;
  const data: unknown = cause.data;
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
}

export function fieldsOf(cause: unknown): string[] {
  const fields = dataOf(cause)?.['fields'];
  return Array.isArray(fields) ? fields.filter((f): f is string => typeof f === 'string') : [];
}

export function tierOf(cause: unknown): 'totp' | 'sms' | undefined {
  const tier = dataOf(cause)?.['tier'];
  return tier === 'totp' || tier === 'sms' ? tier : undefined;
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const two = (n: number): string => String(n).padStart(2, '0');

/** 北京时间 YYYY-MM-DD HH:mm；读不出时原样显示。 */
export function beijingTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms + BEIJING_OFFSET_MS);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

interface AdminDictionary {
  readonly texts: Readonly<Record<string, string>>;
}

// 随包的后台字典（contracts/texts.admin.default.json，BR-TEXT-25），做法同订单页：Vite glob 让
// JSON 留在本包 TypeScript 工程之外，由 Vite 与 Vitest 内联。
const loaded = import.meta.glob<AdminDictionary>(
  '../../../../../contracts/texts.admin.default.json',
  { eager: true, import: 'default' },
);
const dictionary: Readonly<Record<string, string>> = Object.values(loaded)[0]?.texts ?? {};

export type DictKind = 'client_platform' | 'install_channel' | 'app_store';

/** 字典有键时「中文 编码」，缺键只显示编码。 */
export function codeLabel(kind: DictKind, code: string): string {
  const key = `admin_dict.${kind}.${code}`;
  return Object.hasOwn(dictionary, key) ? `${dictionary[key]} ${code}` : code;
}

export function targetLabel(platform: string, channel: string): string {
  return `${codeLabel('client_platform', platform)} · ${codeLabel('install_channel', channel)}`;
}
