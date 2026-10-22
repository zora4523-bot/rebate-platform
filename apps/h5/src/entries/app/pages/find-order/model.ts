import type { BridgeMethods } from '@couli/bridge-sdk';
import type { ApiData } from '../../../../shared/api/index.ts';
import { t } from '../../../../shared/texts.ts';
import { findOrderText, findOrderTexts } from '../../../../texts/find-order.ts';
import type { PlatformKey } from '../../../../components/platform/index.ts';

export type BadgePlatform = PlatformKey;
const BADGE_PLATFORMS: ReadonlySet<string> = new Set<PlatformKey>([
  'taobao',
  'tmall',
  'jd',
  'pdd',
  'wechat',
  'wechat_pay',
  'alipay',
  'wecom',
]);

function badgePlatform(platform: RecordPlatform): BadgePlatform | null {
  return BADGE_PLATFORMS.has(platform) ? (platform as BadgePlatform) : null;
}

export type ClaimListData = ApiData<'GET', '/v1/orders/claims'>;
export type Claim = ClaimListData['items'][number];
export type ClaimItem = Claim['items'][number];
/** 找回页可选的平台（画板三平台）；记录里的平台是契约 PlatformCode。 */
export type ClaimPlatform = 'taobao' | 'jd' | 'pdd';
export type RecordPlatform = Claim['platform'];
export type HelpTarget = BridgeMethods['nav.open']['params'];

/** 找回页的平台顺序（画板 FindOrder-v2：淘宝、京东、拼多多）。 */
export const CLAIM_PLATFORMS: readonly ClaimPlatform[] = ['taobao', 'jd', 'pdd'];

/** getConfig 取的顶层键（/v1/config 的子集）。 */
export const CONFIG_KEYS = ['features', 'claim', 'help_links'];

/** 本页用到的配置：开放平台、找回期限天数、按平台的指引链接。 */
export interface ClaimConfig {
  platforms: ClaimPlatform[];
  windowDays: number | null;
  guides: Partial<Record<ClaimPlatform, HelpTarget>>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 解析 app.getConfig 的 values。平台按 features.platform_status：not_launched、maintenance 不显示；
 * window_days 不是正整数（含 null）时期限句整句隐藏，不猜默认值；指引链接只认 {route, params} 对象，原样交给 nav.open。
 */
export function parseClaimConfig(values: unknown): ClaimConfig {
  const root = record(values) ?? {};
  const status = record(record(root['features'])?.['platform_status']) ?? {};
  const platforms = CLAIM_PLATFORMS.filter((platform) => {
    const value = status[platform];
    return value !== 'not_launched' && value !== 'maintenance';
  });
  const days = record(root['claim'])?.['window_days'];
  const windowDays = typeof days === 'number' && Number.isInteger(days) && days > 0 ? days : null;
  const links = record(root['help_links']) ?? {};
  const guides: Partial<Record<ClaimPlatform, HelpTarget>> = {};
  for (const platform of CLAIM_PLATFORMS) {
    const link = record(links[`claim_guide.${platform}`]);
    if (link !== null && typeof link['route'] === 'string' && link['route'] !== '') {
      guides[platform] = link as unknown as HelpTarget;
    }
  }
  return { platforms, windowDays, guides };
}

/** 提交结果落在哪里：订单号框下、日期框下、按钮上方（当天置灰或通用错误）、或跳到记录页签。 */
export type SubmitOutcome =
  | { kind: 'created'; claim: Claim }
  | { kind: 'inline'; order: string | null; date: string | null }
  | { kind: 'blocked'; message: string }
  | { kind: 'duplicate'; message: string }
  | { kind: 'general'; message: string };

const REASONS_30202 = new Set([
  'FACTOR_MISMATCH',
  'CLAIM_EXPIRED',
  'ORDER_INVALID',
  'ALREADY_YOURS',
]);

function reasonOf(data: unknown): string | null {
  const reason = record(data)?.['reason'];
  return typeof reason === 'string' ? reason : null;
}

function fieldsOf(data: unknown): string[] {
  const fields = record(data)?.['fields'];
  return Array.isArray(fields) ? fields.filter((item) => typeof item === 'string') : [];
}

/** 未知码按契约通用码 50001 的文字（服务端 msg 一律不显示）。 */
function generalText(code: number): string {
  return t(`error.${code}`) || t('error.50001');
}

/**
 * 按错误码决定文案与位置（BR-TEXT-14 表 A / 表 B；编排裁定 3）。服务端 msg 与 data 里的其他内容一律不显示。
 */
export function outcomeFor(code: number, data: unknown): SubmitOutcome {
  switch (code) {
    case 0:
      return { kind: 'created', claim: data as Claim };
    case 20001: {
      const fields = fieldsOf(data);
      const message = t('error.20001');
      const date = fields.includes('paid_date');
      const order = fields.includes('order_no') || !date;
      return { kind: 'inline', order: order ? message : null, date: date ? message : null };
    }
    case 30201:
    case 30204:
      return { kind: 'inline', order: t(`error.${code}`), date: null };
    case 30202: {
      const reason = reasonOf(data);
      const known = reason !== null && REASONS_30202.has(reason);
      const message = known ? t(`error.30202.${reason}`) : t('error.30202');
      return reason === 'FACTOR_MISMATCH'
        ? { kind: 'inline', order: null, date: message }
        : { kind: 'inline', order: message, date: null };
    }
    case 30203:
      return {
        kind: 'blocked',
        message:
          reasonOf(data) === 'RISK_BLOCKED' ? t('error.30203.RISK_BLOCKED') : t('error.30203'),
      };
    case 30206:
      return { kind: 'blocked', message: t('error.30206') };
    case 30205:
      return { kind: 'duplicate', message: t('error.30205') };
    case 10405:
      return { kind: 'general', message: t('error.10405') };
    default:
      return { kind: 'general', message: generalText(code) };
  }
}

/** net.signedRequest 返回的 body 解析成业务信封；不是信封时按通用错误。 */
export function outcomeOfResponse(body: unknown): SubmitOutcome {
  const envelope = record(body);
  const code = envelope?.['code'];
  if (typeof code !== 'number' || !Number.isInteger(code)) {
    return { kind: 'general', message: generalText(50001) };
  }
  if (code === 0 && record(envelope?.['data']) === null) {
    return { kind: 'general', message: generalText(50001) };
  }
  return outcomeFor(code, envelope?.['data']);
}

// ---- 记录 ----

export type RecordState = 'pending' | 'auto_tracked' | 'approved' | 'rejected';

/** 整单状态到记录标签（BR-ATTR-30、BR-ATTR-16）：submitted、auto_matched、manual_review 都是审核中。 */
export function claimState(status: Claim['status']): RecordState {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'cancelled':
      return 'auto_tracked';
    default:
      return 'pending';
  }
}

