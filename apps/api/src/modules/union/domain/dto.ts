// Builders of the unified item and order DTOs. Amounts are integer fen (bigint), commission
// rates are bp (1/10000) bigints, order numbers are the raw strings; nothing goes through a JS
// floating-point number. All amount and percentage parsing is @couli/money's (BR-CALC-26 has a
// single implementation there); this file only adds the sign check and maps the library's
// errors to UnionError('invalid_dto').
import { InvalidAmount, InvalidRatio, parseFen, pctStrToBp } from '@couli/money';
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

const ID_FIELDS = ['item_id', 'itemId', 'skuId', 'goods_id', 'goods_sign'] as const;

function invalid(message: string, platform: unknown): UnionError {
  return new UnionError('invalid_dto', message, isPlatform(platform) ? platform : null);
}

/** A leading "-" or the number -0: refused before parsing (no arithmetic on the value). */
function isSigned(value: unknown): boolean {
  return (typeof value === 'string' && value.startsWith('-')) || Object.is(value, -0);
}

/** @couli/money parseFen, restricted to non-negative amounts. */
function parseNonNegativeFen(value: unknown, field: string, platform: unknown): bigint {
  const message = `${field} must be a non-negative integer amount in fen`;
  if (isSigned(value)) throw invalid(message, platform);
  let fen: bigint;
  try {
    fen = parseFen(value);
  } catch (error) {
    if (error instanceof InvalidAmount) throw invalid(message, platform);
    throw error;
  }
  if (fen < 0n) throw invalid(message, platform);
  return fen;
}

/** @couli/money pctStrToBp (floored to bp, within 0..100 %), without a sign. */
function percentToBp(text: unknown, platform: unknown): bigint {
  const message = 'commission_percent must be a plain decimal percentage within 0..100';
  if (typeof text !== 'string' || isSigned(text)) throw invalid(message, platform);
  try {
    return pctStrToBp(text);
  } catch (error) {
    if (error instanceof InvalidRatio) throw invalid(message, platform);
    throw error;
  }
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
