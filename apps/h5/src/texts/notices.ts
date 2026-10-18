// Texts of the H5 notice list and notice detail (F1-03c). 08 BR-TEXT-14 has no keys for them yet;
// the orchestrator registers that gap. Notice titles, summaries and bodies come from the server.
export const noticesTexts = {
  /** Footer under the last notice once every page is loaded. */
  noMore: '没有更多公告了',
  loadMore: '加载更多',
  loadingMore: '加载中…',
  /** A later page of the list failed; the notices so far stay. */
  moreFailed: '更多公告加载失败',
  emptyTitle: '暂无公告',
  emptyDescription: '新的公告发布后会显示在这里',
  loadFailedTitle: '加载失败',
  loadFailedDescription: '网络不太稳定，请稍后重试',
  retry: '重试',
  /** Detail of a notice that is unknown, unpublished or taken down (30701), or a malformed id. */
  goneTitle: '公告不存在或已下线',
  goneDescription: '可以返回列表查看其他公告',
  backToList: '返回公告列表',
  /** Byline under the detail title; `time` is Beijing time as YYYY-MM-DD HH:mm. */
  byline: (time: string): string => `凑狸 · ${time}`,
} as const;
