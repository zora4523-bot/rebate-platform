// Display masking of the payout account (规划/08 BR-ID-33 细则「收款账号的脱敏格式」, 功能对照 G-71;
// 规划/04 §6.1 GET /v1/me/payout-account masked_account / masked_payee_name, §6.4 提现记录
// masked_account; BR-TEXT-06 {masked_account}). The rule tests in
// test/spec/platform/masking/payout-account.test.ts import this file by path; the names, signatures
// and the semantics written here are the contract. Re-exporting these functions from ./index.ts is
// up to the implementation (the rule tests do not need it).
//
// Common to all three functions (same stance as maskPhone / maskIdNo / maskName in ./index.ts):
// - Lengths and positions count Unicode code points (`[...text]`), not UTF-16 units; a lone
//   surrogate is one code point.
// - None of them throws for any string (lone surrogates included). Pure: the result depends only
//   on the argument (no module state, no clock, no environment, no logging); the same input always
//   gives the same output.
// - An input that is not of an accepted form reveals nothing: the result is one "*" (U+002A) per
//   code point of the whole input, and nothing else (no "尾号", no "@", no domain). The empty
//   string therefore stays empty.
// - No trimming, no case folding, no Unicode normalization, no removal of separators: the callers
//   pass the value that was normalized when the account was bound (规划/08 BR-WDR-02 细则「支付宝
//   登录号的规范化」「卡号规范化」); anything else counts as "not of an accepted form".
//
// maskAlipayLogonId(logonId) — 支付宝登录号.
//   The form is decided by U+0040 "@" alone: an input containing no "@" is the phone form, an input
//   containing at least one "@" is the e-mail form (BR-WDR-02 细则; a full-width "＠" U+FF20 is not
//   "@").
//   Phone form: exactly what maskPhone does — 11 ASCII digits starting with 1 (/^1[0-9]{10}$/) →
//     the first 3 + "****" + the last 4 (13812345678 → 138****5678); anything else (other lengths,
//     +86 / 86 prefixes, spaces, dashes, full-width digits, letters) → one "*" per code point.
//   E-mail form, accepted when all of these hold:
//     - the input contains exactly one "@";
//     - the part before it (the local part) has at least 1 code point;
//     - the part after it (the domain) has at least 1 code point;
//     - no code point of the whole input matches /[\s\p{C}]/u (JS white space and line
//       terminators such as U+0020, U+00A0, U+3000, U+FEFF, tab, CR, LF; controls, format
//       characters such as U+200B / U+200D, surrogates, private use and unassigned code points).
//     Result: the masked local part + "@" + the domain exactly as given (case kept, so
//     ZhangSan@Example.COM → Zh***@Example.COM). The masked local part, with n = its number of
//     code points:
//       n ≥ 3  the first 2 code points + "***"   (zhangsan@example.com → zh***@example.com;
//                                                  abc@x.com → ab***@x.com)
//       n = 2  the first code point + "***"      (ab@x.com → a***@x.com)
//       n = 1  "***"                             (a@x.com → ***@x.com)
//     The "***" is always exactly three "*", whatever n is.
//   Not accepted (two or more "@", nothing before or after the "@", any white space or \p{C}
//   code point anywhere, e.g. " zh@x.com", "zh@x.com ", "zh @x.com", "@x.com", "zh@", "a@b@x.com")
//   → one "*" per code point of the whole input.
//
// maskBankCardTail(cardNo) — 银行卡 「尾号 {卡号后 4 位}」.
//   Accepted: 12 to 19 ASCII digits and nothing else (/^[0-9]{12,19}$/, the stored form after
//   BR-WDR-02 细则「卡号规范化」: spaces and hyphens removed, 12–19 digits). No Luhn check here (the
//   bind step checks it). Result: "尾号" + one U+0020 space + the last 4 digits (6222021234567890123
//   → 尾号 0123). The bank name (bank_name, from the card BIN) is not part of this function: the
//   caller or the page joins it («招商银行 尾号 1234»). The card BIN and every other digit stay
//   hidden. 待编排会话确认: the accepted length is 12–19 (BR-WDR-02 卡号规范化) and not 16–19 (the
//   length the log free-text net recognises), so that every card that can be bound gets its tail.
//   Not accepted (11 or fewer or 20 or more digits, spaces or hyphens, full-width digits, letters,
//   any other character) → one "*" per code point of the whole input.
//
// maskPayeeName(name) — 收款人姓名: the same result as maskName in ./index.ts for every string
//   (BR-ID-33 姓名只显示末字): n ≥ 2 code points → n − 1 "*" + the last code point (张小三 → **三);
//   one code point → "*"; "" → "".
//
// Rules for the implementation: this directory is also compiled by the `test` project: erasable
// syntax only (no parameter properties, no enum, no namespace, no decorators), `import type` for
// type-only imports, relative imports with the `.ts` extension, no NestJS, no `process.env`, no
// new dependency.

/** BR-ID-33 收款账号: 支付宝登录号 — phone form 138****5678, e-mail form zh***@example.com. */
export function maskAlipayLogonId(logonId: string): string {
  void logonId;
  throw new Error('NotImplemented: maskAlipayLogonId');
}

/** BR-ID-33 收款账号: 银行卡 「尾号 1234」 (bank name joined by the caller). */
export function maskBankCardTail(cardNo: string): string {
  void cardNo;
  throw new Error('NotImplemented: maskBankCardTail');
}

/** BR-ID-33 收款人姓名: same as maskName (**三). */
export function maskPayeeName(name: string): string {
  void name;
  throw new Error('NotImplemented: maskPayeeName');
}
