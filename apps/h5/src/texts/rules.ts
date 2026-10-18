// Texts of the H5 rules page and the shared article body (F1-03a). 08 BR-TEXT-14 has no keys for
// them yet; the orchestrator registers that gap. Article titles and bodies come from the server.
export const rulesTexts = {
  /** "Updated on" line under the article title; `date` is the Beijing calendar date. */
  updatedAt: (date: string): string => `更新于 ${date}`,
  /** Accessible name of the card listing the other rule articles. */
  otherRules: '其他规则',
  loadFailedTitle: '加载失败',
  loadFailedDescription: '网络不太稳定，请稍后重试',
  retry: '重试',
  /** A later page of the rule list failed; the entries so far stay. */
  moreFailed: '更多规则加载失败',
  emptyTitle: '暂无规则内容',
  emptyDescription: '规则发布后会显示在这里',
  /** Article body that is not a valid document (shared article body component). */
  bodyFailed: '正文无法显示，请稍后再试',
} as const;
