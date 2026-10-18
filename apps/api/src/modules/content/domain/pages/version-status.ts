// page_versions.status (F1-09f, 编排者裁定 13; 9.14): a thin adapter over the generated page
// version state machine (specs/state-machines/page-version.yaml → @couli/domain
// transitionPageVersion; events DRAFT_SAVED / PUBLISH / ROLLBACK). It keeps no transition table
// of its own: every target status comes from the generated transition, and anything the table
// does not allow (an unknown stored value included) throws. Pure: no Nest, no data access.
//
// - newPageVersionStatus: the status of a newly saved version row (P1, null → DRAFT_SAVED).
// - pageVersionChange: the checked change of a stored version's status by PUBLISH or ROLLBACK
//   (P2, P3); the page config store re-derives it before its `WHERE status = from` CAS.
import {
  PAGE_VERSION_STATES,
  type PageVersionEvent,
  type PageVersionState,
  transitionPageVersion,
} from '@couli/domain';

export type PageVersionStatus = PageVersionState;

/** The events that change a stored version's status (DRAFT_SAVED only creates a row). */
export type PageVersionChangeEvent = Exclude<PageVersionEvent, 'DRAFT_SAVED'>;

/** A legal change of page_versions.status, as returned by pageVersionChange. */
export interface PageVersionTransition {
  readonly from: PageVersionStatus;
  readonly event: PageVersionChangeEvent;
  readonly to: PageVersionStatus;
}

export function isPageVersionStatus(value: unknown): value is PageVersionStatus {
  return (PAGE_VERSION_STATES as readonly unknown[]).includes(value);
}

/** A change the generated table refuses (an unknown value included); a bug, not a 20001. */
export class PageVersionTransitionError extends Error {
  readonly from: unknown;
  readonly event: unknown;

  constructor(from: unknown, event: unknown) {
    super(`page version: illegal status change ${String(from)} on ${String(event)}`);
    this.name = 'PageVersionTransitionError';
    this.from = from;
    this.event = event;
  }
}

function next(from: PageVersionStatus | null, event: PageVersionEvent): PageVersionStatus {
  const result = transitionPageVersion(from, event);
  if (!result.ok || result.noop) throw new PageVersionTransitionError(from, event);
  return result.to;
}

/** The status a newly saved version row is inserted with (P1: null → DRAFT_SAVED). */
export function newPageVersionStatus(): PageVersionStatus {
  return next(null, 'DRAFT_SAVED');
}

/** Whether the generated table has a change of the stored status `from` by `event`. */
export function canChangePageVersion(from: unknown, event: PageVersionChangeEvent): boolean {
  if (!isPageVersionStatus(from)) return false;
  const result = transitionPageVersion(from, event);
  return result.ok && !result.noop;
}

/** The checked change of a stored status by `event`; throws PageVersionTransitionError otherwise. */
export function pageVersionChange(from: unknown, event: unknown): PageVersionTransition {
  if (!isPageVersionStatus(from) || (event !== 'PUBLISH' && event !== 'ROLLBACK')) {
    throw new PageVersionTransitionError(from, event);
  }
  return Object.freeze({ from, event, to: next(from, event) });
}
