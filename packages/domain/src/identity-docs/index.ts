export type ResidentIdNoResult = { ok: true; id_no: string; birth_date: string } | { ok: false };

/** 18 位身份证：首尾 trim、末位 x 转 X，校验日期和 GB 11643 校验位。 */
export function parseResidentIdNo(input: string): ResidentIdNoResult {
  void input;
  throw new Error('NotImplemented: parseResidentIdNo');
}

/** 第 years 个生日次日 00:00 +08:00；非闰年的 2 月 29 日生日按 3 月 1 日。 */
export function reachedAgeAt(birthDate: string, years: number): Date {
  void birthDate;
  void years;
  throw new Error('NotImplemented: reachedAgeAt');
}

/** 以生日次日为界的周岁，最小返回 0；非法日期或时刻抛 RangeError。 */
export function ageAt(birthDate: string, at: Date): number {
  void birthDate;
  void at;
  throw new Error('NotImplemented: ageAt');
}

export function isAtLeastAge(birthDate: string, years: number, at: Date): boolean {
  void birthDate;
  void years;
  void at;
  throw new Error('NotImplemented: isAtLeastAge');
}

/** NFKC → trim → 指定四种间隔符换成 U+00B7；保留中间空白。 */
export function normalizePersonName(input: string): string {
  void input;
  throw new Error('NotImplemented: normalizePersonName');
}

export function samePersonName(a: string, b: string): boolean {
  void a;
  void b;
  throw new Error('NotImplemented: samePersonName');
}

/** 仅移除 ASCII 空格和 ASCII 连字符，不清洗其他字符。 */
export function normalizeBankCardNo(input: string): string {
  void input;
  throw new Error('NotImplemented: normalizeBankCardNo');
}

/** 输入必须是 12–19 位 ASCII 数字且通过 Luhn。 */
export function isValidBankCardNo(digits: string): boolean {
  void digits;
  throw new Error('NotImplemented: isValidBankCardNo');
}
