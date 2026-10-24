// B2-15b: merchant order number of a pay order (08 BR-PAY-02 and its 细则; task §9.4). The rule
// tests in test/spec/payment/orders/** fix the behaviour. Pure: no clock, no database.
import { randomInt } from 'node:crypto';

/** The alphabet of a generated number: upper-case ASCII letters and digits only. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Random characters after the `P` prefix: 21 characters in all, inside both channels' limits. */
const RANDOM_LENGTH = 20;

/**
 * Both channels' merchant order number constraints intersected (BR-PAY-02 细则): ASCII letters and
 * digits only, 6 to 32 characters (WeChat Pay 6–32; Alipay ≤ 64). Documentation only, not yet
 * verified against a real merchant account (BR-PAY-09 ①②).
 */
const VALID_OUT_TRADE_NO = /^[A-Za-z0-9]{6,32}$/;

/**
 * A new out_trade_no: `P` followed by 20 upper-case ASCII letters or digits from a CSPRNG
 * (21 characters, inside both channels' limits). It carries no user, app or order information and
 * is never derived from one; uniqueness is backed by the (app_id, out_trade_no) unique key.
 */
export function generateOutTradeNo(): string {
  let out = 'P';
  for (let i = 0; i < RANDOM_LENGTH; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * True when `value` is acceptable as a merchant order number on both channels: ASCII letters and
 * digits only, length 6–32 (the intersection of WeChat Pay 6–32 and Alipay ≤ 64, BR-PAY-02 细则).
 */
export function isValidOutTradeNo(value: string): boolean {
  return typeof value === 'string' && VALID_OUT_TRADE_NO.test(value);
}
