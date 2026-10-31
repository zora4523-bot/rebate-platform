// Helpers of the user detail tabs (F1-07jb): which list tabs an account may open, the console
// dictionary names of the statuses (BR-TEXT-25 admin_dict.*; the code itself while there is no
// row) and admin amounts (BR-TEXT-10 through @couli/money, integer fen only). No copy lives here.
import { formatYuanAdmin, parseFen } from '@couli/money';
import { AdminApiError } from '../../../providers/data/index.ts';
import { usersTexts } from '../../../texts/users.ts';

/** The tab keys (the tab state is kept in the view, not in the address). */
export type TabKey = 'overview' | 'tabOrderList' | 'claimList' | 'withdrawalList';
export type ListKey = Exclude<TabKey, 'overview'>;

/** page_size of every tab list (contract ≤ 200). */
export const TAB_PAGE_SIZE = 20;

interface Access {
  can(permission: string): boolean;
}

/**
 * Whether the account may read a tab's list for one user (contract descriptions):
 * adminListOrders order.view, or user.lookup with user_id; adminListClaims order.claim, or
 * user.lookup with user_id; listAdminWithdrawals withdraw.review or fund.view.
 */
export function canOpen(access: Access, key: ListKey): boolean {
  if (key === 'tabOrderList') return access.can('order.view') || access.can('user.lookup');
  if (key === 'claimList') return access.can('order.claim') || access.can('user.lookup');
  return access.can('withdraw.review') || access.can('fund.view');
}

interface AdminDictionary {
  readonly texts: Readonly<Record<string, string>>;
}

// The bundled console dictionary (contracts/texts.admin.default.json, BR-TEXT-25), inlined by
// Vite and Vitest like on the list pages.
const loaded = import.meta.glob<AdminDictionary>(
  '../../../../../../contracts/texts.admin.default.json',
  { eager: true, import: 'default' },
);
const dictionary: Readonly<Record<string, string>> = Object.values(loaded)[0]?.texts ?? {};

/** admin_dict.<kind>.<code>, else the code. */
export function dictLabel(kind: string, code: string): string {
  const key = `admin_dict.${kind}.${code}`;
  const name = Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
  return typeof name === 'string' && name !== '' ? name : code;
}

/** Admin amount (¥, thousands, two decimals, minus sign kept); null shows the dash. */
export function adminMoney(fen: number | null | undefined): string {
  if (fen === null || fen === undefined) return usersTexts.dash;
  return formatYuanAdmin(parseFen(fen));
}

export type TabFailure = 'forbidden' | 'failed';

/** 10403 is no permission; everything else (network, server, parameters) is a failed read. */
export function tabFailureOf(cause: unknown): TabFailure {
  return cause instanceof AdminApiError && cause.code === 10403 ? 'forbidden' : 'failed';
}