/** 子订单决定到记录标签；未决定（null）是审核中。 */
export function itemState(decision: ClaimItem['decision']): RecordState {
  switch (decision) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'cancelled':
      return 'auto_tracked';
    default:
      return 'pending';
  }
}

export function stateLabel(state: RecordState): string {
  return findOrderText(`claim.records.status.${state}`);
}

/** 驳回原因的用户侧文字；没有起草的原因用通用说明，不露原因码、不留空，也不借用别的原因的文字。 */
export function rejectReasonText(reason: ClaimItem['reject_reason']): string {
  const text = reason === null ? '' : findOrderText(`claim_reject_reason.${reason}.title`);
  return text === '' ? findOrderTexts.rejectGeneric : text;
}

/** 说明句：已找回、未通过用 CLAIM_RESULT 原文（不带返利金额），其余用 08 表 C 的说明句。 */
export function explanation(state: RecordState, reason: ClaimItem['reject_reason']): string {
  switch (state) {
    case 'approved':
      return findOrderText('claim.result.approved');
    case 'rejected':
      return findOrderText('claim.result.rejected', { reason: rejectReasonText(reason) });
    default:
      return findOrderText(`claim.records.desc.${state}`);
  }
}

export interface RecordLine {
  /** 多个子订单时为子订单号；只有一个子订单（或没有）时为 null，说明直接挂在整单上。 */
  subOrderId: string | null;
  state: RecordState;
  text: string;
}

export interface RecordView {
  claimId: string;
  /** 有内置平台标识的平台才显示 PlatformBadge。 */
  platform: BadgePlatform | null;
  orderNo: string;
  state: RecordState;
  paidDate: string;
  createdAt: string;
  lines: RecordLine[];
}

/**
 * 一条申请的显示数据。只有一个子订单时按该子订单的决定显示（未决定时按整单状态）；多个子订单时整单标签按
 * 整单状态，每个子订单单独一行显示自己的决定与说明。只显示本人的申请内容，不显示认领方。
 */
export function recordView(claim: Claim, nowMs: number): RecordView {
  const items = claim.items;
  const base = {
    claimId: claim.claim_id,
    platform: badgePlatform(claim.platform),
    orderNo: claim.order_no,
    paidDate: formatPlainDate(claim.paid_date, nowMs),
    createdAt: formatPastTime(claim.created_at, nowMs),
  };
  if (items.length <= 1) {
    const item = items[0];
    const state =
      item === undefined || item.decision === null
        ? claimState(claim.status)
        : itemState(item.decision);
    const reason = item?.reject_reason ?? null;
    return {
      ...base,
      state,
      lines: [{ subOrderId: null, state, text: explanation(state, reason) }],
    };
  }
  return {
    ...base,
    state: claimState(claim.status),
    lines: items.map((item) => {
      const state = itemState(item.decision);
      return { subOrderId: item.sub_order_id, state, text: explanation(state, item.reject_reason) };
    }),
  };
}

