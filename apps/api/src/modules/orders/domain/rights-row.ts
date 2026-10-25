// B1-09k: the cells of one rights / punish import row (08 BR-FUND-06 细则「维权导入任务」; template
// column names and values ruled by the orchestrator, 任务书补充; real templates wait on K-3). Pure:
// no Nest, no data access, no wall clock.
//   - sub_order_id / parent_order_id: a text cell trimmed of leading / trailing white space (empty →
//     absent); an integer number cell is its decimal text (non-negative safe integers only); any
//     other cell is unreadable. Neither number given, or a given one unreadable → invalid;
//   - platform (optional column): empty → not compared; a text, trimmed; anything else → invalid;
//   - rights_no: as an order number; empty → null;
//   - status (rights only): PROCESSING / SUCCEEDED / FAILED (trimmed); punish rows are SUCCEEDED and
//     the column is not read;
//   - amount / deduction_commission: yuan with at most two decimals, not negative, as a text or a
//     number cell (a number is read as its shortest decimal text, never × 100 in floating point);
//     converted by @couli/money yuanStrToFen; empty → null;
//   - occurred_at (required): a Date cell as the instant it is (the sheet reader already re-read
//     serial dates at +08:00), or an ISO 8601 text as for channel rows (with Z or an offset as given,
//     without one or date only at +08:00); numbers and anything else → invalid.
import { yuanStrToFen } from '@couli/money';
import type { OrderRightsStatus } from '@couli/contracts-ts';
import { channelEndAtMs, channelRelationId, type ChannelCell } from './channel-row.ts';
import { instantAt } from './sync-window.ts';

export type RightsRowKind = 'rights' | 'punish';

export interface CheckedRightsRow {
  /** null: only the parent order number is given (sub_order_no_missing, never expanded). */
  readonly sub_order_id: string | null;
  /** null: the row names no platform (not compared). */
  readonly platform: string | null;
  readonly rights_no: string | null;
  readonly status: OrderRightsStatus;
  readonly amount_fen: bigint | null;
  readonly deduction_commission_fen: bigint | null;
  readonly occurred_at: Date;
}

export type RightsRowCheck =
  { readonly ok: true; readonly row: CheckedRightsRow } | { readonly ok: false };

const ROW_STATUSES: readonly OrderRightsStatus[] = ['PROCESSING', 'SUCCEEDED', 'FAILED'];

const isBlank = (cell: ChannelCell): boolean =>
  cell === null || (typeof cell === 'string' && cell.trim() === '');

/** undefined: unreadable; null: empty. */
function orderNoOf(cell: ChannelCell): string | null | undefined {
  if (isBlank(cell)) return null;
  return channelRelationId(cell) ?? undefined;
}

const YUAN = /^[0-9]+(?:\.[0-9]{1,2})?$/;

/** Fen of a yuan cell; null when empty, undefined when unreadable. */
export function rightsAmountFen(cell: ChannelCell): bigint | null | undefined {
  if (isBlank(cell)) return null;
  let text: string;
  if (typeof cell === 'string') text = cell.trim();
  else if (typeof cell === 'number' && Number.isFinite(cell)) text = String(cell);
  else return undefined;
  if (!YUAN.test(text)) return undefined;
  try {
    return yuanStrToFen(text);
  } catch {
    return undefined;
  }
}

/** The instant of an occurred_at cell; null when absent or unreadable. `like` lends a Date. */
export function rightsOccurredAt(cell: ChannelCell, like: Date): Date | null {
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : cell;
  if (typeof cell !== 'string') return null;
  const ms = channelEndAtMs(cell);
  return ms === null ? null : instantAt(like, ms);
}

export function checkRightsRow(
  kind: RightsRowKind,
  values: Readonly<Record<string, ChannelCell>>,
  like: Date,
): RightsRowCheck {
  const cell = (name: string): ChannelCell => values[name] ?? null;
  const sub = orderNoOf(cell('sub_order_id'));
  if (sub === undefined) return { ok: false };
  if (sub === null) {
    const parent = orderNoOf(cell('parent_order_id'));
    if (parent === undefined || parent === null) return { ok: false };
  }
  const platformCell = cell('platform');
  let platform: string | null = null;
  if (!isBlank(platformCell)) {
    if (typeof platformCell !== 'string') return { ok: false };
    platform = platformCell.trim();
  }
  const rightsNo = orderNoOf(cell('rights_no'));
  if (rightsNo === undefined) return { ok: false };
  let status: OrderRightsStatus = 'SUCCEEDED';
  if (kind === 'rights') {
    const text = cell('status');
    const found = ROW_STATUSES.find((s) => typeof text === 'string' && text.trim() === s);
    if (found === undefined) return { ok: false };
    status = found;
  }
  const amount = rightsAmountFen(cell('amount'));
  const deduction = rightsAmountFen(cell('deduction_commission'));
  if (amount === undefined || deduction === undefined) return { ok: false };
  const occurredAt = rightsOccurredAt(cell('occurred_at'), like);
  if (occurredAt === null) return { ok: false };
  return {
    ok: true,
    row: {
      sub_order_id: sub,
      platform,
      rights_no: rightsNo,
      status,
      amount_fen: amount,
      deduction_commission_fen: deduction,
      occurred_at: occurredAt,
    },
  };
}
