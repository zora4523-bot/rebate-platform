// The optional free-text reason of union's admin writes (B1-22r, orchestrator ruling D10-427 ①;
// contract AdminUnionOptionalReason): alert phone add, re-authorization start, manual credential
// entry and the union-pids create / update / activate / retire. Absent is valid; given, it must be
// a string of 1–200 characters without any Unicode Cc control character (U+0000–U+001F,
// U+007F–U+009F). Anything else is answered 20001 with data.fields=[reason] before any write, audit
// row or outside call. Other invisible characters (format, separators) are not control characters
// and stay valid. Pure function, no framework import.

/** True when `value` is absent or a valid reason; false means 20001 [reason]. */
export function validAdminUnionReason(value: unknown): boolean {
  void value;
  throw new Error('NotImplemented: validAdminUnionReason');
}