// ---- 日期（BR-TEXT-11，Asia/Shanghai） ----

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 上海时区的 YYYY-MM-DD 与 HH:mm。 */
function shanghai(ms: number): { date: string; time: string } {
  const iso = new Date(ms + SHANGHAI_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** 今天的上海日期 YYYY-MM-DD（日期选择的上限）。 */
export function shanghaiToday(nowMs: number): string {
  return shanghai(nowMs).date;
}

/** 纯日期：与今天同年 MM-DD，否则 YYYY-MM-DD；不用「今天 / 昨天」。 */
export function formatPlainDate(date: string, nowMs: number): string {
  const match = PLAIN_DATE.exec(date);
  if (match === null) return date;
  return match[1] === shanghai(nowMs).date.slice(0, 4) ? `${match[2]}-${match[3]}` : date;
}

/** 列表中的过去时间：同一天「今天 HH:mm」、前一天「昨天 HH:mm」、同年 MM-DD、其他 YYYY-MM-DD。 */
export function formatPastTime(value: string, nowMs: number): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  const at = shanghai(ms);
  const today = shanghai(nowMs).date;
  const yesterday = shanghai(nowMs - 24 * 60 * 60 * 1000).date;
  if (at.date === today) return `${findOrderTexts.today} ${at.time}`;
  if (at.date === yesterday) return `${findOrderTexts.yesterday} ${at.time}`;
  return at.date.slice(0, 4) === today.slice(0, 4) ? at.date.slice(5) : at.date;
}

/** 上海时间下一个 0 点距 nowMs 的毫秒数（当天置灰到点解除用）。 */
export function msUntilNextShanghaiDay(nowMs: number): number {
  const DAY = 24 * 60 * 60 * 1000;
  const sinceMidnight = (((nowMs + SHANGHAI_OFFSET_MS) % DAY) + DAY) % DAY;
  return DAY - sinceMidnight;
}

// ---- 30203 / 30206 当天置灰 ----

/** 当天置灰的记录：上海日期与按钮上方的提示（不含次数）。 */
export interface DailyBlock {
  day: string;
  message: string;
}

/** 记录仍属今天（上海日期）时返回提示；跨日或没有记录时为 null。 */
export function activeBlockMessage(
  block: DailyBlock | null | undefined,
  nowMs: number,
): string | null {
  if (block === null || block === undefined) return null;
  return block.day === shanghaiToday(nowMs) ? block.message : null;
}

// ---- 定位（成功与 30205） ----

/** 要定位的申请：提交成功按 claim_id；30205（契约不带 data）按平台与订单号。 */
export type LocateTarget = { claimId: string } | { platform: ClaimPlatform; orderNo: string };

/**
 * 订单号的比对值，与服务端 createOrderClaim 一致（契约 CreateOrderClaimRequest.order_no、BR-ATTR-17 ③）：
 * 先去掉空格；拼多多再去掉全部连字符；其余平台原样精确比对。只用于比对，显示仍用原值。
 */
export function claimCompareValue(platform: string, orderNo: string): string {
  const stripped = orderNo.replaceAll(' ', '');
  return platform === 'pdd' ? stripped.replaceAll('-', '') : stripped;
}

/**
 * 这条申请是不是要定位的那条：有 claim_id 时按 claim_id；否则同平台，且规范化后的订单号等于申请的订单号
 * 或其中某个子订单号（服务端先按子订单、再按主订单匹配，30205 可能来自子订单号）。
 */
export function claimMatches(claim: Claim, target: LocateTarget): boolean {
  if ('claimId' in target) return claim.claim_id === target.claimId;
  if (claim.platform !== target.platform) return false;
  const wanted = claimCompareValue(target.platform, target.orderNo);
  if (wanted === '') return false;
  return (
    claimCompareValue(claim.platform, claim.order_no) === wanted ||
    claim.items.some((item) => claimCompareValue(claim.platform, item.sub_order_id) === wanted)
  );
}

/** 为了定位最多自动加载的页数（含首页）；超过后保留目标，等用户点「加载更多」。 */
export const LOCATE_MAX_PAGES = 5;

/**
 * 定位的下一步：found 已找到；load 自动再取下一页；wait 保留目标、等用户手动加载（到上限或下一页失败）；
 * done 列表已取完仍没有，结束定位（只停在记录页签）。
 */
export type LocateStep = 'found' | 'load' | 'wait' | 'done';

export function locateStep(input: {
  found: boolean;
  hasNextPage: boolean;
  pagesLoaded: number;
  nextPageFailed: boolean;
}): LocateStep {
  if (input.found) return 'found';
  if (!input.hasNextPage) return 'done';
  if (input.nextPageFailed || input.pagesLoaded >= LOCATE_MAX_PAGES) return 'wait';
  return 'load';
}
