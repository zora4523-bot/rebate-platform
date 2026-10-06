// BR-PRICE-01 / BR-PRICE-02 (D33, 2026-10-06): Taobao price fields from the discount price, the
// promotion final price and the promotion detail list. Pure: no I/O, no clock, money only through
// @couli/money. Values come from the spec text in the task brief, never from recordings.
import { addFen, InvalidAmount, parseFen, subFen } from '@couli/money';

export type PriceAnomalyReason =
  'missing_field' | 'calc_diff' | 'expired_item' | 'unknown_promo' | 'invalid_price';

/** Domain amounts are integer fen, not upstream yuan strings or platform payloads.
 * Unknown permits missing/invalid values to fail closed at this boundary.
 * Upstream yuan parsing belongs to the adapter's @couli/domain.parseYuanToFen boundary.
 */
export interface TaobaoPromotion {
  readonly title: string;
  readonly amount_fen?: unknown;
  readonly id?: string;
  /** Optional epoch milliseconds; no time-zone or date-only strings at this boundary. */
  readonly start_ms?: unknown;
  readonly end_ms?: unknown;
}

export interface TaobaoPriceInput {
  readonly discount_fen?: unknown;
  readonly promotion_final_fen?: unknown;
  readonly promotions?: readonly TaobaoPromotion[];
}

/** Omitted settings use BR-PRICE-02 defaults; explicit arrays replace those defaults.
 * TODO(规划/11 §9.2): 配置端口接入 app.module — blocked on followups F-36
 */
export interface TaobaoPriceOptions {
  readonly member_title_keywords?: readonly string[];
  readonly coupon_titles?: readonly string[];
  readonly discount_titles?: readonly string[];
  readonly unknown_promo?: 'unavailable' | 'add_back' | 'count';
  readonly basis?: 'promotion_path' | 'coupon_only';
}

/** Pure function returns flat warning events for the adapter to log through pino. */
export type TaobaoPriceWarning =
  | { readonly code: 'PRICE_CALC_DIFF' }
  | { readonly code: 'PRICE_PROMO_UNKNOWN'; readonly title: string };

export interface TaobaoPriceResult {
  readonly price_fen: bigint;
  readonly coupon_fen: bigint;
  readonly final_price_fen: bigint;
  readonly coupon_ids?: string;
  readonly price_status: 'ok' | 'anomaly';
  readonly price_anomaly_reason?: PriceAnomalyReason;
  readonly warnings: readonly TaobaoPriceWarning[];
}

/** BR-PRICE-02 defaults (names observed 2026-10-06). Explicit option arrays replace them. */
export const TAOBAO_PRICE_DEFAULTS = Object.freeze({
  member_title_keywords: Object.freeze(['88VIP']),
  coupon_titles: Object.freeze(['商品券', '店铺券']),
  discount_titles: Object.freeze([
    '百亿补贴',
    '秒杀直降',
    '限时补贴',
    '限时优惠',
    '满元减',
    '满件折',
  ]),
  unknown_promo: 'unavailable',
  basis: 'promotion_path',
} as const);

type PromotionKind = 'member' | 'coupon' | 'discount' | 'unknown';

interface Settings {
  readonly member: readonly string[];
  readonly coupon: ReadonlySet<string>;
  readonly discount: ReadonlySet<string>;
  readonly unknown: 'unavailable' | 'add_back' | 'count';
  readonly basis: 'promotion_path' | 'coupon_only';
}

interface Checked {
  readonly kind: PromotionKind;
  readonly amount: bigint;
  readonly id: string | undefined;
  readonly start: number | undefined;
  readonly end: number | undefined;
}

/** Thrown internally only; mapTaobaoPrice turns it into an anomaly result. */
class Anomaly {
  readonly reason: PriceAnomalyReason;
  constructor(reason: PriceAnomalyReason) {
    this.reason = reason;
  }
}

/** NFKC first, then trim (BR-PRICE-02 细则「淘宝优惠明细的分类」). */
function normalizeTitle(title: string): string {
  return title.normalize('NFKC').trim();
}

function normalizedList(values: readonly string[]): string[] {
  const list: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = normalizeTitle(value);
    if (normalized !== '') list.push(normalized);
  }
  return list;
}

