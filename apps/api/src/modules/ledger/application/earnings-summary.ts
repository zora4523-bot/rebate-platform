// B2-13a: GET /v1/earnings/summary 的查询（BR-FUND-25；BR-INV-16、17）。只做展示、只读：
// - 期间：今日、昨日、本月、上月，按 +08:00 自然日 / 自然月，由注入时钟的 now 与 @couli/domain 的
//   accountingDate / chinaMonth / chinaMonthRange 得出；as_of 即该 now。
// - 付款笔数与预估：订单侧事实经 settlement 实现的端口（ledger 声明，app.module 接线），按 paid_at
//   归期；本函数只做期间归类与合计（金额只经 @couli/money）。
// - 已结算：ledger 自己的分录（infra/earnings-summary-store.ts），按会计日归期，取 −Σ amount_fen
//   （入账为正、红冲为负，只有红冲的期间为负）。
// - 开关：earnings.dashboard.enabled 关 → disabled（控制器答 30701，不读任何数字）；
//   earnings.dashboard.referral_visible 关 → referral 为 null（也不读邀请栏）。
// 所有读取在同一个只读 REPEATABLE READ 事务里；不写库、不加锁、不缓存。
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { accountingDate, chinaMonth, chinaMonthRange } from '@couli/domain';
import { addFen, fenToJsonNumber, subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { readCreditedByDay, type CreditedDayRow } from '../infra/earnings-summary-store.ts';

export interface EarningsSummaryRequest {
  readonly appId: string;
  readonly userId: string;
  /** 只筛自购 / 分享；null = 全部平台。 */
  readonly platform: string | null;
}

export interface EarningsOrdersRequest {
  readonly appId: string;
  readonly userId: string;
  readonly platform: string | null;
  /** paid_at 窗口 [paidFrom, paidTo)，+08:00 的 timestamptz 字面量。 */
  readonly paidFrom: string;
  readonly paidTo: string;
  /** false 时不必读邀请栏。 */
  readonly referral: boolean;
}

/** 订单侧事实（settlement 实现）：本人计入笔数的自购 / 分享子订单，与本人的邀请预估份额。 */
export interface EarningsOrderFacts {
  readonly own: readonly {
    readonly buyType: 'self' | 'share';
    readonly paidAt: Date;
    readonly estFen: bigint;
  }[];
  readonly referral: readonly { readonly paidAt: Date; readonly estFen: bigint }[];
}

export interface EarningsDashboardSwitches {
  readonly enabled: boolean;
  readonly referralVisible: boolean;
}

/** Foreign data comes through owner-module ports, never through ledger table access. */
export interface EarningsSummaryDependencies {
  readonly clock: Clock;
  readonly orders: {
    read(handle: Kysely<DB>, input: EarningsOrdersRequest): Promise<EarningsOrderFacts>;
  };
  readonly config: {
    readSwitches(appId: string): Promise<EarningsDashboardSwitches>;
  };
}

export type EarningsSummaryResult =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly data: Schema<'EarningsSummary'> };

export type EarningsSummaryQuery = (
  request: EarningsSummaryRequest,
) => Promise<EarningsSummaryResult>;

export interface EarningsPeriods {
  /** YYYY-MM-DD */
  readonly today: string;
  readonly yesterday: string;
  /** YYYY-MM */
  readonly thisMonth: string;
  readonly lastMonth: string;
  /** paid_at 窗口：[上月 1 日 00:00, 下月 1 日 00:00) +08:00。 */
  readonly paidFrom: string;
  readonly paidTo: string;
  /** 会计日窗口：[上月 1 日, 下月 1 日)。 */
  readonly dateFrom: string;
  readonly dateTo: string;
}

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** YYYY-MM 的前一个月。 */
export function previousMonth(month: string): string {
  const match = MONTH_PATTERN.exec(month);
  if (match === null) throw new RangeError(`invalid month ${month}`);
  const year = Number(match[1]);
  const value = Number(match[2]);
  return value === 1 ? `${pad(year - 1, 4)}-12` : `${pad(year, 4)}-${pad(value - 1, 2)}`;
}

