// B2-04p: pure helpers of the batch executor (no I/O, no wall clock).
import { createHash } from 'node:crypto';
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

/** B2-04zf: what one settle run looks like once a batch of it moved to DONE or PARTIAL. */
export type RunRest =
  | { readonly settled: false }
  | { readonly settled: true; readonly outcome: 'done' | 'partial'; readonly batchCount: number };

/** One batch of a settle run as runRest sees it. */
export interface RunMember {
  readonly status: string;
  /** paused_by_switch_at is set (SB5 c): a CONFIRMED batch that a switch stopped before it started. */
  readonly pausedBySwitch: boolean;
}

/**
 * D10-477: a run rests when none of its batches is EXECUTING or waiting to start any more; the rest
 * is 'partial' when one of them was stopped by a switch, else 'done'. Stopped by a switch means
 * PARTIAL (SB7), or CONFIRMED with paused_by_switch_at set (SB5 c: only SB10 may start it, so it
 * does not block). DRAFT and CANCELLED batches neither count nor block (they are not executed).
 */
export function runRest(members: readonly RunMember[]): RunRest {
  const counted = members.filter((m) => m.status !== 'DRAFT' && m.status !== 'CANCELLED');
  if (counted.length === 0) return { settled: false };
  const stopped = (m: RunMember): boolean =>
    m.status === 'PARTIAL' || (m.status === 'CONFIRMED' && m.pausedBySwitch);
  const waiting = (m: RunMember): boolean =>
    m.status === 'EXECUTING' || (m.status === 'CONFIRMED' && !m.pausedBySwitch);
  if (counted.some(waiting)) return { settled: false };
  return {
    settled: true,
    outcome: counted.some(stopped) ? 'partial' : 'done',
    batchCount: counted.length,
  };
}

/** One counted batch of a resting run, as runCredited sees it. */
export interface RunCreditMember {
  readonly status: string;
  /**
   * Items of the batch with result 'credited' whose credit happened in this execution, i.e. after
   * settle_runs.part_started_at (all of them while the run has no published part yet; D10-492 ④).
   */
  readonly creditedItems: number;
  /** finished_at is after settle_runs.part_started_at (true for every DONE batch before part 1). */
  readonly doneSinceStart: boolean;
}

/**
 * D10-477 补正: a resting run publishes only when this execution credited something — a batch that
 * reached DONE since the execution started (every DONE batch while no part was published yet), or
 * a PARTIAL batch with items credited since then (a continue stopped again before its first credit
 * counts zero). Batches paused before they started credit nothing.
 */
export function runCredited(members: readonly RunCreditMember[]): boolean {
  return members.some(
    (m) =>
      (m.status === 'DONE' && m.doneSinceStart) || (m.status === 'PARTIAL' && m.creditedItems > 0),
  );
}

/**
 * The event id of settle.run_done for (app, settle run, part): a name-based UUID (RFC 9562
 * version 8 layout, SHA-256 of the key), so the same part always has the same id.
 */
export function runDoneEventId(appId: string, settleRunId: string, part: number): string {
  const hex = createHash('sha256')
    .update(`settle.run_done\u0000${appId}\u0000${settleRunId}\u0000${String(part)}`)
    .digest('hex');
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
