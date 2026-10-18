// 生成物，勿手改。来源：specs/state-machines/article-version.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type ArticleVersionState =
  | 'draft'
  | 'published'
  | 'offline';

export const ARTICLE_VERSION_STATES: readonly ArticleVersionState[] = ['draft', 'published', 'offline'];

export type ArticleVersionEvent =
  | 'DRAFT_SAVED'
  | 'PUBLISH'
  | 'OFFLINE';

export const ARTICLE_VERSION_EVENTS: readonly ArticleVersionEvent[] = ['DRAFT_SAVED', 'PUBLISH', 'OFFLINE'];

export interface ArticleVersionTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (ArticleVersionState | null | '*')[];
  readonly event: ArticleVersionEvent | null;
  readonly to: ArticleVersionState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const ARTICLE_VERSION_TRANSITIONS: readonly ArticleVersionTransitionRow[] = [
  {
    id: 'A1',
    from: [null],
    event: 'DRAFT_SAVED',
    to: 'draft',
    guard: '后台账号持 content.article 权限新建文章或存草稿，按 expected_row_version 做 CAS（CT-02s），插入新版本行（version = 该 id 最大 version + 1，新建为 1；published_at 为空）',
    test_id: 'AC-F1-02u#1',
  },
  {
    id: 'A2',
    from: ['draft'],
    event: 'PUBLISH',
    to: 'published',
    guard: '持 content.article 权限发布；只能发布该 id 的最新版本行（更旧的草稿留在 draft，不再可发布）；写 published_at（立即 = Clock 当前时刻，定时 = 请求给的未来时刻）；同 id 更早的 published 行不改，仍是 published（当前版本 = 已发布行里最大 version）',
    test_id: 'AC-F1-02u#1',
  },
  {
    id: 'A3',
    from: ['published'],
    event: 'OFFLINE',
    to: 'offline',
    guard: '持 content.article 权限整篇下线：同一事务把该 id 全部 status=published 的行（含定时未到的）逐行经本迁移改为 offline；draft 行不动；offline 为终态',
    test_id: 'AC-F1-02u#1',
  },
];

export type ArticleVersionTransitionResult =
  | { ok: true; to: ArticleVersionState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionArticleVersion(from: ArticleVersionState | null, event: ArticleVersionEvent): ArticleVersionTransitionResult {
  for (const row of ARTICLE_VERSION_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as ArticleVersionState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
