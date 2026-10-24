// B2-04p: pure helpers of the batch executor (no I/O, no wall clock).
import { chinaDayRange, orderKey } from '@couli/domain';

/** A switch value is on only when it is true or 'on'; anything else (missing included) is off. */
export function switchOn(value: unknown): boolean {
  return value === true || value === 'on';
}

/** The +08:00 calendar day before `date` (YYYY-MM-DD), only through the calendar primitives. */
export function previousDay(date: string): string {
  const day = Number(date.slice(8, 10));
  if (day > 1) return `${date.slice(0, 8)}${String(day - 1).padStart(2, '0')}`;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const prevMonth =
    month === 1
      ? `${String(year - 1).padStart(4, '0')}-12`
      : `${date.slice(0, 4)}-${String(month - 1).padStart(2, '0')}`;
  for (const last of [31, 30, 29, 28]) {
    const candidate = `${prevMonth}-${String(last)}`;
    try {
      if (chinaDayRange(candidate).end.slice(0, 10) === date) return candidate;
    } catch {
      // That month has no such day; try the next one.
    }
  }
  throw new RangeError(`cannot derive the day before ${date}`);
}

export interface SortableItem {
  readonly id: string;
  readonly item_type: string;
  readonly platform: string;
  readonly sub_order_id: string;
  readonly user_id: string | null;
  readonly role: string | null;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 规划/12 §4.3: ascending order_key (code-unit order, independent of the database collation);
 * on one order the sub-order item before its beneficiary items, then user, role and item id so the
 * order is total and stable across deliveries.
 */
export function compareItems(a: SortableItem, b: SortableItem): number {
  return (
    compareText(orderKey(a.platform, a.sub_order_id), orderKey(b.platform, b.sub_order_id)) ||
    (a.item_type === b.item_type ? 0 : a.item_type === 'order' ? -1 : 1) ||
    compareText(a.user_id ?? '', b.user_id ?? '') ||
    compareText(a.role ?? '', b.role ?? '') ||
    compareText(a.id, b.id)
  );
}
