// B2-15b: merchant order number of a pay order (08 BR-PAY-02 and its 细则; task §9.4).
// NotImplemented skeleton (rule-test phase); the rule tests in test/spec/payment/orders/** fix
// the behaviour.

/**
 * A new out_trade_no: `P` followed by 20 upper-case ASCII letters or digits from a CSPRNG
 * (21 characters, inside both channels' limits). It carries no user, app or order information and
 * is never derived from one; uniqueness is backed by the (app_id, out_trade_no) unique key.
 */
export function generateOutTradeNo(): string {
  throw new Error('NotImplemented: generateOutTradeNo');
}

/**
 * True when `value` is acceptable as a merchant order number on both channels: ASCII letters and
 * digits only, length 6–32 (the intersection of WeChat Pay 6–32 and Alipay ≤ 64, BR-PAY-02 细则).
 */
export function isValidOutTradeNo(value: string): boolean {
  void value;
  throw new Error('NotImplemented: isValidOutTradeNo');
}
