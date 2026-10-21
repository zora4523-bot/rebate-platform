// Order list / detail helpers: contract types, the list query (applied conditions <-> request
// parameters), Beijing dates and times, admin amounts (BR-TEXT-10 through @couli/money, integer
// fen only), basis-point percentages (integer arithmetic) and the console dictionary names of the
// statuses (BR-TEXT-25 admin_dict.*; the code itself while the dictionary has no row for it).
// No copy lives here (texts/orders.ts).
import type { Schema } from '@couli/contracts-ts';
import { formatYuanAdmin, parseFen } from '@couli/money';
import { AdminApiError } from '../../providers/data/index.ts';
import { ordersTexts as t } from '../../texts/orders.ts';

export type OrderRow = Schema<'AdminOrderListItem'>;
export type OrderPage = Schema<'AdminOrderPage'>;
export type OrderDetail = Schema<'AdminOrderDetail'>;
export type PlatformCode = Schema<'PlatformCode'>;
export type PlatformStatus = Schema<'AdminOrderPlatformStatus'>;
export type RebateStatus = Schema<'AdminOrderRebateStatus'>;
export type OrderFlag = Schema<'AdminOrderFlag'>;

export const ORDERS_URL = '/admin/v1/orders';
export const orderUrl = (orderId: string): string => `${ORDERS_URL}/${encodeURIComponent(orderId)}`;

/** page_size of the list (contract ≤ 200). */
export const PAGE_SIZE = 20;
/** q after removing spaces: 1–64 characters (adminListOrders). */
export const QUERY_MAX = 64;

export const PLATFORMS: readonly PlatformCode[] = [
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
];
/** Contract enum order (AdminOrderPlatformStatus). */
export const PLATFORM_STATUSES: readonly PlatformStatus[] = [
  'DEPOSIT_PAID',
  'PAID',
  'RECEIVED',
  'SETTLED',
  'INVALID',
];
/** Contract enum order (AdminOrderRebateStatus). */
export const REBATE_STATUSES: readonly RebateStatus[] = [
  'UNATTRIBUTED',
  'ESTIMATED',
  'WAITING',
  'CREDITED',
  'VOID',
  'CLAWED_BACK',
];
/** Contract enum order (AdminOrderFlag). */
export const FLAGS: readonly OrderFlag[] = ['locked', 'status_locked', 'rights_pending', 'hold'];

/** Applied list conditions (what the last 【查询】 sent); dates are Beijing calendar days. */
export interface OrderQuery {
  readonly page: number;
  readonly platform?: PlatformCode | undefined;
  readonly platformStatus?: PlatformStatus | undefined;
  readonly rebateStatus?: RebateStatus | undefined;
  readonly flag?: OrderFlag | undefined;
  readonly q?: string | undefined;
  readonly userId?: string | undefined;
  /** YYYY-MM-DD, first paid day (inclusive). */
  readonly paidFrom?: string | undefined;
  /** YYYY-MM-DD, last paid day (inclusive on screen; sent as the next day's midnight). */
  readonly paidTo?: string | undefined;
}

export const FIRST_PAGE: OrderQuery = { page: 1 };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** Midnight at the start of a Beijing day as ISO 8601 with offset. */
export function dayStart(day: string): string {
  return `${day}T00:00:00+08:00`;
}

/** Midnight after a Beijing day (the exclusive end of that day) as ISO 8601 with offset. */
export function dayEnd(day: string): string {
  const found = DAY.exec(day);
  if (found === null) return dayStart(day);
  const next = new Date(Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3]) + 1));
  return dayStart(
    `${next.getUTCFullYear()}-${two(next.getUTCMonth() + 1)}-${two(next.getUTCDate())}`,
  );
}

/** Request parameters of adminListOrders (absent conditions are left out). */
export function requestQuery(query: OrderQuery): Record<string, string | number> {
  return {
    page: query.page,
    page_size: PAGE_SIZE,
    ...(query.platform === undefined ? {} : { platform: query.platform }),
    ...(query.platformStatus === undefined ? {} : { platform_status: query.platformStatus }),
    ...(query.rebateStatus === undefined ? {} : { rebate_status: query.rebateStatus }),
    ...(query.flag === undefined ? {} : { flag: query.flag }),
    ...(query.q === undefined ? {} : { q: query.q }),
    ...(query.userId === undefined ? {} : { user_id: query.userId }),
    ...(query.paidFrom === undefined ? {} : { paid_from: dayStart(query.paidFrom) }),
    ...(query.paidTo === undefined ? {} : { paid_to: dayEnd(query.paidTo) }),
  };
}

/** Whether any filter (not the page) is applied. */
export function hasConditions(query: OrderQuery): boolean {
  return (
    query.platform !== undefined ||
    query.platformStatus !== undefined ||
    query.rebateStatus !== undefined ||
    query.flag !== undefined ||
    query.q !== undefined ||
    query.userId !== undefined ||
    query.paidFrom !== undefined ||
    query.paidTo !== undefined
  );
}

