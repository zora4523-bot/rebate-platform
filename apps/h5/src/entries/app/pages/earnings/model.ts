import { formatYuan } from '@couli/money';
import type { Schema } from '@couli/contracts-ts';
import { earningsTexts } from '../../../../texts/earnings.ts';

export type EarningsSummary = Schema<'EarningsSummary'>;
export type PeriodKey = 'today' | 'yesterday' | 'this_month' | 'last_month';
/** 只有本月、上月有邀请栏数据（BR-FUND-25）。 */
export type MonthKey = 'this_month' | 'last_month';

/** 期间切换的顺序（画板 Earnings-v2：今日、昨日、本月、上月）；进页默认本月。 */
export const PERIODS: readonly PeriodKey[] = ['today', 'yesterday', 'this_month', 'last_month'];
export const DEFAULT_PERIOD: PeriodKey = 'this_month';
export const MONTHS: readonly MonthKey[] = ['this_month', 'last_month'];

/** 平台胶囊的平台与顺序（画板：淘宝、京东、拼多多）。 */
export type EarningsPlatform = 'taobao' | 'jd' | 'pdd';
export const EARNINGS_PLATFORMS: readonly EarningsPlatform[] = ['taobao', 'jd', 'pdd'];

/** 经桥 app.getConfig 读取的键：features 段里的 platform_status。 */
export const CONFIG_KEYS = ['features'];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 解析 app.getConfig 的 values：features.platform_status 里有状态且不是 not_launched 的平台显示胶囊
 * （维护中照常可筛，看板只读）；缺失或格式不对的平台不显示。
 */
export function parsePlatforms(values: unknown): EarningsPlatform[] {
  const status = record(record(record(values)?.['features'])?.['platform_status']) ?? {};
  return EARNINGS_PLATFORMS.filter((platform) => {
    const value = status[platform];
    return typeof value === 'string' && value !== '' && value !== 'not_launched';
  });
}

/** 路由参数 platform 是不是本页认识的平台（不认识的按「全部」）。 */
export function asPlatform(value: string | null): EarningsPlatform | null {
  return EARNINGS_PLATFORMS.find((platform) => platform === value) ?? null;
}

/** BR-TEXT-10 金额：整数分，负数带负号；不是安全整数（契约外）时显示占位横线，不猜数。 */
export function formatFen(fen: number): string {
  return Number.isSafeInteger(fen) ? formatYuan(BigInt(fen)) : '--';
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function shanghai(ms: number): { date: string; time: string } {
  const iso = new Date(ms + SHANGHAI_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/**
 * BR-TEXT-11 列表时间（Asia/Shanghai）：今天「今天 HH:mm」，昨天「昨天 HH:mm」，同年 MM-DD，
 * 跨年 YYYY-MM-DD。解析不了的值原样返回。
 */
export function formatAsOf(value: string, nowMs: number): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  const at = shanghai(ms);
  const today = shanghai(nowMs).date;
  if (at.date === today) return `${earningsTexts.today} ${at.time}`;
  if (at.date === shanghai(nowMs - DAY_MS).date) return `${earningsTexts.yesterday} ${at.time}`;
  return at.date.slice(0, 4) === today.slice(0, 4) ? at.date.slice(5) : at.date;
}

function isMonth(period: PeriodKey): period is MonthKey {
  return period === 'this_month' || period === 'last_month';
}

/**
 * 所选期间有没有收益：自购、分享两栏（及本月、上月时的邀请栏）的笔数与金额全为 0 时为「没有收益」，
 * 统计时点行后接 earnings.empty_hint（BR-FUND-25 细则「没有收益时」）。
 */
export function isEmptyPeriod(summary: EarningsSummary, period: PeriodKey): boolean {
  const columns = [summary.self[period], summary.share[period]];
  if (
    columns.some((item) => item.paid_count !== 0 || item.est_fen !== 0 || item.credited_fen !== 0)
  )
    return false;
  if (summary.referral !== null && isMonth(period)) {
    const referral = summary.referral[period];
    if (referral.est_fen !== 0 || referral.credited_fen !== 0) return false;
  }
  return true;
}
