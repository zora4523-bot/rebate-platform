// page_versions.status transition table (F1-09f, 编排者裁定 13; 0040_pages.sql: draft /
// published / rolled_back). Pure: no Nest, no data access, erasable syntax only.
//
// TODO(规划/11 §4.5): 换用生成的 transition() — blocked on 页面版本状态机 yaml（specs/state-machines/page-version.yaml，另立任务）
// Until then this function is the single place that says which version status changes are legal;
// the page config store applies it before its `WHERE status = from` CAS, and the console's publish
// and rollback reach page_versions.status only through it.
//
// - draft → published (publish, gray or full; a version is published once)
// - published → rolled_back (rollback of the gray or the fully released version)
// - rolled_back is final; a same-status rewrite is not a transition (going full keeps published)

export type PageVersionStatus = 'draft' | 'published' | 'rolled_back';

/** A legal change of page_versions.status, as returned by transitionPageVersion. */
export interface PageVersionTransition {
  readonly from: PageVersionStatus;
  readonly to: PageVersionStatus;
}

const NEXT: Readonly<Record<PageVersionStatus, readonly PageVersionStatus[]>> = Object.freeze({
  draft: Object.freeze(['published'] as const),
  published: Object.freeze(['rolled_back'] as const),
  rolled_back: Object.freeze([] as const),
});

export function isPageVersionStatus(value: unknown): value is PageVersionStatus {
  return value === 'draft' || value === 'published' || value === 'rolled_back';
}

/** An illegal page version status change (an unknown value included); a bug, not a 20001. */
export class PageVersionTransitionError extends Error {
  readonly from: unknown;
  readonly to: unknown;

  constructor(from: unknown, to: unknown) {
    super(`page version: illegal status change ${String(from)} → ${String(to)}`);
    this.name = 'PageVersionTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** The checked change from → to; throws PageVersionTransitionError when the table has no such edge. */
export function transitionPageVersion(from: unknown, to: unknown): PageVersionTransition {
  if (!isPageVersionStatus(from) || !isPageVersionStatus(to) || !NEXT[from].includes(to)) {
    throw new PageVersionTransitionError(from, to);
  }
  return Object.freeze({ from, to });
}
