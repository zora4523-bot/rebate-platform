// 平台资金台账页的数据辅助：平台名（后台字典有键用字典，否则用现有后台页面的名字，再缺显示编码）、
// 后台金额（BR-TEXT-10，经 @couli/money，只用整数分、不做客户端运算）、日期区间预检与查询参数、
// 错误分类。这里不放文案。
import { formatYuanAdmin, parseFen } from '@couli/money';
import type { Schema } from '@couli/contracts-ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { fundLedgerTexts as t } from '../../texts/fund-ledger.ts';

export type AssetSnapshot = Schema<'AdminAssetSnapshot'>;
export type AssetSnapshotPage = Schema<'AdminAssetSnapshotPage'>;
export type AssetSnapshotReceivable = Schema<'AdminAssetSnapshotReceivable'>;

export const LIST_URL = '/admin/v1/asset-snapshots';

/** page_size of the daily ledger (contract ≤ 200). */
export const PAGE_SIZE = 20;

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

/** admin_dict.platform.<code>, else the name the console pages use, else the code. */
export function platformLabel(code: string): string {
  const key = `admin_dict.platform.${code}`;
  const name = Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
  if (typeof name === 'string' && name !== '') return name;
  return Object.hasOwn(t.platforms, code) ? (t.platforms[code] ?? code) : code;
}

/** Admin amount (BR-TEXT-10: ¥, thousands, two decimals, minus sign kept), as the snapshot wrote it. */
export function money(fen: number): string {
  return formatYuanAdmin(parseFen(fen));
}

/** Applied list conditions (what the last 【查询】 sent). */
export interface Filters {
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

/** Draft of the filter form (days as typed). */
export interface Draft {
  readonly dateFrom: string;
  readonly dateTo: string;
}

export const EMPTY_DRAFT: Draft = { dateFrom: '', dateTo: '' };

export interface DraftErrors {
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

const DAY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** A real calendar day written YYYY-MM-DD. */
function isDay(value: string): boolean {
  const found = DAY.exec(value);
  if (found === null) return false;
  const [year, month, date] = [Number(found[1]), Number(found[2]), Number(found[3])];
  const real = new Date(Date.UTC(year, month - 1, date));
  return real.toISOString().slice(0, 10) === value;
}

/** Checks the draft before sending (YYYY-MM-DD, from ≤ to, as the server does). */
export function checkDraft(draft: Draft): { filters: Filters } | { errors: DraftErrors } {
  const from = draft.dateFrom.trim();
  const to = draft.dateTo.trim();
  const errors: { dateFrom?: string; dateTo?: string } = {};
  if (from !== '' && !isDay(from)) errors.dateFrom = t.filter.dateInvalid;
  if (to !== '' && !isDay(to)) errors.dateTo = t.filter.dateInvalid;
  if (errors.dateFrom === undefined && errors.dateTo === undefined && from !== '' && to !== '')
    if (from > to) {
      errors.dateFrom = t.filter.dateRange;
      errors.dateTo = t.filter.dateRange;
    }
  if (errors.dateFrom !== undefined || errors.dateTo !== undefined) return { errors };
  return {
    filters: {
      ...(from === '' ? {} : { dateFrom: from }),
      ...(to === '' ? {} : { dateTo: to }),
    },
  };
}

/** Query parameters of listAdminAssetSnapshots for a page under `filters`. */
export function listQuery(filters: Filters, page: number): Record<string, string | number> {
  return {
    page,
    page_size: PAGE_SIZE,
    ...(filters.dateFrom === undefined ? {} : { date_from: filters.dateFrom }),
    ...(filters.dateTo === undefined ? {} : { date_to: filters.dateTo }),
  };
}

export const codeOf = (cause: unknown): number | undefined =>
  cause instanceof AdminApiError ? cause.code : undefined;

/** The rejected fields of a 20001 answer (data.fields), else none. */
export function rejectedFields(cause: unknown): readonly string[] {
  if (!(cause instanceof AdminApiError)) return [];
  const data = cause.data;
  if (typeof data !== 'object' || data === null) return [];
  const fields = (data as { fields?: unknown }).fields;
  return Array.isArray(fields)
    ? fields.filter((one): one is string => typeof one === 'string')
    : [];
}
