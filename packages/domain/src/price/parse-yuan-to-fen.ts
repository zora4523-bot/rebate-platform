// 元字符串转分（规划/08 BR-PRICE-01「金额解析」；D10-515 ①）。
//
// 只接受完整匹配 ^[0-9]+(\.[0-9]{1,2})?$ 的字符串；超两位小数（按字符串数位，不去末尾 0）、
// 符号、空白、空串、指数、非数字、非字符串、结果超出 int64 一律返回 null（视为字段缺失）。
// 不四舍五入、不截断、不抛异常；不复用 @couli/money 的 yuanStrToFen（它对超两位小数取 floor，
// 只留给 BR-CALC-26 订单金额，D10-515 ③）。

/** int64 上界（分）：超出即视为字段缺失。 */
const INT64_MAX = 9223372036854775807n;

// JS 正则不带 m 标志时 $ 只匹配输入末尾（不像 Perl / Python 会匹配末尾换行前），
// 因此「1\n」不会被接受；只收 ASCII 0-9（不用 \d，避免将来加 u/v 标志时口径漂移）。
const YUAN_PATTERN = /^([0-9]+)(?:\.([0-9]{1,2}))?$/;

/** BR-PRICE-01：元字符串 → 整数分；不合法时返回 null。 */
export function parseYuanToFen(text: string): bigint | null {
  // 运行时防御：签名是 string，但调用方可能传入 JSON 解析后的任意值（含 String 包装对象）。
  if (typeof text !== 'string') return null;
  const match = YUAN_PATTERN.exec(text);
  if (match === null) return null;
  const whole = match[1] ?? '';
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const fen = BigInt(whole) * 100n + BigInt(fraction);
  return fen > INT64_MAX ? null : fen;
}