function settingsOf(options: TaobaoPriceOptions | undefined): Settings {
  const unknown = options?.unknown_promo ?? TAOBAO_PRICE_DEFAULTS.unknown_promo;
  const basis = options?.basis ?? TAOBAO_PRICE_DEFAULTS.basis;
  if (unknown !== 'unavailable' && unknown !== 'add_back' && unknown !== 'count') {
    throw new TypeError('price.taobao.unknown_promo must be unavailable, add_back or count');
  }
  if (basis !== 'promotion_path' && basis !== 'coupon_only') {
    throw new TypeError('price.taobao.basis must be promotion_path or coupon_only');
  }
  return {
    member: normalizedList(
      options?.member_title_keywords ?? TAOBAO_PRICE_DEFAULTS.member_title_keywords,
    ),
    coupon: new Set(normalizedList(options?.coupon_titles ?? TAOBAO_PRICE_DEFAULTS.coupon_titles)),
    discount: new Set(
      normalizedList(options?.discount_titles ?? TAOBAO_PRICE_DEFAULTS.discount_titles),
    ),
    unknown,
    basis,
  };
}

/** Order: member (substring) → coupon (exact) → platform discount (exact) → unknown. */
function classify(title: string, settings: Settings): PromotionKind {
  if (settings.member.some((keyword) => title.includes(keyword))) return 'member';
  if (settings.coupon.has(title)) return 'coupon';
  if (settings.discount.has(title)) return 'discount';
  return 'unknown';
}

/** A non-negative int64 fen through @couli/money.parseFen; anything else is a missing field. */
function amountOf(value: unknown): bigint {
  let fen: bigint;
  try {
    fen = parseFen(value);
  } catch {
    throw new Anomaly('missing_field');
  }
  if (fen < 0n) throw new Anomaly('missing_field');
  return fen;
}

/** Optional epoch milliseconds: absent means "valid as given"; present must be a safe integer. */
function timeOf(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw new Anomaly('missing_field');
}

/** A coupon id joins the comma-separated quoted_coupon_id string, so it must be non-blank. */
function couponIdOf(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes(',')) {
    throw new Anomaly('missing_field');
  }
  return value;
}

function sum(values: readonly bigint[]): bigint {
  let total = 0n;
  for (const value of values) total = addFen(total, value);
  return total;
}

