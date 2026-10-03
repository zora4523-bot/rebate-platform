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
// Log redaction (implemented in ../logging; the rule tests drive createRootLogger and
// PinoNestLogger and read the JSON lines they write):
// - A field whose key is a sensitive name (below) has its value replaced wherever it occurs: at
//   any depth of the logged object, inside arrays, in objects without a prototype and in class
//   instances, in child-logger bindings (also of a child's child), in the enumerable properties
//   of Error objects (also errors under keys other than `err` and inside arrays), along their
//   `cause` chains, in the `errors` of an AggregateError, in what a `toJSON()` returns, and in
//   objects passed as printf-style arguments (%j, %o, %O) before they are formatted into `msg`.
//   The value may be a string, a number, bytes, an array or an object: it is replaced as a
//   whole. The replacement shows no character of the original beyond what the masking above
//   would show for a phone number, an ID number or a name, and none at all for an account
//   number, an e-mail address or a credential (`[REDACTED]` is always fine).
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
// - Everything else is kept as it is: other fields and their values, the level, `msg`, and the
//   message of an error logged under `err`. The caller's objects and errors are never modified.
//   One call writes one JSON line; a circular reference does not throw.
// - PinoNestLogger redacts an object message, the optional parameters and an Error the same way;
//   an object message never reaches `msg` as JSON that still holds a sensitive value.
// - Free text (the message string, string values under other keys, an error's message and stack)
//   is not scanned: personal data never goes into free text (规划/02 §19; apps/api/AGENTS.md
//   硬规则 3, 只打平铺字段).
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
