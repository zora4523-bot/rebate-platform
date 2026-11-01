// 消息中心页（F1-04c）的文案。先取契约字典 contracts/texts.default.json（经 t()），字典还没有的键
// 用这里的包内默认：页标题与列表状态句按规格 design/specs/app-messages.md 与画板措辞（08 无键，
// 由编排者登记补键）；字典补上后以字典为准。消息标题与正文由服务端渲染（BR-TEXT-09、BR-TEXT-23）。
import { t } from '../shared/texts.ts';

/** 字典缺键时的包内默认，键名与字典同形。messages.* 已在字典里，这里的值只在字典缺键时兜底。 */
const messagesDefaults: Readonly<Record<string, string>> = {
  'messages.empty': '暂时没有消息',
  'messages.empty_hint': '跟单、返利结算和提现的通知会出现在这里',
  'messages.load_more': '上拉加载更多',
  'messages.read_all': '全部已读',
  'messages.unread': '未读',
};

/** 字典有值用字典（含占位符填充），否则用包内默认；都没有返回空串。 */
export function messagesText(key: string, params: Readonly<Record<string, string>> = {}): string {
  const contract = t(key, params);
  if (contract !== '') return contract;
  const local = Object.hasOwn(messagesDefaults, key) ? messagesDefaults[key] : undefined;
  if (local === undefined) return '';
  return local.replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? (params[name] ?? whole) : whole,
  );
}

/** 08 没有字典键的页面文字（编排者登记补键）。 */
export const messagesTexts = {
  /** 页标题（画板 Messages 导航栏；08 inbox.title.* 是消息种类标题，不是页标题）。 */
  title: '消息中心',
  /** BR-TEXT-11 相对日期词。 */
  today: '今天',
  yesterday: '昨天',
  /** 全部加载完后的到底提示。 */
  end: '没有更多消息了',
  /** 下一页加载失败；已显示的消息保留。 */
  moreFailed: '更多消息加载失败',
  retry: '重试',
  /** 已有消息时下拉刷新失败（10405 改用字典 error.10405）；已显示的消息保留。 */
  refreshFailed: '刷新失败',
  /** 下拉刷新进行中。 */
  refreshing: '正在刷新…',
  /** 翻页加载进行中（读屏）。 */
  loadingMore: '正在加载…',
} as const;
