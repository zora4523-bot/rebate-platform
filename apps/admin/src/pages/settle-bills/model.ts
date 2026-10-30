// 月结账单页的数据辅助：账单状态、批次状态、结算方式、批次类型、明细类型与结果的后台字典名
// （BR-TEXT-25，缺键显示编码）、后台金额（BR-TEXT-10，经 @couli/money，只用整数分、不做客户端
// 运算）、北京时间、筛选条件到查询参数、错误分类。这里不放文案。
import { formatYuanAdmin, parseFen } from '@couli/money';
import { admin_settle_bill_status, settle_batch_item_type, type Schema } from '@couli/contracts-ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { settleBillsTexts as t } from '../../texts/settle-bills.ts';

export type SettleBill = Schema<'AdminSettleBill'>;
export type SettleBillDetail = Schema<'AdminSettleBillDetail'>;
export type SettleBatch = Schema<'AdminSettleBatch'>;
export type SettleBatchItem = Schema<'AdminSettleBatchItem'>;
export type SettleBillStatus = Schema<'AdminSettleBillStatus'>;
export type SettleBatchItemType = Schema<'AdminSettleBatchItemType'>;
export type SettleBatchItemResultFilter = Schema<'AdminSettleBatchItemResultFilterValue'>;

export const LIST_URL = '/admin/v1/settle-bills';
export const billUrl = (billId: string): string => `${LIST_URL}/${encodeURIComponent(billId)}`;
export const itemsUrl = (batchId: string): string =>
  `/admin/v1/settle-batches/${encodeURIComponent(batchId)}/items`;

/** page_size of the bill list and of the batch items (contract ≤ 200). */
export const PAGE_SIZE = 20;

export const BILL_STATUSES: readonly SettleBillStatus[] = admin_settle_bill_status;
export const ITEM_TYPES: readonly SettleBatchItemType[] = settle_batch_item_type;
/** The result filter: the three results, or pending = not executed yet (result null). */
export const ITEM_RESULTS: readonly SettleBatchItemResultFilter[] = [
  'credited',
  'skipped',
  'deferred',
  'pending',
];

interface AdminDictionary {
  readonly texts: Readonly<Record<string, string>>;
}

// 随包的后台字典（contracts/texts.admin.default.json，BR-TEXT-25）。Vite glob 让 JSON 留在本包
// TS 工程之外，Vite 与 Vitest 会把它内联。
const loaded = import.meta.glob<AdminDictionary>(
  '../../../../../contracts/texts.admin.default.json',
  { eager: true, import: 'default' },
);
const dictionary: Readonly<Record<string, string>> = Object.values(loaded)[0]?.texts ?? {};

function dictName(key: string, code: string): string {
  const name = Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
  return typeof name === 'string' && name !== '' ? name : code;
}

/** admin_dict.settle_bill.status.<code> (契约线补行), else the code. */
export const billStatusLabel = (code: string): string =>
  dictName(`admin_dict.settle_bill.status.${code}`, code);
/** admin_dict.settle_batch.status.<code>, else the code. */
export const batchStatusLabel = (code: string): string =>
  dictName(`admin_dict.settle_batch.status.${code}`, code);
/** admin_dict.settle_mode.<code>, else the code. */
export const settleModeLabel = (code: string): string =>
  dictName(`admin_dict.settle_mode.${code}`, code);
/** admin_dict.settle_batch.kind.<code> (契约线补行), else the code. */
export const batchKindLabel = (code: string): string =>
  dictName(`admin_dict.settle_batch.kind.${code}`, code);
/** admin_dict.settle_batch_item.item_type.<code> (契约线补行), else the code. */
export const itemTypeLabel = (code: string): string =>
  dictName(`admin_dict.settle_batch_item.item_type.${code}`, code);
/** admin_dict.settle_batch_item.result.<code> (契约线补行; pending = not executed), else the code. */
export const itemResultLabel = (code: string): string =>
  dictName(`admin_dict.settle_batch_item.result.${code}`, code);

/** Admin amount (BR-TEXT-10: ¥, thousands, two decimals, minus sign kept); null shows the dash. */
export function money(fen: number | null): string {
  return fen === null ? t.dash : formatYuanAdmin(parseFen(fen));
}

/** A count as given; null (still generating) shows the dash. */
export function count(value: number | null): string {
  return value === null ? t.dash : String(value);
}

/** Per-platform entries as the contract gives them (no sum on the client). */
export function platformEntries(
  values: Readonly<Record<string, number>> | null,
): readonly (readonly [string, number])[] {
  return values === null ? [] : Object.entries(values);
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const two = (value: number): string => String(value).padStart(2, '0');

/** YYYY-MM-DD HH:mm:ss in Beijing; null shows the dash, unreadable input is shown as is. */
export function beijingTime(iso: string | null): string {
  if (iso === null) return t.dash;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

/** Applied list conditions (what the last 【查询】 sent). */
export interface Filters {
  readonly billFrom?: string;
  readonly billTo?: string;
  readonly status?: SettleBillStatus;
}

/** Draft of the filter form (months as typed). */
export interface Draft {
  readonly billFrom: string;
  readonly billTo: string;
  readonly status: SettleBillStatus | undefined;
}

export const EMPTY_DRAFT: Draft = { billFrom: '', billTo: '', status: undefined };

const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export interface DraftErrors {
  readonly billFrom?: string;
  readonly billTo?: string;
}

/** Checks the draft before sending (YYYY-MM, from ≤ to, as the server does). */
export function checkDraft(draft: Draft): { filters: Filters } | { errors: DraftErrors } {
  const from = draft.billFrom.trim();
  const to = draft.billTo.trim();
  const errors: { billFrom?: string; billTo?: string } = {};
  if (from !== '' && !MONTH.test(from)) errors.billFrom = t.filter.monthInvalid;
  if (to !== '' && !MONTH.test(to)) errors.billTo = t.filter.monthInvalid;
  if (errors.billFrom === undefined && errors.billTo === undefined && from !== '' && to !== '')
    if (from > to) {
      errors.billFrom = t.filter.monthRange;
      errors.billTo = t.filter.monthRange;
    }
  if (errors.billFrom !== undefined || errors.billTo !== undefined) return { errors };
  return {
    filters: {
      ...(from === '' ? {} : { billFrom: from }),
      ...(to === '' ? {} : { billTo: to }),
      ...(draft.status === undefined ? {} : { status: draft.status }),
    },
  };
}

/** Query parameters of listAdminSettleBills for a page under `filters`. */
export function listQuery(filters: Filters, page: number): Record<string, string | number> {
  return {
    page,
    page_size: PAGE_SIZE,
    ...(filters.billFrom === undefined ? {} : { bill_from: filters.billFrom }),
    ...(filters.billTo === undefined ? {} : { bill_to: filters.billTo }),
    ...(filters.status === undefined ? {} : { status: filters.status }),
  };
}

/** Applied batch item conditions. */
export interface ItemFilters {
  readonly itemType?: SettleBatchItemType;
  readonly result?: SettleBatchItemResultFilter;
}

/** Query parameters of listAdminSettleBatchItems for a page under `filters`. */
export function itemsQuery(filters: ItemFilters, page: number): Record<string, string | number> {
  return {
    page,
    page_size: PAGE_SIZE,
    ...(filters.itemType === undefined ? {} : { item_type: filters.itemType }),
    ...(filters.result === undefined ? {} : { result: filters.result }),
  };
}

export const codeOf = (cause: unknown): number | undefined =>
  cause instanceof AdminApiError ? cause.code : undefined;
