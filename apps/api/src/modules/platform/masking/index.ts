// Display masking of personal data, and the contract of log redaction (规划/08 BR-ID-33; 规划/02
// §12.3, §19 日志).
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
// - Every value that reaches the line (fields of the logged object, bindings given to child() or
//   setBindings() on the root logger or on any child at any level, printf arguments, the Nest
//   adapter's parameters) is written by the first of these rules that applies, at any depth:
//     under a sensitive name   "[REDACTED]", whatever the value (string, number, Buffer, array,
//                              object, Map, Set, Error): nothing of it, no partial mask
//     string, number, boolean, null   as it is
//     an object that recurs inside itself (a circular reference)   "[Circular]" where it recurs
//     an Error                 an object: type (the name of its constructor), message and stack
//                              (free text, see below), its enumerable own properties by these
//                              rules, aggregateErrors (its `errors` by these rules, when that is
//                              an array: AggregateError), cause (its own `cause` property by
//                              these rules, when it has one)
//     an object with toJSON()  what toJSON() returns, by these rules
//     an array                 each element by these rules
//     a Map or a Set           {} (as JSON.stringify writes them: nothing inside is written)
//     any other object         its enumerable own string-keyed properties by these rules (plain
//                              objects, objects without a prototype, class instances)
//   Otherwise a function or an undefined property is left out, as JSON.stringify does.
// - Values under other names (apart from the free-text keys msg, message and stack, below) are
//   structured data (order numbers, ids, amounts) and are written as they are: personal data is
//   logged only under a sensitive name (规划/02 §19;
//   apps/api/AGENTS.md 硬规则 3, 只打平铺字段).
// - An Error passed as the first argument is written under `err`, and its message is `msg` when
//   no message is given. printf-style %j, %o and %O are replaced by JSON.stringify of the
//   argument written by these rules (keys in insertion order); the rest of the message is kept.
// - Free text gets a safety net. Free text is: `msg` as finally written (the message argument,
//   a number or boolean one written as its text, after printf formatting, with a child's
//   msgPrefix in front); every string or number written under a key named exactly msg, message
//   or stack, at any depth of the logged object, of the bindings (child() and setBindings() at
//   every level) and of the Nest adapter's parameters alike, a number then written as its text
//   (so the message and stack of every Error, causes and aggregateErrors included, the msg of a
//   logged object that pino writes when the call gives no message, and the message under err
//   that pino falls back to); and the Nest adapter's context and string items of `params` (its
//   stack parameter is written under stack). In free text each match of the two patterns below
//   is replaced by "[REDACTED]" as a whole, e-mail addresses in a first pass, numbers in a
//   second; every other character is kept exactly:
//     1. an e-mail address: one or more of A-Z a-z 0-9 . _ % + -, then "@", then labels of
//        A-Z a-z 0-9 - joined by dots, the last label two or more letters (zh.san@example.com);
//     2. a number: a run of digits (ASCII 0-9 or full-width ０-９; between any two digits one
//        space or one hyphen-minus may stand) that has no digit directly before or after it and
//        is one of:
//          - a mainland mobile number: 11 digits starting with 1, optionally preceded by +86,
//            0086 or 86 and one optional space or hyphen (13987654321, 139 8765 4321,
//            139-8765-4321, +86 13987654321, 8613987654321);
//          - an ID number: 15 digits, or 17 digits followed by a digit, X or x;
//          - a bank card number: 16 to 19 digits (6222 0212 3456 7890 123).
//        Numbers are matched left to right; at each position the first kind that fits wins, in
//        the order: ID number of 18, bank card number (the longest that fits), ID number of 15,
//        mobile number.
//   Other spellings (other separators, numbers in words) and names cannot be recognised in free
//   text: they must not be put there. Free text that matches nothing is never changed.
// - After a call the caller's objects, errors and bindings are exactly as before (same own
//   properties, symbols included, and values).
// - PinoNestLogger: the last string parameter is `context`; an Error message is written under
//   `err` with its message as `msg`; a string message is `msg`; any other message becomes `msg` =
//   JSON.stringify of it written by these rules; for error and fatal a string first optional
//   parameter is `stack`; the optional parameters left are `params`, an array written by these
//   rules (context, stack and string items of params are free text, see above). Levels: log
//   info, warn warn, error error, debug debug, verbose trace, fatal fatal.
//
// Review addendum A–L (takes precedence over the original log contract above; exact outputs
// are pinned by test/spec/platform/masking/log-redaction-review.test.ts):
// A/B/C. Follow callable toJSON replacements until a terminal value, stopping a self-return.
//   Functions with toJSON follow the same rule; other functions are omitted (null in arrays).
//   Unbox String/Number/Boolean/BigInt wrappers before writing. A top-level record or binding
//   ending in a primitive, wrapper, URL or binary value contributes no fields. Structured
//   bigint is an exact JSON number; free-text bigint is scrubbed decimal text.
// D/E. printf arguments are rule copies: %s uses primitive text or JSON, except Error uses
//   "<name>: <message>"; never call the caller's toString. %j/%o/%O put string copies in single
//   quotes (pino's spelling), leave undefined placeholders, otherwise use JSON. %d/%f use
//   Number(copy), %i uses Math.floor(Number(copy)); null/undefined leave these placeholders.
//   Except %%, every placeholder consumes an argument, even unexpanded ones. Free-text context
//   follows all descendants of msg/message/stack (string/number/bigint become scrubbed strings;
//   boolean/null stay unchanged). Non-string messages use primitive text or JSON, then the net.
// F/G. Fastify access-log url is routeOptions.url or "[unmatched]", never the raw path.
//   A nested URL writes origin + pathname, without userinfo, query or fragment; free-text
//   contexts additionally scrub that string. URL handling precedes toJSON.
// H/I. Throwing getters, toJSON and serializers write "[Unserializable]" without leaking the
//   thrown value; sensitive getters are never called. Field levels 101+ write "[Truncated]".
//   Free-text processing is linear in text length. Child serializers receive original values,
//   apply to same-call bindings and are inherited; child formatters are inherited too. Their
//   outputs always pass the rules, including the final msg after serializers and msgPrefix.
// J. One space/hyphen may precede the last digit of an 18-digit ID, but not its final X/x.
// K. Buffer, TypedArray, DataView, ArrayBuffer and SharedArrayBuffer write only
//   "[Binary <byteLength> bytes]" everywhere, before toJSON; sensitive names still redact them.
// L. Non-Error values below err are free text. Error properties other than message/stack retain
//   their structured types, including when the logger copies them through multiple stages.
//
// Rules for the implementation: this directory is also compiled by the `test` project: erasable
// syntax only (no parameter properties, no enum, no namespace, no decorators), `import type` for
// type-only imports, relative imports with the `.ts` extension, no NestJS, no `process.env`, no
// new dependency.

/** BR-ID-33 default: 138****5678; anything that is not an 11-digit mainland number is all "*". */
export function maskPhone(phone: string): string {
  return phone.length === 11 && /^1[0-9]{10}$/.test(phone)
    ? `${phone.slice(0, 3)}****${phone.slice(7)}`
    : '*'.repeat([...phone].length);
}

/** BR-ID-33 default: first 1 + last 1 of an 18- or 15-character ID number; otherwise all "*". */
export function maskIdNo(idNo: string): string {
  const valid =
    (idNo.length === 18 && /^[0-9]{17}[0-9Xx]$/.test(idNo)) ||
    (idNo.length === 15 && /^[0-9]{15}$/.test(idNo));
  return valid
    ? `${idNo.charAt(0)}${'*'.repeat(idNo.length - 2)}${idNo.slice(-1)}`
    : '*'.repeat([...idNo].length);
}

/** BR-ID-33 default: only the last character of a name stays (**三); one character becomes "*". */
export function maskName(name: string): string {
  const chars = [...name];
  return chars.length < 2 ? '*'.repeat(chars.length) : '*'.repeat(chars.length - 1) + chars.at(-1);
}