function byCodeUnit(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** Start inclusive, end exclusive. */
function inEffect(item: Checked, now: number): boolean {
  if (item.start !== undefined && now < item.start) return false;
  if (item.end !== undefined && now >= item.end) return false;
  return true;
}

function anomaly(reason: PriceAnomalyReason, warnings: TaobaoPriceWarning[]): TaobaoPriceResult {
  // An unknown name is reported through PRICE_PROMO_UNKNOWN; every other anomaly is a calc diff.
  if (reason !== 'unknown_promo') warnings.push({ code: 'PRICE_CALC_DIFF' });
  return {
    price_fen: 0n,
    coupon_fen: 0n,
    final_price_fen: 0n,
    price_status: 'anomaly',
    price_anomaly_reason: reason,
    warnings,
  };
}

/**
 * BR-PRICE-02 Taobao mapping. now is the injected fetch time in epoch milliseconds; this function
 * performs no I/O. Checks run in order ① base prices → ② detail fields → ③/④ reconciliation →
 * validity → unknown names (unavailable) → ⑤ BR-PRICE-01 basic checks; the first hit decides, and
 * an anomaly never carries a partial price.
 */
export function mapTaobaoPrice(
  input: TaobaoPriceInput,
  now: number,
  options?: TaobaoPriceOptions,
): TaobaoPriceResult {
  const settings = settingsOf(options);
  const warnings: TaobaoPriceWarning[] = [];
  const raw: readonly TaobaoPromotion[] = input.promotions ?? [];
  // Classify first so every unknown name is reported, even when a later check fails.
  const kinds: (PromotionKind | null)[] = [];
  if (Array.isArray(raw)) {
    for (const promotion of raw) {
      const title: unknown = (promotion as Partial<TaobaoPromotion> | null)?.title;
      if (typeof title !== 'string') {
        kinds.push(null);
        continue;
      }
      const normalized = normalizeTitle(title);
      const kind = classify(normalized, settings);
      if (kind === 'unknown') warnings.push({ code: 'PRICE_PROMO_UNKNOWN', title: normalized });
      kinds.push(kind);
    }
  }
  try {
    if (!Number.isSafeInteger(now)) throw new TypeError('now must be epoch milliseconds');
    // ① base prices.
    const discount = amountOf(input.discount_fen);
    const promotionFinal = amountOf(input.promotion_final_fen);
    // ② every detail item: amount, coupon id, time format.
    if (!Array.isArray(raw)) throw new Anomaly('missing_field');
    const items: Checked[] = raw.map((promotion, index) => {
      const kind = kinds[index];
      if (kind === null || kind === undefined) throw new Anomaly('missing_field');
      const amount = amountOf(promotion.amount_fen);
      const id = kind === 'coupon' ? couponIdOf(promotion.id) : undefined;
      return { kind, amount, id, start: timeOf(promotion.start_ms), end: timeOf(promotion.end_ms) };
    });
    // ③ / ④ discount price − every detail item = promotion final price (empty list: equal prices).
    const total = sum(items.map((item) => item.amount));
    if (subFen(discount, total) !== promotionFinal) throw new Anomaly('calc_diff');
    // Validity of counted items: coupons, platform discounts, and unknown names under `count`.
    const counted = (item: Checked): boolean =>
      item.kind === 'coupon' ||
      item.kind === 'discount' ||
      (item.kind === 'unknown' && settings.unknown === 'count');
    if (items.some((item) => counted(item) && !inEffect(item, now))) {
      throw new Anomaly('expired_item');
    }
    const unknowns = items.filter((item) => item.kind === 'unknown');
    if (unknowns.length > 0 && settings.unknown === 'unavailable') {
      throw new Anomaly('unknown_promo');
    }
    const coupons = items.filter((item) => item.kind === 'coupon');
    const coupon = sum(coupons.map((item) => item.amount));
    let price: bigint;
    let final: bigint;
    if (settings.basis === 'promotion_path') {
      const addBack = items.filter(
        (item) =>
          item.kind === 'member' || (item.kind === 'unknown' && settings.unknown === 'add_back'),
      );
      final = addFen(promotionFinal, sum(addBack.map((item) => item.amount)));
      price = addFen(final, coupon);
    } else {
      // coupon_only: degraded basis, only coupons are deducted from the discount price.
      price = discount;
      final = subFen(price, coupon);
    }
    // ⑤ BR-PRICE-01 anomaly conditions.
    if (price <= 0n || coupon >= price || final <= 0n || subFen(price, coupon) !== final) {
      throw new Anomaly('invalid_price');
    }
    const ids = coupons.map((item) => item.id as string).sort(byCodeUnit);
    return {
      price_fen: price,
      coupon_fen: coupon,
      final_price_fen: final,
      ...(ids.length > 0 ? { coupon_ids: ids.join(',') } : {}),
      price_status: 'ok',
      warnings,
    };
  } catch (error) {
    if (error instanceof Anomaly) return anomaly(error.reason, warnings);
    // Sums beyond int64 (InvalidAmount from @couli/money) cannot be a real price.
    if (error instanceof InvalidAmount) {
      return anomaly('invalid_price', warnings);
    }
    throw error;
  }
}

/**
 * The single price-anomaly predicate for union callers: an explicit anomaly status, or three
 * fields failing the BR-PRICE-01 basic checks (price > 0, 0 ≤ coupon < price, final > 0 and
 * final = price − coupon), whatever the status says.
 */
export function isPriceAnomaly(item: {
  readonly price_fen: bigint;
  readonly coupon_fen: bigint;
  readonly final_price_fen: bigint;
  readonly price_status?: 'ok' | 'anomaly';
}): boolean {
  if (item.price_status !== undefined && item.price_status !== 'ok') return true;
  const { price_fen: price, coupon_fen: coupon, final_price_fen: final } = item;
  if (typeof price !== 'bigint' || typeof coupon !== 'bigint' || typeof final !== 'bigint') {
    return true;
  }
  if (price <= 0n || coupon < 0n || coupon >= price || final <= 0n) return true;
  try {
    return subFen(price, coupon) !== final;
  } catch {
    return true;
  }
}
