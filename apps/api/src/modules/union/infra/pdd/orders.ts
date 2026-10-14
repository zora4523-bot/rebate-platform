// 拼多多订单接口的请求参数、时间窗、游标与 DTO 映射（09 4_PDD CAP-PDD-04/07/08，4_PDD_附 §6、§7A）。
// 映射只用任务书附的 probe 字段清单，按接口分别登记（下面三张 *_FIELDS 表）：某接口 probe 未见的字段
// 即使出现在报文里也不读、不校验、不进 DTO；从不 spread 整份报文。金额 / 费率 / 时间都是 JSON 整数，
// 非安全整数或非整数一律 invalid_dto（不舍入）；金额经 @couli/money 的 parseFen。
// 状态映射（specs/order-status-map/pdd.csv）、可分配基数扣减、时间窗拆分都不在这里。
import { InvalidAmount, parseFen } from '@couli/money';
import { makeUnionOrder } from '../../domain/dto.ts';
import { UnionError, type TimeWindow, type UnionOrder } from '../../domain/types.ts';

export const PDD_ORDER_INCREMENT = 'pdd.ddk.order.list.increment.get';
export const PDD_ORDER_RANGE = 'pdd.ddk.order.list.range.get';
export const PDD_ORDER_DETAIL = 'pdd.ddk.order.detail.get';

/** increment 每页条数：文档建议 40–50，取 50。 */
export const PDD_INCREMENT_PAGE_SIZE = 50;
/** increment 的 page 取值范围 1..10000（文档）。 */
export const PDD_INCREMENT_MAX_PAGE = 10_000;

const SECONDS_PER_DAY = 86_400;
/** increment：更新时间窗不超过 24 小时，起点不早于注入时钟的 90 天前（文档）。 */
const INCREMENT_MAX_SPAN_SECONDS = SECONDS_PER_DAY;
const INCREMENT_MAX_AGE_SECONDS = 90 * SECONDS_PER_DAY;
/** range 的 start_time / end_time 是北京时间（UTC+8，无夏令时）。 */
const BEIJING_OFFSET_SECONDS = 8 * 3_600;
/**
 * goods_id 的上限按规则测试取 2^53（含）。TODO(规划/11 §4.5): 上游 2^53+1 会被 JSON.parse 舍成 2^53，
 * 改为 ≤ 2^53−1 — blocked on 规则测试 AC-B1-04i-DTO#12 现按 2^53 验收（拼多多真实商品号远小于此；编排者已记 followup）。
 */
const MAX_GOODS_ID = 2 ** 53;

export type PddOrderSource = 'increment' | 'range' | 'detail';

/** 各接口 probe 见到、且本任务映射的字段（任务书 probe 字段清单的子集，另加两处任务书明示的例外）。 */
const COMMON_FIELDS = [
  'order_sn',
  'goods_id',
  'goods_sign',
  'custom_parameters',
  'goods_price',
  'order_amount',
  'promotion_amount',
  'duo_id_service_fee',
  'promotion_rate',
  'sep_rate',
  'platform_discount',
  'sep_market_fee',
  'order_status',
  'order_status_desc',
  'order_create_time',
  'order_pay_time',
  'order_group_success_time',
  'order_modify_at',
  'subsidy_duo_amount_level',
  // probe 未见、任务书明示按可选透传（4_PDD_附 §7A）；与详情的 return_status 同为显式例外。
  'subsidy_duo_amount_ten_million',
  'subsidy_type',
  'subsidy_list',
] as const;
const FIELDS: Readonly<Record<PddOrderSource, ReadonlySet<string>>> = {
  increment: new Set([
    ...COMMON_FIELDS,
    'order_id',
    'p_id',
    'fail_reason',
    'order_receive_time',
    'order_verify_time',
    'order_settle_time',
  ]),
  range: new Set([...COMMON_FIELDS, 'p_id', 'fail_reason', 'order_settle_time']),
  detail: new Set([...COMMON_FIELDS, 'pid', 'url_last_generate_time', 'return_status']),
};

function invalid(message: string): UnionError {
  return new UnionError('invalid_dto', `pdd order: ${message}`, 'pdd');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 秒级 UTC 边界；from 向下取整、to 向上取整，再按秒校验。 */
function windowSeconds(win: TimeWindow): { readonly start: number; readonly end: number } {
  const fromMs = typeof win?.from === 'string' ? Date.parse(win.from) : Number.NaN;
  const toMs = typeof win?.to === 'string' ? Date.parse(win.to) : Number.NaN;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw invalid('time window must be two ISO-8601 instants');
  }
  const start = Math.floor(fromMs / 1000);
  const end = Math.ceil(toMs / 1000);
  if (start >= end) throw invalid('time window must have from < to');
  return { start, end };
}

