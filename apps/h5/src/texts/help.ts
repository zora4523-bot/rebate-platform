// Texts of the H5 help centre (F1-03b). 08 BR-TEXT-14 has no keys for them yet; the orchestrator
// registers that gap. Question titles and article bodies come from the server, never from here.
export const helpTexts = {
  /** Page heading of the help home. */
  title: '帮助中心',
  /** Heading of the question list card. */
  faq: '常见问题',
  loadMore: '加载更多',
  /** A later page of the question list failed; the entries so far stay. */
  moreFailed: '更多问题加载失败',
  loadFailedTitle: '加载失败',
  loadFailedDescription: '网络不太稳定，请稍后重试',
  retry: '重试',
  emptyTitle: '暂无常见问题',
  emptyDescription: '问题发布后会显示在这里',
  /** Support card at the bottom of the help home. */
  supportTitle: '没找到答案？',
  supportDescription: '联系客服，人工帮你看',
  contactSupport: '联系客服',
  /** Support entry under an article. */
  articleSupport: '还有问题，联系客服',
  /** Tag next to the date of an article (the contract has no help sub-categories). */
  articleTag: '帮助',
  /** "Updated on" line of an article; `date` is the Beijing calendar date. */
  updatedAt: (date: string): string => `更新于 ${date}`,
  notFoundTitle: '文章不存在或已下线',
  notFoundDescription: '回到帮助中心看看其他问题',
  backHome: '返回帮助首页',
} as const;
