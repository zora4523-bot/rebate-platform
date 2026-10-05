// Builders of the unified item and order DTOs. Amounts are integer fen (bigint), commission
// rates are bp (1/10000) bigints, order numbers are the raw strings; nothing goes through a JS
// floating-point number.
//
// TODO(规划/11 §4.5): 改用 @couli/money 的 parseFen / pctStrToBp — blocked on @couli/api 尚未
// 依赖 @couli/money（依赖与 tsconfig 引用要由编排者另开 deps 任务加入）。下面两个解析函数逐条照
// 抄其语义（BR-CALC-26：超过两位小数向下取整），换成库函数时行为不变。
import type { Clock } from '../../platform/index.ts';
import {
  isPlatform,
  UnionError,
  type ItemInput,
  type ItemRef,
  type OrderInput,
  type UnionItem,
  type UnionOrder,
} from './types.ts';

const MAX_INT64 = 9223372036854775807n;
const BP_PER_WHOLE = 10000n;
const ID_FIELDS = ['item_id', 'itemId', 'skuId', 'goods_id', 'goods_sign'] as const;

function invalid(message: string, platform: unknown): UnionError {
  return new UnionError('invalid_dto', message, isPlatform(platform) ? platform : null);
}

/** Same accepted inputs as @couli/money parseFen, restricted to non-negative amounts. */
function parseNonNegativeFen(value: unknown, field: string, platform: unknown): bigint {
  let fen: bigint | undefined;
  if (typeof value === 'bigint') fen = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) fen = BigInt(value);
  else if (typeof value === 'string' && /^[0-9]+$/.exec(value)?.[0] === value) {
    const significant = value.replace(/^0+/, '');
    if (significant.length <= 19) fen = BigInt(significant === '' ? '0' : significant);
  }
  if (fen === undefined || fen < 0n || fen > MAX_INT64) {
    throw invalid(`${field} must be a non-negative integer amount in fen`, platform);
  }
  return fen;
}

/** Same as @couli/money pctStrToBp: percentage string to bp, floored, within 0..100 %. */
function percentToBp(text: unknown, platform: unknown): bigint {
  const match = typeof text === 'string' ? /^([0-9]+)(?:\.([0-9]+))?$/.exec(text) : null;
  if (match === null || match[0] !== text) {
    throw invalid('commission_percent must be a plain decimal percentage', platform);
  }
  const whole = (match[1] ?? '').replace(/^0+/, '');
  const fraction = match[2] ?? '';
  if (whole.length > 19) throw invalid('commission_percent exceeds 100%', platform);
  const bp =
    BigInt(whole === '' ? '0' : whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  const hasTail = /[1-9]/.test(fraction.slice(2));
  if (bp > BP_PER_WHOLE || (bp === BP_PER_WHOLE && hasTail)) {
    throw invalid('commission_percent exceeds 100%', platform);
  }
  return bp;
}

/** Copies the item identifiers present on the input, unchanged (string or null). */
function itemRef(input: ItemRef): ItemRef {
  if (typeof input !== 'object' || input === null || !isPlatform(input.platform)) {
    throw invalid('platform must be a contract PlatformCode', null);
  }
  const ref: Record<string, unknown> = { platform: input.platform };
  for (const field of ID_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string') {
      throw invalid(`${field} must be a string or null`, input.platform);
    }
    ref[field] = value;
  }
  return ref as unknown as ItemRef;
}

/** The unified item DTO; `quoted_at` is the injected clock's current time. */
export function makeUnionItem(input: ItemInput, clock: Clock): UnionItem {
  const ref = itemRef(input);
  if (typeof input.title !== 'string') throw invalid('title must be a string', ref.platform);
  return Object.freeze({
    ...ref,
    title: input.title,
    price_fen: parseNonNegativeFen(input.price_fen, 'price_fen', ref.platform),
    coupon_fen: parseNonNegativeFen(input.coupon_fen, 'coupon_fen', ref.platform),
    final_price_fen: parseNonNegativeFen(input.final_price_fen, 'final_price_fen', ref.platform),
    commission_rate_bp: percentToBp(input.commission_percent, ref.platform),
    quoted_at: clock.now().toISOString(),
  });
}

/** Never coerces an order number to or from number: leading zeroes and long ids survive. */
export function makeUnionOrder(input: OrderInput): UnionOrder {
  const ref = itemRef(input);
  if (typeof input.order_id !== 'string' || input.order_id.trim() === '') {
    throw invalid('order_id must be a non-empty string', ref.platform);
  }
  return Object.freeze({
    ...ref,
    order_id: input.order_id,
    paid_fen: parseNonNegativeFen(input.paid_fen, 'paid_fen', ref.platform),
    commission_fen: parseNonNegativeFen(input.commission_fen, 'commission_fen', ref.platform),
  });
}