/** YYYY-MM-DD 的前一个自然日。 */
export function previousDay(date: string): string {
  const match = DATE_PATTERN.exec(date);
  if (match === null) throw new RangeError(`invalid date ${date}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (day > 1) return `${pad(year, 4)}-${pad(month, 2)}-${pad(day - 1, 2)}`;
  const prior = previousMonth(`${pad(year, 4)}-${pad(month, 2)}`);
  const [priorYear, priorMonth] = prior.split('-').map(Number) as [number, number];
  return `${prior}-${pad(daysInMonth(priorYear, priorMonth), 2)}`;
}

/** BR-FUND-25 细则「期间」：按注入时钟的 now，+08:00 自然日与自然月。 */
export function earningsPeriods(now: Date): EarningsPeriods {
  const today = accountingDate(now);
  const thisMonth = chinaMonth(now);
  const lastMonth = previousMonth(thisMonth);
  const last = chinaMonthRange(lastMonth);
  const current = chinaMonthRange(thisMonth);
  return {
    today,
    yesterday: previousDay(today),
    thisMonth,
    lastMonth,
    paidFrom: last.start,
    paidTo: current.end,
    dateFrom: `${lastMonth}-01`,
    // current.end is YYYY-MM-DDT00:00:00+08:00: its date part is the next month's first day.
    dateTo: current.end.slice(0, 10),
  };
}

const MS_PER_DAY = 86_400_000;
const OFFSET_MS = 8 * 3_600_000;

/** as_of：now 的 +08:00 表示（YYYY-MM-DDTHH:mm:ss.SSS+08:00），与 now 是同一时刻。 */
export function chinaTimestamp(now: Date): string {
  const ms = now.getTime();
  const local = (((ms + OFFSET_MS) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  const hours = Math.floor(local / 3_600_000);
  const minutes = Math.floor((local % 3_600_000) / 60_000);
  const seconds = Math.floor((local % 60_000) / 1000);
  const millis = local % 1000;
  const time = `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
  return `${accountingDate(now)}T${time}+08:00`;
}

type PeriodKey = 'today' | 'yesterday' | 'this_month' | 'last_month';

interface Cell {
  paid: number;
  est: bigint;
  credited: bigint;
}

type Column = Record<PeriodKey, Cell>;

function emptyColumn(): Column {
  return {
    today: { paid: 0, est: 0n, credited: 0n },
    yesterday: { paid: 0, est: 0n, credited: 0n },
    this_month: { paid: 0, est: 0n, credited: 0n },
    last_month: { paid: 0, est: 0n, credited: 0n },
  };
}

/** 一个会计日 / 付款日落在哪些期间（今日与本月、昨日与本月或上月可同时命中）。 */
function periodsOf(day: string, periods: EarningsPeriods): PeriodKey[] {
  const month = day.slice(0, 7);
  const hits: PeriodKey[] = [];
  if (day === periods.today) hits.push('today');
  if (day === periods.yesterday) hits.push('yesterday');
  if (month === periods.thisMonth) hits.push('this_month');
  if (month === periods.lastMonth) hits.push('last_month');
  return hits;
}

export interface EarningsAssembly {
  readonly now: Date;
  readonly periods: EarningsPeriods;
  readonly orders: EarningsOrderFacts;
  readonly credited: readonly CreditedDayRow[];
  readonly referralVisible: boolean;
}

function columnJson(column: Column): Schema<'EarningsColumn'> {
  const cell = (c: Cell): Schema<'EarningsPeriod'> => ({
    paid_count: c.paid,
    est_fen: fenToJsonNumber(c.est),
    credited_fen: fenToJsonNumber(c.credited),
  });
  return {
    today: cell(column.today),
    yesterday: cell(column.yesterday),
    this_month: cell(column.this_month),
    last_month: cell(column.last_month),
  };
}

/** 纯函数：把订单侧事实与按日的分录合计归到各期间，组装成契约 EarningsSummary。 */
export function assembleEarningsSummary(input: EarningsAssembly): Schema<'EarningsSummary'> {
  const { periods } = input;
  const columns = { self: emptyColumn(), share: emptyColumn(), referral: emptyColumn() };

  for (const order of input.orders.own) {
    const column = columns[order.buyType];
    for (const key of periodsOf(accountingDate(order.paidAt), periods)) {
      column[key].paid += 1;
      column[key].est = addFen(column[key].est, order.estFen);
    }
  }
  for (const share of input.orders.referral) {
    const column = columns.referral;
    for (const key of periodsOf(accountingDate(share.paidAt), periods)) {
      column[key].est = addFen(column[key].est, share.estFen);
    }
  }
  for (const row of input.credited) {
    const column =
      row.ledgerType === 'REBATE_CREDIT'
        ? columns.self
        : row.ledgerType === 'SHARE_CREDIT'
          ? columns.share
          : columns.referral;
    // 用户余额是负债：入账贷记为负，红冲为正（BR-FUND-16）；看板按「入账为正」取 −amount_fen。
    const credited = subFen(0n, row.amountFen);
    for (const key of periodsOf(row.day, periods)) {
      column[key].credited = addFen(column[key].credited, credited);
    }
  }

  const referral = columns.referral;
  return {
    as_of: chinaTimestamp(input.now),
    self: columnJson(columns.self),
    share: columnJson(columns.share),
    referral: input.referralVisible
      ? {
          this_month: {
            est_fen: fenToJsonNumber(referral.this_month.est),
            credited_fen: fenToJsonNumber(referral.this_month.credited),
          },
          last_month: {
            est_fen: fenToJsonNumber(referral.last_month.est),
            credited_fen: fenToJsonNumber(referral.last_month.credited),
          },
        }
      : null,
  };
}

/** Runs on the caller's transaction, or on its own read-only REPEATABLE READ one. */
async function readOnly<T>(db: Kysely<DB>, run: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  if (db.isTransaction) return run(db);
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute((trx: Transaction<DB>) => run(trx));
}

export async function getEarningsSummary(
  db: Kysely<DB>,
  request: EarningsSummaryRequest,
  dependencies: EarningsSummaryDependencies,
): Promise<EarningsSummaryResult> {
  const switches = await dependencies.config.readSwitches(request.appId);
  if (!switches.enabled) return { enabled: false };
  const now = dependencies.clock.now();
  const periods = earningsPeriods(now);
  const read = await readOnly(db, async (trx) => {
    const orders = await dependencies.orders.read(trx, {
      appId: request.appId,
      userId: request.userId,
      platform: request.platform,
      paidFrom: periods.paidFrom,
      paidTo: periods.paidTo,
      referral: switches.referralVisible,
    });
    const credited = await readCreditedByDay(trx, {
      appId: request.appId,
      userId: request.userId,
      dateFrom: periods.dateFrom,
      dateTo: periods.dateTo,
      platform: request.platform,
    });
    return { orders, credited };
  });
  return {
    enabled: true,
    data: assembleEarningsSummary({
      now,
      periods,
      orders: read.orders,
      credited: switches.referralVisible
        ? read.credited
        : read.credited.filter((row) => row.ledgerType !== 'REFERRAL_CREDIT'),
      referralVisible: switches.referralVisible,
    }),
  };
}
