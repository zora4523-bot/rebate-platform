// Display masking of personal data, and the contract of log redaction (规划/08 BR-ID-33; 规划/02
// §12.3, §19 日志). Every function below throws `NotImplemented` until task B1-01c implements it.
// The rule tests in test/spec/platform/masking/** import this file and
// apps/api/src/modules/platform/logging/index.ts by path; names, signatures and the semantics
// written here are the contract.
//
// Masking (BR-ID-33 默认脱敏格式). Lengths count Unicode code points (`[...text]`), not UTF-16
// units. None of the three functions throws for any string; the empty string stays empty.
//   maskPhone   a mainland mobile number, exactly 11 ASCII digits starting with 1
//               (/^1[0-9]{10}$/): the first 3 + "****" + the last 4 → 138****5678. Anything else
//               (other lengths, +86, spaces, dashes, full-width digits, letters): one "*" per
//               code point, so no character is revealed.
//   maskIdNo    an ID card number: 17 ASCII digits followed by a digit, X or x (18 characters),
//               or 15 ASCII digits: the first 1 + one "*" per hidden character + the last 1 →
//               1****************X, 1*************2. Anything else: one "*" per code point.
//   maskName    n ≥ 2 code points: n − 1 "*" + the last code point → **三 (张小三), *四 (李四),
//               ***月 (欧阳明月). A single code point: "*".
//
// Log redaction (implemented in ../logging). Logs never show any part of a sensitive value: the
// only replacement is the string "[REDACTED]" (stricter than the display masking above, which
// is for screens, not logs). The rule tests drive createRootLogger and PinoNestLogger and compare
// every JSON line they write with an exact expected record (deep equality after parsing, no key
// twice in an object), so the output below is the contract, not an example.
// - One call writes one JSON line ending in "\n": the base fields level, time (ISO), pid, entry
//   and env; then the bindings of the child loggers; then the fields of the logged object; then
//   `msg` when there is a message. (A log call that repeats a key of its bindings gets both, as
//   pino writes them; the rule tests never do that.)
// - Sensitive names are compared after lower-casing and dropping every character that is not an
//   ASCII letter or digit, so bank_card_no, bankCardNo, BANK_CARD_NO and bank-card-no are one
//   name:
//     personal data  phone, phones, mobile, mobile_phone, phone_number, contact_phone,
//                    auth_alert_phones, id_no, id_card, id_card_no, id_number, birth_date,
//                    real_name (also realname, a whole realname record), payee_name,
//                    alipay_logon_id, alipay_account, bank_card_no, card_no, payee_account
//     credentials    authorization, cookie, set-cookie, password, token, access_token,
//                    refresh_token, step_up_token, x-step-up-token, x-sign, secret
//   `name` is not on the list (too generic: a route, a product, a file); a person's name is
//   logged as real_name / payee_name, or inside a realname object.
// - Every value that reaches the line (fields of the logged object, child-logger bindings at
//   every level, printf arguments, the Nest adapter's parameters) is written by the first of
//   these rules that applies, at any depth:
//     under a sensitive name   "[REDACTED]", whatever the value (string, number, Buffer, array,
//                              object, Map, Set, Error): nothing of it, no partial mask
//     string, number, boolean, null   as it is
//     an object that recurs inside itself (a circular reference)   "[Circular]" where it recurs
//     an Error                 an object: type (the name of its constructor), message and stack
//                              (exactly as they are), its enumerable own properties by these
//                              rules, aggregateErrors (its `errors` by these rules, when that is
//                              an array: AggregateError), cause (its own `cause` property by
//                              these rules, when it has one)
//     an object with toJSON()  what toJSON() returns, by these rules
//     an array                 each element by these rules
//     a Map or a Set           {} (as JSON.stringify writes them: nothing inside is written)
//     any other object         its enumerable own string-keyed properties by these rules (plain
//                              objects, objects without a prototype, class instances)
//   Otherwise a function or an undefined property is left out, as JSON.stringify does.
// - Values under other names are not inspected for personal data: personal data is logged only
//   under a sensitive name, never under another name and never in free text.
// - An Error passed as the first argument is written under `err`, and its message is `msg` when
//   no message is given. printf-style %j, %o and %O are replaced by JSON.stringify of the
//   argument written by these rules (keys in insertion order); the rest of the message is kept.
// - Free text is never changed and never scanned: the message, string values under other keys,
//   an error's message and stack. Personal data never goes into free text (规划/02 §19;
//   apps/api/AGENTS.md 硬规则 3, 只打平铺字段).
// - After a call the caller's objects, errors and bindings are exactly as before (same own
//   properties, symbols included, and values).
// - PinoNestLogger: the last string parameter is `context`; an Error message is written under
//   `err` with its message as `msg`; a string message is `msg`; any other message becomes `msg` =
//   JSON.stringify of it written by these rules; for error and fatal a string first optional
//   parameter is `stack` (kept as it is); the optional parameters left are `params`, an array
//   written by these rules. Levels: log info, warn warn, error error, debug debug, verbose trace,
//   fatal fatal.
//
// Rules for the implementation: this directory is also compiled by the `test` project: erasable
// syntax only (no parameter properties, no enum, no namespace, no decorators), `import type` for
// type-only imports, relative imports with the `.ts` extension, no NestJS, no `process.env`, no
// new dependency.

/** BR-ID-33 default: 138****5678; anything that is not an 11-digit mainland number is all "*". */
export function maskPhone(phone: string): string {
  void phone;
  throw new Error('NotImplemented');
}

/** BR-ID-33 default: first 1 + last 1 of an 18- or 15-character ID number; otherwise all "*". */
export function maskIdNo(idNo: string): string {
  void idNo;
  throw new Error('NotImplemented');
}

/** BR-ID-33 default: only the last character of a name stays (**三); one character becomes "*". */
export function maskName(name: string): string {
  void name;
  throw new Error('NotImplemented');
}