/** increment 的更新时间窗：跨度 ≤ 24 小时、起点不早于 now − 90 天；拆分窗口是 order-sync 的事。 */
export function incrementWindow(
  win: TimeWindow,
  nowMs: number,
): { readonly start_update_time: number; readonly end_update_time: number } {
  const { start, end } = windowSeconds(win);
  if (end - start > INCREMENT_MAX_SPAN_SECONDS) {
    throw invalid('increment window exceeds 24 hours');
  }
  if (start * 1000 < nowMs - INCREMENT_MAX_AGE_SECONDS * 1000) {
    throw invalid('increment window starts more than 90 days ago');
  }
  return { start_update_time: start, end_update_time: end };
}

/** range 的支付时间窗，转成北京时间 "yyyy-MM-dd HH:mm:ss"。 */
export function rangeWindow(win: TimeWindow): {
  readonly start_time: string;
  readonly end_time: string;
} {
  const { start, end } = windowSeconds(win);
  return { start_time: beijingText(start), end_time: beijingText(end) };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** Unix 秒 → 北京时间文本；纯整数换算（civil-from-days），不读时钟、不经 Date 对象。 */
function beijingText(unixSeconds: number): string {
  const local = unixSeconds + BEIJING_OFFSET_SECONDS;
  const days = Math.floor(local / SECONDS_PER_DAY);
  const secondOfDay = local - days * SECONDS_PER_DAY;
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  const hour = Math.floor(secondOfDay / 3_600);
  const minute = Math.floor((secondOfDay % 3_600) / 60);
  const second = secondOfDay % 60;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/*
 * 游标编码（不透明，调用方原样回传）：
 * - increment：`inc:<page>`，指下一次要取的页码。首次调用（无游标）先探出最后一个非空页并返回它，
 *   游标指向前一页；之后逐页往回取到第 1 页，nextCursor=null（倒序翻页，文档要求，避免漏单）。
 * - pay_time：`range:<last_order_id>`，原样回传上游迭代器。
 * 与查询方式不符或格式不对的游标报 invalid_dto。
 */
export function incrementCursor(page: number): string {
  return `inc:${page}`;
}

export function parseIncrementCursor(cursor: string): number {
  const match = /^inc:([1-9][0-9]{0,4})$/.exec(cursor);
  const page = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(page) || page < 1 || page > PDD_INCREMENT_MAX_PAGE) {
    throw invalid('cursor does not belong to an increment query');
  }
  return page;
}

export function rangeCursor(lastOrderId: string): string {
  return `range:${lastOrderId}`;
}

export function parseRangeCursor(cursor: string): string {
  if (!cursor.startsWith('range:') || cursor.length === 'range:'.length) {
    throw invalid('cursor does not belong to a pay_time query');
  }
  return cursor.slice('range:'.length);
}

/** 列表接口外层的 order_list；不是数组即报错，不当作空页。 */
export function orderList(envelope: unknown): readonly unknown[] {
  if (!isRecord(envelope) || !Array.isArray(envelope.order_list)) {
    throw invalid('order_list_get_response.order_list is not an array');
  }
  return envelope.order_list;
}

/** range 的迭代器；缺失、空串或非字符串都当作没有下一批。 */
export function lastOrderId(envelope: unknown): string | null {
  if (!isRecord(envelope)) return null;
  const value = envelope.last_order_id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

class Fields {
  readonly #row: Record<string, unknown>;
  readonly #allowed: ReadonlySet<string>;

  constructor(row: Record<string, unknown>, source: PddOrderSource) {
    this.#row = row;
    this.#allowed = FIELDS[source];
  }

  /** 只读本接口登记过的字段；缺失与 JSON null 都是 undefined。 */
  raw(name: string): unknown {
    if (!this.#allowed.has(name)) return undefined;
    const value = this.#row[name];
    return value === null ? undefined : value;
  }

  text(name: string): string | null {
    const value = this.raw(name);
    if (value === undefined) return null;
    if (typeof value !== 'string') throw invalid(`${name} must be a string`);
    return value;
  }

  integer(name: string): number | null {
    const value = this.raw(name);
    if (value === undefined) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw invalid(`${name} must be a safe integer`);
    }
    return value;
  }

  /** 秒级时间戳，保留整数。 */
  seconds(name: string): number | null {
    const value = this.integer(name);
    if (value !== null && value < 0) throw invalid(`${name} must be a non-negative timestamp`);
    return value;
  }

  /** 非负整数分 → bigint，经 @couli/money parseFen（只接受安全整数）。 */
  fen(name: string): bigint | null {
    const value = this.raw(name);
    if (value === undefined) return null;
    return nonNegativeFen(value, name);
  }

  /** 非负整数（千分比费率、补贴档位）→ bigint；不是金额运算，只做类型转换。 */
  count(name: string): bigint | null {
    const value = this.integer(name);
    if (value === null) return null;
    if (value < 0) throw invalid(`${name} must be non-negative`);
    return BigInt(value);
  }
}

function nonNegativeFen(value: unknown, name: string): bigint {
  if (typeof value !== 'number' || Object.is(value, -0)) {
    throw invalid(`${name} must be a non-negative integer amount in fen`);
  }
  let fen: bigint;
  try {
    fen = parseFen(value);
  } catch (error) {
    if (error instanceof InvalidAmount) {
      throw invalid(`${name} must be a non-negative integer amount in fen`);
    }
    throw error;
  }
  if (fen < 0n) throw invalid(`${name} must be a non-negative integer amount in fen`);
  return fen;
}

/** JSON 整数商品号 → 十进制字符串；不经浮点运算。 */
function goodsId(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_GOODS_ID) {
    throw invalid('goods_id must be a non-negative integer within 2^53');
  }
  return String(value);
}

/**
 * probe 只见过空数组，成员结构未经确认：成员一律不进 DTO（也不读），只保留长度（占位 null）。
 */
function subsidyList(value: unknown): readonly null[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw invalid('subsidy_list must be an array');
  return Object.freeze(Array.from({ length: value.length }, () => null));
}

/**
 * 一条拼多多订单 → UnionOrder。order_id 取 order_sn；platform_order_id 取列表的 order_id（只有
 * increment 的 probe 见到，其余为 null）；推广位：列表 p_id、详情 pid 统一到 pid。
 * commission_fen = promotion_amount（含软件服务费，不是可分配基数；基数 = promotion_amount −
 * duo_id_service_fee，在 orders / 分账层扣），service_fee_fen = duo_id_service_fee。
 * subsidy_* 单列透传，不并入任何金额。return_status 只读详情接口。
 */
export function mapPddOrder(input: unknown, source: PddOrderSource): UnionOrder {
  if (!isRecord(input)) throw invalid('order row is not an object');
  const f = new Fields(input, source);
  const orderSn = f.raw('order_sn');
  if (typeof orderSn !== 'string' || orderSn.trim() === '') {
    throw invalid('order_sn must be a non-empty string');
  }
  const orderAmount = f.raw('order_amount');
  const promotionAmount = f.raw('promotion_amount');
  if (orderAmount === undefined) throw invalid('order_amount is missing');
  if (promotionAmount === undefined) throw invalid('promotion_amount is missing');
  const base = makeUnionOrder({
    platform: 'pdd',
    order_id: orderSn,
    goods_id: goodsId(f.raw('goods_id')),
    goods_sign: f.text('goods_sign'),
    paid_fen: nonNegativeFen(orderAmount, 'order_amount'),
    commission_fen: nonNegativeFen(promotionAmount, 'promotion_amount'),
  });
  return Object.freeze({
    ...base,
    platform_order_id: f.text('order_id'),
    pid: source === 'detail' ? f.text('pid') : f.text('p_id'),
    custom_parameters: f.text('custom_parameters'),
    order_status: f.integer('order_status'),
    order_status_desc: f.text('order_status_desc'),
    fail_reason: f.text('fail_reason'),
    return_status: f.integer('return_status'),
    service_fee_fen: f.fen('duo_id_service_fee'),
    goods_price_fen: f.fen('goods_price'),
    platform_discount_fen: f.fen('platform_discount'),
    sep_market_fee_fen: f.fen('sep_market_fee'),
    promotion_rate: f.count('promotion_rate'),
    sep_rate: f.count('sep_rate'),
    order_create_time: f.seconds('order_create_time'),
    order_pay_time: f.seconds('order_pay_time'),
    order_group_success_time: f.seconds('order_group_success_time'),
    order_receive_time: f.seconds('order_receive_time'),
    order_verify_time: f.seconds('order_verify_time'),
    order_settle_time: f.seconds('order_settle_time'),
    order_modify_at: f.seconds('order_modify_at'),
    url_last_generate_time: f.seconds('url_last_generate_time'),
    subsidy_duo_amount_level: f.count('subsidy_duo_amount_level'),
    subsidy_duo_amount_ten_million: f.count('subsidy_duo_amount_ten_million'),
    subsidy_type: f.integer('subsidy_type'),
    subsidy_list: subsidyList(f.raw('subsidy_list')),
  });
}
