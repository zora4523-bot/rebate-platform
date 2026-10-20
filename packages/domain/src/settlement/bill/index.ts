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

/** BR-FUND-04 ③：账单生成名义时刻所在 +08:00 自然月的上一月。日期沿用 calendar。 */
export function settlementBillPeriod(at: Date): string {
  void at;
  throw new Error('NotImplemented: settlementBillPeriod');
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
  void input;
  throw new Error('NotImplemented: classifySettlementBillOrder');
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
  void bill_period;
  void orders;
  void max_orders;
  throw new Error('NotImplemented: splitSettlementBillBatches');
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

/**
 * BR-FUND-04 ⑥及细则：只看 latest_round，CANCELLED 不参与派生。
 * 未生成完为出账中；生成完且空轮次 / 全驳回保守为已出账，不宣称已结算。
 * 有 DRAFT 为已出账；其余有到时 CONFIRMED / EXECUTING / PARTIAL 为结算中；
 * 剩余有未到时 CONFIRMED 为待结算；非空且全 DONE 才是已结算。
 */
export function deriveSettlementBillStatus(input: DeriveBillStatusInput): SettlementBillStatus {
  void input;
  throw new Error('NotImplemented: deriveSettlementBillStatus');
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

/**
 * BR-FUND-04 ⑪：日期 / 月份使用现有 calendar 原语，时刻完全来自入参。
 * 只给未暂停且平台开启的 WAITING 返回月份；其余返回 null / false。
 * 当前北京时间日期严格晚于预计月份账单日 + 宽限天数才逾期，月份仍保留。
 */
export function expectedSettlementCredit(input: ExpectedCreditInput): ExpectedCreditResult {
  void input;
  throw new Error('NotImplemented: expectedSettlementCredit');
}

/** BR-FUND-04 ⑥、BR-FUND-18：固定 +08:00 每日 [00:00, 00:30)，与实际快照完成无关。 */
export function isInAssetSnapshotWindow(at: Date): boolean {
  void at;
  throw new Error('NotImplemented: isInAssetSnapshotWindow');
}

/** 保存定时时：须严格晚于确认时刻且不在名义快照时段；不负责执行时快照等待。 */
export function canScheduleSettlement(confirmed_at: Date, scheduled_at: Date): boolean {
  void confirmed_at;
  void scheduled_at;
  throw new Error('NotImplemented: canScheduleSettlement');
}
