// B1-09h: the cells of one channel import row (08 BR-ATTR-26 细则「渠道单导入」; values ruled by the
// orchestrator, 任务书「取值补充」). Pure: no Nest, no data access, no wall clock.
//   - relation_id: a text cell trimmed of leading / trailing white space (empty after trimming →
//     invalid); an integer number cell is its decimal text (non-negative safe integers only: a
//     larger one has already lost digits in the sheet); any other cell → invalid;
//   - end_at: empty (null, or a text of white space only) → null (in force until stopped); a Date
//     cell as is; an ISO 8601 text — date, or date and time with `T` or a space — with Z or an
//     offset as given, without one read at +08:00 (a date alone = 00:00 +08:00 that day), never
//     the server's zone; anything else (numbers such as Excel serials included) → invalid.
//     end_at must be later than start_at (= the task's acceptance time; checkChannelRow).
import { instantAt } from './sync-window.ts';

/** One sheet cell (the same as application/rights-import-ports.ts RightsImportCell). */
export type ChannelCell = string | number | boolean | Date | null;

/** +08:00, the zone of a time written without an offset. */
const LOCAL_OFFSET_MINUTES = 8 * 60;

/** The relation_id text of a cell; null when the cell is not a usable relation id. */
export function channelRelationId(cell: ChannelCell): string | null {
  if (typeof cell === 'string') {
    const text = cell.trim();
    return text === '' ? null : text;
  }
  if (typeof cell === 'number') {
    return Number.isSafeInteger(cell) && cell >= 0 ? String(cell) : null;
  }
  return null;
}

const TEXT_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function offsetMinutes(text: string | undefined): number | null {
  if (text === undefined) return LOCAL_OFFSET_MINUTES;
  if (text.toUpperCase() === 'Z') return 0;
  const sign = text.startsWith('-') ? -1 : 1;
  const digits = text.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = digits.length > 2 ? Number(digits.slice(2)) : 0;
  if (hours > 23 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

/** Epoch milliseconds of an ISO 8601 text as ruled above; null when unreadable. */
export function channelEndAtMs(text: string): number | null {
  const m = TEXT_INSTANT.exec(text.trim());
  if (m === null) return null;
  const [, y, mo, d, hh, mi, ss, frac, zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = hh === undefined ? 0 : Number(hh);
  const minute = mi === undefined ? 0 : Number(mi);
  const second = ss === undefined ? 0 : Number(ss);
  const ms = frac === undefined ? 0 : Number(frac.padEnd(3, '0').slice(0, 3));
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const offset = offsetMinutes(zone);
  if (offset === null) return null;
  return Date.UTC(year, month - 1, day, hour, minute, second, ms) - offset * 60_000;
}

export type ChannelEndAt =
  { readonly ok: true; readonly end_at: Date | null } | { readonly ok: false };

/** The end_at of a cell; `like` only lends a Date to build the instant on (no wall clock). */
export function channelEndAt(cell: ChannelCell, like: Date): ChannelEndAt {
  if (cell === null) return { ok: true, end_at: null };
  if (cell instanceof Date) {
    return Number.isNaN(cell.getTime()) ? { ok: false } : { ok: true, end_at: cell };
  }
  if (typeof cell !== 'string') return { ok: false };
  if (cell.trim() === '') return { ok: true, end_at: null };
  const ms = channelEndAtMs(cell);
  return ms === null ? { ok: false } : { ok: true, end_at: instantAt(like, ms) };
}

export type ChannelRowCheck =
  | { readonly ok: true; readonly relation_id: string; readonly end_at: Date | null }
  | { readonly ok: false };

/** One row's cells against the task's acceptance time (start_at): end_at must be later. */
export function checkChannelRow(
  values: Readonly<Record<string, ChannelCell>>,
  startAt: Date,
): ChannelRowCheck {
  const relationId = channelRelationId(values['relation_id'] ?? null);
  if (relationId === null) return { ok: false };
  const end = channelEndAt(values['end_at'] ?? null, startAt);
  if (!end.ok) return { ok: false };
  if (end.end_at !== null && end.end_at.getTime() <= startAt.getTime()) return { ok: false };
  return { ok: true, relation_id: relationId, end_at: end.end_at };
}
