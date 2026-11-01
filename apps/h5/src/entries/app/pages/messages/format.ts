import type { BridgeMethods } from '@couli/bridge-sdk';
import type { ApiData } from '../../../../shared/api/index.ts';
import { messagesTexts } from '../../../../texts/messages.ts';

export type MessagesListData = ApiData<'GET', '/v1/messages'>;
export type InboxMessage = MessagesListData['items'][number];
/** nav.open 的参数：消息的 route {route, params} 原样交给桥。 */
export type MessageTarget = BridgeMethods['nav.open']['params'];

/** 标题最多显示的字素数（规格 §2「title_short 按字素截取」；契约没有 title_short，前端截取）。 */
export const TITLE_MAX_GRAPHEMES = 24;
const ELLIPSIS = '\u{2026}';

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 上海时区（UTC+8，无夏令时）的 YYYY-MM-DD 与 HH:mm。 */
function shanghai(ms: number): { date: string; time: string } {
  const iso = new Date(ms + BEIJING_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/**
 * BR-TEXT-11 过去时间：上海日期同一天「今天 HH:mm」、前一天「昨天 HH:mm」、同年更早 MM-DD、
 * 其他 YYYY-MM-DD。按日历日判断，不按 24 小时窗口；无法解析时原样返回。
 */
export function formatMessageTime(value: string, nowMs: number): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  const at = shanghai(ms);
  const today = shanghai(nowMs).date;
  const yesterday = shanghai(nowMs - DAY_MS).date;
  if (at.date === today) return `${messagesTexts.today} ${at.time}`;
  if (at.date === yesterday) return `${messagesTexts.yesterday} ${at.time}`;
  return at.date.slice(0, 4) === today.slice(0, 4) ? at.date.slice(5) : at.date;
}

/** 按字素切分；运行环境没有 Intl.Segmenter 时退回按码点切分（不拆代理对）。 */
export function graphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

/** 超过 max 个字素时保留前 max 个并加省略号；不拆表情、旗帜与组合字符。 */
export function shortTitle(title: string, max: number = TITLE_MAX_GRAPHEMES): string {
  const parts = graphemes(title);
  if (parts.length <= max) return title;
  return `${parts.slice(0, max).join('')}${ELLIPSIS}`;
}

export function isUnread(message: InboxMessage): boolean {
  return message.read_at === null;
}

/**
 * 消息的跳转目标原样交给 nav.open（契约 RouteTarget：route 是字符串，客户端版本较旧时由原生按
 * 自己的路由表处理，打开升级页）；没有 route 的消息不可点。
 */
export function targetOf(message: InboxMessage): MessageTarget | null {
  const route = message.route;
  if (route === null || route.route === '') return null;
  return route as MessageTarget;
}

/** 把已加载的消息里指定的（ids 为 null 时全部）未读消息记为已读，返回新数组；没有变化时返回 null。 */
export function markLoadedRead(
  items: readonly InboxMessage[],
  ids: ReadonlySet<string> | null,
  readAt: string,
): InboxMessage[] | null {
  let changed = false;
  const next = items.map((item) => {
    if (item.read_at !== null || (ids !== null && !ids.has(item.message_id))) return item;
    changed = true;
    return { ...item, read_at: readAt };
  });
  return changed ? next : null;
}
