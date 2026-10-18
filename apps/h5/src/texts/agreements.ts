// Texts of the H5 agreement page (F1-03c: user agreement, privacy policy, third-party SDK list).
// 08 BR-TEXT-14 has no keys for them yet; the orchestrator registers that gap. Agreement titles and
// bodies come from the server.
export const agreementsTexts = {
  /** Version chip under the title; `version` is Article.version. */
  version: (version: number): string => `版本 ${version}`,
  /** Update-date chip; `date` is the Beijing calendar date of the published version. */
  updatedAt: (date: string): string => `更新日期 ${date}`,
  /** The agreement has no published version yet (30701). */
  unpublishedTitle: '协议暂未发布',
  unpublishedDescription: '协议发布后会显示在这里',
  loadFailedTitle: '加载失败',
  loadFailedDescription: '网络不太稳定，请稍后重试',
  retry: '重试',
} as const;
