// Scheduled page publish (F1-09p; contract adminPublishPageConfig with publish_at,
// adminCancelPageConfigSchedule; 编排者裁定 F1-09p 9.2 Y2 / Y6 / Y8 / Y11). Pure: no Nest, no data
// access, no clock of its own (`now` is the caller's injected Clock reading).
//
// A page row keeps at most one pending schedule (app.pages.scheduled_*). It takes effect by time:
// once `at <= now` the page reads exactly as if the version had been published then by the admin
// who scheduled it (100 = fully released, 1..99 = gray), with revision + 1, whether or not the
// worker's due job has run. The writes and the due job then store that same result (Y8).

/** The page's pending scheduled publish; `by` is an admin id (rows) or a login name (views). */
export interface PageSlot<By = string> {
  readonly version: number;
  /** 1..100: 100 = release fully, 1..99 = gray share. */
  readonly grayPercent: number;
  readonly at: Date;
  readonly by: By;
}

export interface SlotPointers {
  readonly currentVersion: number | null;
  readonly grayVersion: number | null;
  readonly grayPercent: number;
}

/** Y2: a schedule is later than now and at most 30 days after now. */
export const MAX_SCHEDULE_AHEAD_MS = 30 * 86_400_000;

/** Whether the schedule has taken effect at `now` (scheduled_at ≤ now, the equal instant included). */
export function isSlotDue(slot: PageSlot<unknown>, now: Date): boolean {
  return slot.at.getTime() <= now.getTime();
}

/** Y2: publish_at in (now, now + 30 days]. */
export function isSchedulable(at: Date, now: Date): boolean {
  const ms = at.getTime();
  return Number.isFinite(ms) && ms > now.getTime() && ms <= now.getTime() + MAX_SCHEDULE_AHEAD_MS;
}

/** Y11: the due job's delay in whole seconds, rounded up, at least 1. */
export function slotDelaySeconds(at: Date, now: Date): number {
  return Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 1000));
}

/** The pointers after the slot took effect, as an immediate publish of it would have set them. */
export function slotPointers(pointers: SlotPointers, slot: PageSlot<unknown>): SlotPointers {
  return slot.grayPercent === 100
    ? { currentVersion: slot.version, grayVersion: null, grayPercent: 0 }
    : {
        currentVersion: pointers.currentVersion,
        grayVersion: slot.version,
        grayPercent: slot.grayPercent,
      };
}

/** The page row fields the effective view changes. */
export interface ScheduledPage<By> extends SlotPointers {
  readonly revision: number;
  readonly updatedBy: By | null;
  readonly updatedAt: Date | null;
  readonly slot: PageSlot<By> | null;
}

/**
 * The page as it reads at `now` (Y6): a due slot is applied (pointers, revision + 1, updated by
 * the scheduler at the scheduled time, no slot left) and reported as `applied`; otherwise the row
 * unchanged with `applied` null. The input is never modified.
 */
export function effectivePage<R extends ScheduledPage<unknown>>(
  row: R,
  now: Date,
): R & { readonly applied: R['slot'] } {
  const slot = row.slot;
  if (slot === null || !isSlotDue(slot, now)) return { ...row, applied: null };
  return {
    ...row,
    ...slotPointers(row, slot),
    revision: row.revision + 1,
    updatedBy: slot.by,
    updatedAt: slot.at,
    slot: null,
    applied: slot,
  };
}

/** A version as stored: its status and publish stamp. */
export interface VersionStamp<By> {
  readonly version: number;
  readonly status: string;
  readonly publishAt: Date | null;
  readonly publisher: By | null;
}

/**
 * The version as it reads at `now`: the draft named by a due slot reads published at the scheduled
 * time by the scheduler; any other version unchanged.
 */
export function effectiveVersion<V extends VersionStamp<unknown>>(
  version: V,
  slot: PageSlot<V['publisher']> | null,
  now: Date,
): V {
  if (
    slot === null ||
    !isSlotDue(slot, now) ||
    slot.version !== version.version ||
    version.status !== 'draft'
  ) {
    return version;
  }
  return { ...version, status: 'published', publishAt: slot.at, publisher: slot.by };
}

/** The slot of the four nullable columns; null unless all four are set. */
export function slotOf<By>(columns: {
  readonly version: number | null | undefined;
  readonly grayPercent: number | null | undefined;
  readonly at: Date | null | undefined;
  readonly by: By | null | undefined;
}): PageSlot<By> | null {
  const { version, grayPercent, at, by } = columns;
  if (
    version === null ||
    version === undefined ||
    grayPercent === null ||
    grayPercent === undefined ||
    at === null ||
    at === undefined ||
    by === null ||
    by === undefined
  ) {
    return null;
  }
  return { version, grayPercent, at, by };
}
