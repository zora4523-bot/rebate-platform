// 元字符串转分（规划/08 BR-PRICE-01「金额解析」；D10-515 ①）。
//
// 只接受完整匹配 ^[0-9]+(\.[0-9]{1,2})?$ 的字符串；超两位小数（按字符串数位，不去末尾 0）、
// 符号、空白、空串、指数、非数字、非字符串、结果超出 int64 一律返回 null（视为字段缺失）。
// 不四舍五入、不截断、不抛异常；不复用 @couli/money 的 yuanStrToFen（它对超两位小数取 floor，
// 只留给 BR-CALC-26 订单金额，D10-515 ③）。

/** BR-PRICE-01：元字符串 → 整数分；不合法时返回 null。 */
export function parseYuanToFen(text: string): bigint | null {
  void text;
  throw new Error('NotImplemented: parseYuanToFen');
}
