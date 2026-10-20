import { InvalidAmount, subFen } from '@couli/money';
import {
  accountingDate,
  chinaDayRange,
  chinaMonth,
  chinaMonthRange,
} from '../../calendar/index.ts';
import type { OrderRebateState } from '../../state-machines/order-rebate.gen.ts';

/** 内部纯函数结果，不是数据库 / HTTP 枚举；null 单独表示不在本轮校验范围。 */
export type BillValidationResult =
  | 'candidate'
  | 'amount_mismatch'
  | 'deferred'
  | 'unexpected_settlement'
  | 'already_credited'
  | 'missing_settlement';

export interface BillCommissionSnapshot {
  readonly commission_version: number;
  readonly base_fen: bigint;
}

/** UNATTRIBUTED 的处理不在 BR-FUND-04 六种结果表内，由调用方另行处理。 */
export interface BillOrderFacts {
  readonly rebate_status: Exclude<OrderRebateState, 'UNATTRIBUTED'>;
  readonly settle_period: string | null;
  readonly hold: boolean;
  readonly rights_pending: boolean;
  readonly snapshots: readonly BillCommissionSnapshot[];
  readonly union_authoritative: boolean;
}

export interface BillSettlementFacts {
  readonly source: 'API' | 'STATEMENT';
  /** 我方取得该结算数据的时刻，不拿联盟结算时间替代生成截点。 */
  readonly created_at: Date;
  readonly settle_commission_fen: bigint;
  /** 调用方已按 BR-CALC-02 换算的分佣基数；本函数不重复换算。 */
  readonly b_settle_fen: bigint;
}

export interface ClassifyBillOrderInput {
  readonly bill_period: string;
  readonly generation_started_at: Date;
  readonly order: BillOrderFacts | null;
  /** null 表示尚无结算佣金；0 分的结算数据必须传对象。 */
  readonly settlement: BillSettlementFacts | null;
  readonly match_tolerance_fen: bigint;
}

// 资产快照名义时段（BR-FUND-18：最晚等到 00:30）；固定 +08:00，与 calendar 的偏移一致。
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const CHINA_OFFSET_MS = 8 * 60 * MS_PER_MINUTE;
const SNAPSHOT_WINDOW_MS = 30 * MS_PER_MINUTE;

function timeOf(at: Date, name: string): number {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw new RangeError(`${name} must be a valid Date`);
  }
  return at.getTime();
}