/** Router state of the detail subpage and of 【返回】: the list conditions to restore. */
export interface OrdersBackState {
  readonly ordersQuery: OrderQuery;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((candidate) => candidate === value);
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function dayOf(value: unknown): string | undefined {
  return typeof value === 'string' && DAY.test(value) ? value : undefined;
}

/** The conditions carried by router state (only well-formed values survive), else undefined. */
export function backQueryOf(state: unknown): OrderQuery | undefined {
  if (typeof state !== 'object' || state === null || !('ordersQuery' in state)) return undefined;
  const raw: unknown = state.ordersQuery;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const page = value['page'];
  return {
    page: typeof page === 'number' && Number.isInteger(page) && page >= 1 ? page : 1,
    platform: oneOf(PLATFORMS, value['platform']),
    platformStatus: oneOf(PLATFORM_STATUSES, value['platformStatus']),
    rebateStatus: oneOf(REBATE_STATUSES, value['rebateStatus']),
    flag: oneOf(FLAGS, value['flag']),
    q: textOf(value['q']),
    userId: textOf(value['userId']),
    paidFrom: dayOf(value['paidFrom']),
    paidTo: dayOf(value['paidTo']),
  };
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function beijingParts(iso: string): Date | undefined {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : new Date(ms + BEIJING_OFFSET_MS);
}

/** YYYY-MM-DD of a time in Beijing; null shows the dash, unreadable input is shown as is. */
export function beijingDate(iso: string | null): string {
  if (iso === null) return t.dash;
  const date = beijingParts(iso);
  if (date === undefined) return iso;
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
}

/** HH:mm (or HH:mm:ss) of a time in Beijing; null shows the dash. */
export function beijingClock(iso: string | null, seconds = false): string {
  if (iso === null) return t.dash;
  const date = beijingParts(iso);
  if (date === undefined) return iso;
  const base = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
  return seconds ? `${base}:${two(date.getUTCSeconds())}` : base;
}

/** YYYY-MM-DD HH:mm:ss in Beijing; null shows the dash. */
export function beijingTime(iso: string | null): string {
  if (iso === null) return t.dash;
  if (beijingParts(iso) === undefined) return iso;
  return `${beijingDate(iso)} ${beijingClock(iso, true)}`;
}

/** Admin amount (BR-TEXT-10: ¥, thousands, two decimals); null (not known) shows the dash. */
export function money(fen: number | null): string {
  if (fen === null) return t.dash;
  return formatYuanAdmin(parseFen(fen));
}

/** Basis points (1/10000) as a percentage with two decimals, integer arithmetic only. */
export function percent(bp: number | null): string {
  if (bp === null || !Number.isSafeInteger(bp)) return t.dash;
  const magnitude = Math.abs(bp);
  const sign = bp < 0 ? '-' : '';
  return `${sign}${Math.trunc(magnitude / 100)}.${two(magnitude % 100)}%`;
}

export const platformLabel = (code: string): string => t.platforms[code] ?? code;

interface AdminDictionary {
  readonly texts: Readonly<Record<string, string>>;
}

// The bundled console dictionary (contracts/texts.admin.default.json, BR-TEXT-25). A Vite glob
// keeps the JSON outside this package's TypeScript project while Vite and Vitest inline it.
const loaded = import.meta.glob<AdminDictionary>(
  '../../../../../contracts/texts.admin.default.json',
  { eager: true, import: 'default' },
);
const dictionary: Readonly<Record<string, string>> = Object.values(loaded)[0]?.texts ?? {};

export type DictKind = 'platform_status' | 'rebate_status' | 'hold_reason';

/** The dictionary name of a code (admin_dict.<kind>.<code>), undefined while it has no row. */
export function dictName(kind: DictKind, code: string): string | undefined {
  const key = `admin_dict.${kind}.${code}`;
  return Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
}

/** 「中文 CODE」 with a dictionary row (BR-TEXT-18 double column), else the code alone. */
export function codeLabel(kind: DictKind, code: string): string {
  const name = dictName(kind, code);
  return name === undefined ? code : `${name} ${code}`;
}

/** antd preset Tag colour by status (the text carries the meaning). */
export function toneOf(code: string): 'success' | 'warning' | 'error' | 'processing' | 'default' {
  if (code === 'SETTLED' || code === 'CREDITED') return 'success';
  if (code === 'UNATTRIBUTED') return 'warning';
  if (code === 'INVALID' || code === 'VOID' || code === 'CLAWED_BACK') return 'error';
  return 'default';
}

export type FailureKind = 'forbidden' | 'invalid' | 'failed';

/** 10403 no permission, 20001 parameters (unknown or not visible for the detail), else failed. */
export function failureOf(cause: unknown): FailureKind {
  if (!(cause instanceof AdminApiError)) return 'failed';
  if (cause.code === 10403) return 'forbidden';
  if (cause.code === 20001) return 'invalid';
  return 'failed';
}

/** A detail address is only a UUID-shaped order_id (/orders/<uuid>). */
export const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
