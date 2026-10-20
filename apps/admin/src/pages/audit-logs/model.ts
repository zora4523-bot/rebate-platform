// Audit log helpers: Beijing-time display and input, the list query (contract parameter names,
// empty values left out) and the before / after difference rows. No copy lives here
// (texts/audit-logs.ts).
import type { Schema } from '@couli/contracts-ts';

export type AuditRow = Schema<'AdminAuditLogListItem'>;
export type AuditDetail = Schema<'AdminAuditLog'>;
export type AuditFilters = Schema<'AdminExportAuditLogFilters'>;

/** page_size of the list (contract ≤ 200). */
export const PAGE_SIZE = 20;

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** YYYY-MM-DD HH:mm:ss in Beijing time; unreadable input is shown as is. */
export function beijingTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms + BEIJING_OFFSET_MS);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
}

const TIME_INPUT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * A typed Beijing time (YYYY-MM-DD[ HH:mm[:ss]]) as ISO 8601 with the +08:00 offset; undefined
 * when it is not a real date and time.
 */
export function beijingInput(value: string): string | undefined {
  const parts = TIME_INPUT.exec(value.trim());
  if (parts === null) return undefined;
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = parts;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  // Reject overflowing values (2026-02-30 rolls over in Date).
  const back = new Date(ms + BEIJING_OFFSET_MS);
  if (
    back.getUTCFullYear() !== Number(year) ||
    back.getUTCMonth() + 1 !== Number(month) ||
    back.getUTCDate() !== Number(day) ||
    back.getUTCHours() !== Number(hour) ||
    back.getUTCMinutes() !== Number(minute) ||
    back.getUTCSeconds() !== Number(second)
  )
    return undefined;
  return iso;
}

export interface FilterDraft {
  readonly actor: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly permission: string | undefined;
  readonly from: string;
  readonly to: string;
}

export const EMPTY_DRAFT: FilterDraft = {
  actor: '',
  targetType: '',
  targetId: '',
  permission: undefined,
  from: '',
  to: '',
};

export type DraftResult =
  | { readonly ok: true; readonly filters: AuditFilters }
  | { readonly ok: false; readonly field: 'from' | 'to'; readonly kind: 'format' | 'range' };

/** The draft as contract filters (AND); blank fields are left out. */
export function filtersOf(draft: FilterDraft): DraftResult {
  const filters: { -readonly [K in keyof AuditFilters]: AuditFilters[K] } = {};
  const actor = draft.actor.trim();
  const targetType = draft.targetType.trim();
  const targetId = draft.targetId.trim();
  if (actor !== '') filters.actor_id = actor;
  if (targetType !== '') filters.target_type = targetType;
  if (targetId !== '') filters.target_id = targetId;
  if (draft.permission !== undefined && draft.permission !== '')
    filters.permission = draft.permission;
  if (draft.from.trim() !== '') {
    const from = beijingInput(draft.from);
    if (from === undefined) return { ok: false, field: 'from', kind: 'format' };
    filters.from = from;
  }
  if (draft.to.trim() !== '') {
    const to = beijingInput(draft.to);
    if (to === undefined) return { ok: false, field: 'to', kind: 'format' };
    filters.to = to;
  }
  if (
    filters.from !== undefined &&
    filters.to !== undefined &&
    Date.parse(filters.from) > Date.parse(filters.to)
  )
    return { ok: false, field: 'from', kind: 'range' };
  return { ok: true, filters };
}

/** A missing side of a difference row (new or removed field, or no value recorded at all). */
export const ABSENT: unique symbol = Symbol('absent');
export type Side = unknown;

export interface DiffRow {
  /** Field name; undefined for the whole value (before / after are not both objects). */
  readonly field: string | undefined;
  readonly before: Side;
  readonly after: Side;
  readonly changed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural JSON equality (key order does not matter). */
export function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameJson(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => key in right && sameJson(left[key], right[key]));
  }
  return false;
}

/**
 * Rows of the before / after view: one per field when each recorded side is an object (a null
 * side counts as absent), otherwise one row for the whole value. Both null: no rows.
 */
export function diffRows(before: unknown, after: unknown): DiffRow[] {
  const beforeAbsent = before === null || before === undefined;
  const afterAbsent = after === null || after === undefined;
  if (beforeAbsent && afterAbsent) return [];
  const beforeFields = beforeAbsent || isRecord(before);
  const afterFields = afterAbsent || isRecord(after);
  if (beforeFields && afterFields) {
    const left = isRecord(before) ? before : {};
    const right = isRecord(after) ? after : {};
    const keys = [...Object.keys(left), ...Object.keys(right).filter((key) => !(key in left))];
    return keys.map((key) => {
      const hasBefore = key in left;
      const hasAfter = key in right;
      const beforeValue = hasBefore ? left[key] : ABSENT;
      const afterValue = hasAfter ? right[key] : ABSENT;
      return {
        field: key,
        before: beforeValue,
        after: afterValue,
        changed: hasBefore !== hasAfter || !sameJson(beforeValue, afterValue),
      };
    });
  }
  return [
    {
      field: undefined,
      before: beforeAbsent ? ABSENT : before,
      after: afterAbsent ? ABSENT : after,
      changed: beforeAbsent !== afterAbsent || !sameJson(before, after),
    },
  ];
}

/** Display text of one recorded value: strings as is, everything else as JSON. */
export function valueText(value: unknown, dash: string): string {
  if (value === ABSENT) return dash;
  if (typeof value === 'string') return value;
  if (value === undefined) return dash;
  return JSON.stringify(value);
}