/** 校验 YYYY-MM（经 calendar 的严格解析），返回 年×12 + 月−1。 */
function monthIndex(month: string, name: string): number {
  try {
    chinaMonthRange(month);
  } catch {
    throw new RangeError(`${name} must be YYYY-MM, got ${JSON.stringify(month)}`);
  }
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

function monthFromIndex(index: number): string {
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  const formatted = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
  // 再经 calendar 严格校验一次，越出 0000–9999 年时抛 RangeError。
  chinaMonthRange(formatted);
  if (year > 9999) throw new RangeError(`month ${formatted} is outside 0000-9999`);
  return formatted;
}

function assertInteger(value: number, name: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${String(min)}, ${String(max)}]`);
  }
}

/** BR-FUND-04 ③：账单生成名义时刻所在 +08:00 自然月的上一月。日期沿用 calendar。 */
export function settlementBillPeriod(at: Date): string {
  timeOf(at, 'at');
  return monthFromIndex(monthIndex(chinaMonth(at), 'month') - 1);
}

/** 分佣快照当前版本 = 最大 commission_version（BR-CALC-10）；空或最大版本重复视为损坏。 */
function currentSnapshotBase(snapshots: readonly BillCommissionSnapshot[]): bigint {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new RangeError('order has no commission snapshot');
  }
  let current: BillCommissionSnapshot | null = null;
  let duplicated = false;
  for (const snapshot of snapshots) {
    if (!Number.isSafeInteger(snapshot.commission_version)) {
      throw new RangeError('commission_version must be an integer');
    }
    if (typeof snapshot.base_fen !== 'bigint') {
      throw new RangeError('snapshot base_fen must be bigint fen');
    }
    if (current === null || snapshot.commission_version > current.commission_version) {
      current = snapshot;
      duplicated = false;
    } else if (snapshot.commission_version === current.commission_version) {
      duplicated = true;
    }
  }
  if (current === null || duplicated) {
    throw new RangeError('current commission snapshot is ambiguous');
  }
  return current.base_fen;
}

function absDiffFen(left: bigint, right: bigint): bigint {
  const diff = subFen(left, right);
  return diff < 0n ? subFen(0n, diff) : diff;
}

/**
 * BR-FUND-04 ③④：输入为生成截点的订单事实，结算数据另按 created_at 截断。
 * WAITING：有数据时 settle_period <= M；无数据时只列 settle_period = M。
 * 范围内 hold / rights_pending 优先于金额差错与应结未结；以联盟为准只豁免金额差异。
 * 最大 commission_version 为当前快照。无快照等损坏输入抛 RangeError，不生成候选。
 * 开关不影响保留校验结果；是否生成批次由 splitSettlementBillBatches 过滤。
 */
export function classifySettlementBillOrder(
  input: ClassifyBillOrderInput,
): BillValidationResult | null {
  const billIndex = monthIndex(input.bill_period, 'bill_period');
  const cutoff = timeOf(input.generation_started_at, 'generation_started_at');
  if (typeof input.match_tolerance_fen !== 'bigint' || input.match_tolerance_fen < 0n) {
    throw new InvalidAmount('match_tolerance_fen must be non-negative bigint fen');
  }
  // 截至生成开始时刻（含）我方已取得的结算数据才算「已有联盟结算数据」。
  const settlement =
    input.settlement !== null && timeOf(input.settlement.created_at, 'created_at') <= cutoff
      ? input.settlement
      : null;
  const order = input.order;

  if (order === null) {
    // 上传备用时联盟有数据而我方无单：异常差错（类型沿用 BR-FUND-09）。
    return settlement === null ? null : 'unexpected_settlement';
  }

  switch (order.rebate_status) {
    case 'CREDITED':
      return settlement === null ? null : 'already_credited';
    case 'ESTIMATED':
    case 'VOID':
    case 'CLAWED_BACK':
      return settlement === null ? null : 'unexpected_settlement';
    case 'WAITING':
      break;
    default:
      throw new RangeError(
        `rebate_status ${JSON.stringify(order.rebate_status)} is outside the bill classification`,
      );
  }

  if (order.settle_period === null) {
    throw new RangeError('WAITING order has no settle_period');
  }
  const periodIndex = monthIndex(order.settle_period, 'settle_period');
  const inScope = settlement === null ? periodIndex === billIndex : periodIndex <= billIndex;
  if (!inScope) return null;

  if (order.hold || order.rights_pending) return 'deferred';
  if (settlement === null) return 'missing_settlement';

  // 损坏快照在任何候选判定前拒绝，包括以联盟为准的订单。
  const base = currentSnapshotBase(order.snapshots);
  if (typeof settlement.b_settle_fen !== 'bigint') {
    throw new InvalidAmount('b_settle_fen must be bigint fen');
  }
  if (order.union_authoritative) return 'candidate';
  return absDiffFen(settlement.b_settle_fen, base) <= input.match_tolerance_fen
    ? 'candidate'
    : 'amount_mismatch';
}

export interface BillValidatedOrder {
  readonly platform: string;
  readonly order_key: string;
  readonly credit_enabled: boolean;
  readonly result: BillValidationResult | null;
}

export interface BillDraftBatch {
  readonly platform: string;
  readonly bill_period: string;
  readonly status: 'DRAFT';
  readonly order_keys: readonly string[];
}

/** 按 UTF-16 码元比较（与 PG "C" 排序一致），不用 localeCompare。 */
function compareKey(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * BR-FUND-04 ⑤：调用方传同一 app、同一账单的校验结果；只拆开启平台的 candidate。
 * 平台互不混批，order_key 按字符串升序（不是子订单号数值顺序），不修改输入。
 * max_orders 为正整数；非法值抛 RangeError。参数由调用方读配置，不在纯函数内设默认。
 */
export function splitSettlementBillBatches(
  bill_period: string,
  orders: readonly BillValidatedOrder[],
  max_orders: number,
): readonly BillDraftBatch[] {
  if (!Number.isSafeInteger(max_orders) || max_orders < 1) {
    throw new RangeError('max_orders must be a positive integer');
  }
  monthIndex(bill_period, 'bill_period');

  const byPlatform = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const order of orders) {
    if (!order.credit_enabled || order.result !== 'candidate') continue;
    if (seen.has(order.order_key)) {
      throw new RangeError(`duplicate order_key ${JSON.stringify(order.order_key)}`);
    }
    seen.add(order.order_key);
    const keys = byPlatform.get(order.platform);
    if (keys === undefined) byPlatform.set(order.platform, [order.order_key]);
    else keys.push(order.order_key);
  }

  const batches: BillDraftBatch[] = [];
  const platforms = [...byPlatform.keys()].sort(compareKey);
  for (const platform of platforms) {
    const keys = [...(byPlatform.get(platform) ?? [])].sort(compareKey);
    for (let start = 0; start < keys.length; start += max_orders) {
      batches.push({
        platform,
        bill_period,
        status: 'DRAFT',
        order_keys: keys.slice(start, start + max_orders),
      });
    }
  }
  return batches;
}

/** BR-FUND-04 细则原值；尚无已落库的批次契约，本类型只作领域输入。 */
export type BillBatchStatus =
  'DRAFT' | 'CONFIRMED' | 'EXECUTING' | 'PARTIAL' | 'DONE' | 'CANCELLED';
export type SettlementBillStatus = '出账中' | '已出账' | '待结算' | '结算中' | '已结算';

export interface BillBatchFacts {
  readonly round: number;
  readonly status: BillBatchStatus;
  readonly settle_mode: 'IMMEDIATE' | 'SCHEDULED';
  readonly scheduled_at: Date | null;
}

export interface DeriveBillStatusInput {
  readonly generation_complete: boolean;
  /** 最近一次生成轮次由调用方传入，包括还没有批次的轮次。 */
  readonly latest_round: number;
  readonly batches: readonly BillBatchFacts[];
  readonly now: Date;
}

/** CONFIRMED 批次是否已到执行时刻：立即结算确认即到；定时结算 scheduled_at ≤ now。 */
function confirmedIsDue(batch: BillBatchFacts, now: number): boolean {
  if (batch.settle_mode === 'IMMEDIATE') return true;
  if (batch.settle_mode !== 'SCHEDULED' || batch.scheduled_at === null) {
    throw new RangeError('SCHEDULED batch must carry scheduled_at');
  }
  return timeOf(batch.scheduled_at, 'scheduled_at') <= now;
}

/**
 * BR-FUND-04 ⑥及细则：只看 latest_round，CANCELLED 不参与派生。
 * 未生成完为出账中；生成完且空轮次 / 全驳回保守为已出账，不宣称已结算。
 * 有 DRAFT 为已出账；其余有到时 CONFIRMED / EXECUTING / PARTIAL 为结算中；
 * 剩余有未到时 CONFIRMED 为待结算；非空且全 DONE 才是已结算。
 */
export function deriveSettlementBillStatus(input: DeriveBillStatusInput): SettlementBillStatus {
  const now = timeOf(input.now, 'now');
  assertInteger(input.latest_round, 'latest_round', 0, Number.MAX_SAFE_INTEGER);
  if (!input.generation_complete) return '出账中';

  let draft = false;
  let running = false;
  let waiting = false;
  let active = 0;
  for (const batch of input.batches) {
    if (batch.round !== input.latest_round || batch.status === 'CANCELLED') continue;
    active += 1;
    switch (batch.status) {
      case 'DRAFT':
        draft = true;
        break;
      case 'EXECUTING':
      case 'PARTIAL':
        running = true;
        break;
      case 'CONFIRMED':
        if (confirmedIsDue(batch, now)) running = true;
        else waiting = true;
        break;
      case 'DONE':
        break;
      default:
        throw new RangeError(`unknown batch status ${JSON.stringify(batch.status)}`);
    }
  }
  if (active === 0 || draft) return '已出账';
  if (running) return '结算中';
  if (waiting) return '待结算';
  return '已结算';
}

export interface ExpectedCreditInput {
  readonly rebate_status: OrderRebateState;
  readonly settle_period: string | null;
  readonly union_settled_at: Date | null;
  readonly hold: boolean;
  readonly rights_pending: boolean;
  readonly credit_enabled: boolean;
  readonly period_offset_months: number;
  readonly bill_day: number;
  readonly grace_days: number;
  readonly now: Date;
}

export interface ExpectedCreditResult {
  readonly expected_credit_period: string | null;
  readonly credit_overdue: boolean;
}

/** YYYY-MM-DD 之后第 days 个 +08:00 自然日（逐日经 calendar 推进）。 */
function addDays(date: string, days: number): string {
  let current = date;
  for (let i = 0; i < days; i += 1) {
    current = chinaDayRange(current).end.slice(0, 10);
  }
  return current;
}

/**
 * BR-FUND-04 ⑪：日期 / 月份使用现有 calendar 原语，时刻完全来自入参。
 * 只给未暂停且平台开启的 WAITING 返回月份；其余返回 null / false。
 * 当前北京时间日期严格晚于预计月份账单日 + 宽限天数才逾期，月份仍保留。
 */
export function expectedSettlementCredit(input: ExpectedCreditInput): ExpectedCreditResult {
  timeOf(input.now, 'now');
  // 配置取值由调用方读（读不到取 08 默认）；这里只拒绝不可能的值。
  assertInteger(input.period_offset_months, 'period_offset_months', 0, 1200);
  assertInteger(input.bill_day, 'bill_day', 1, 28);
  assertInteger(input.grace_days, 'grace_days', 0, 366);

  if (
    input.rebate_status !== 'WAITING' ||
    input.hold ||
    input.rights_pending ||
    !input.credit_enabled
  ) {
    return { expected_credit_period: null, credit_overdue: false };
  }

  let period: string;
  if (input.union_settled_at !== null) {
    timeOf(input.union_settled_at, 'union_settled_at');
    period = chinaMonth(input.union_settled_at);
  } else {
    if (input.settle_period === null) {
      throw new RangeError('WAITING order has no settle_period');
    }
    period = monthFromIndex(
      monthIndex(input.settle_period, 'settle_period') + input.period_offset_months,
    );
  }

  const billDate = `${period}-${String(input.bill_day).padStart(2, '0')}`;
  const deadline = addDays(billDate, input.grace_days);
  return { expected_credit_period: period, credit_overdue: accountingDate(input.now) > deadline };
}

/** BR-FUND-04 ⑥、BR-FUND-18：固定 +08:00 每日 [00:00, 00:30)，与实际快照完成无关。 */
export function isInAssetSnapshotWindow(at: Date): boolean {
  const ms = timeOf(at, 'at');
  const sinceMidnight = (((ms + CHINA_OFFSET_MS) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  return sinceMidnight < SNAPSHOT_WINDOW_MS;
}

/** 保存定时时：须严格晚于确认时刻且不在名义快照时段；不负责执行时快照等待。 */
export function canScheduleSettlement(confirmed_at: Date, scheduled_at: Date): boolean {
  const confirmed = timeOf(confirmed_at, 'confirmed_at');
  const scheduled = timeOf(scheduled_at, 'scheduled_at');
  return scheduled > confirmed && !isInAssetSnapshotWindow(scheduled_at);
}
