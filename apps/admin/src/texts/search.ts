// Top-bar search copy (design/specs/admin-search.md; boards AdmSearchMulti, AdmSearchNoHit).
// 08 has no keys for these: board copy, registered as admin.search.*. The no-hit copy never says
// whether the object is missing or outside the account's permissions (BR-ID-34, 一框搜).
import type { AdminSearchHitType } from '@couli/contracts-ts';

const TYPE_LABELS: Readonly<Record<AdminSearchHitType, string>> = {
  order: '订单',
  user: '用户',
  withdrawal: '提现单',
};

export const searchTexts = {
  regionLabel: '一框搜',
  placeholder: '订单号 / 提现单号 / 手机号 / UID',
  /** Type name of a hit (BR-TEXT-25 admin_dict wording). */
  typeLabel: (type: AdminSearchHitType): string => TYPE_LABELS[type],
  /** Screen-reader name of a candidate: 「<类型名> <id> <summary>」. */
  optionName: (type: AdminSearchHitType, id: string, summary: string): string =>
    `${TYPE_LABELS[type]} ${id} ${summary}`,
  listLabel: '搜索结果',
  multiHeader: (query: string, count: number): string =>
    `「${query}」匹配 ${count} 条，上下键切换，回车打开高亮项，Esc 关闭`,
  truncated: '结果较多，只显示前 10 条，请输入更完整的号码',
  footer:
    '按形状识别：订单号 / 提现单号 / 完整 11 位手机号 / UID（04 §6.6 search）。结果按 user.lookup、order.view、fund.view 裁剪；按手机号命中会写操作日志（同 user.lookup）。',
  noHitTitle: (query: string): string => `没有找到「${query}」`,
  noHitDescription: '按订单号、提现单号、完整手机号、UID 都没有匹配。',
  noHitFooter: '手机号须输入完整 11 位；订单号、提现单号、UID 按完整值匹配。',
  /** 20001 fields=[q] or a query over 64 characters (checked locally before sending). */
  invalid: '请输入 1–64 个字的号码',
  /** Network failure, 5xx or any other error (BR-TEXT-14 wording). */
  failed: '网络异常或服务暂不可用，搜索失败，请稍后重试。',
} as const;
