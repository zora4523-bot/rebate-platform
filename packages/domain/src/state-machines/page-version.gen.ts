// 生成物，勿手改。来源：specs/state-machines/page-version.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type PageVersionState =
  | 'draft'
  | 'published'
  | 'rolled_back';

export const PAGE_VERSION_STATES: readonly PageVersionState[] = ['draft', 'published', 'rolled_back'];

export type PageVersionEvent =
  | 'DRAFT_SAVED'
  | 'PUBLISH'
  | 'ROLLBACK';

export const PAGE_VERSION_EVENTS: readonly PageVersionEvent[] = ['DRAFT_SAVED', 'PUBLISH', 'ROLLBACK'];

export interface PageVersionTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (PageVersionState | null | '*')[];
  readonly event: PageVersionEvent | null;
  readonly to: PageVersionState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const PAGE_VERSION_TRANSITIONS: readonly PageVersionTransitionRow[] = [
  {
    id: 'P1',
    from: [null],
    event: 'DRAFT_SAVED',
    to: 'draft',
    guard: '后台账号持 content.page 权限存草稿，按 pages.revision 做 CAS，插入新版本行（publish_at、publisher 为空）',
    test_id: 'AC-F1-09h#1',
  },
  {
    id: 'P2',
    from: ['draft'],
    event: 'PUBLISH',
    to: 'published',
    guard: '持 content.page 权限发布：gray_percent 取 1..99 为灰度（按 device_id 哈希分桶，无 device_id 给全量版，OPS-05）或 100 为全量；每个版本只发布一次，同时写 publish_at 与 publisher',
    test_id: 'AC-F1-09h#1',
  },
  {
    id: 'P3',
    from: ['published'],
    event: 'ROLLBACK',
    to: 'rolled_back',
    guard: '人工回滚灰度中或已全量的已发布版本（持 content.page 权限）；自动回滚（TECH-29）只在本版本 render_count ≥200 时触发，走同一迁移；rolled_back 为终态',
    test_id: 'AC-F1-09h#1',
  },
];

export type PageVersionTransitionResult =
  | { ok: true; to: PageVersionState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionPageVersion(from: PageVersionState | null, event: PageVersionEvent): PageVersionTransitionResult {
  for (const row of PAGE_VERSION_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as PageVersionState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
