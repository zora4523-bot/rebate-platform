// The two-element real-name verification port (规划/08 BR-ID-25; task B1-13d §9.2 #6): name plus an
// 18-digit resident ID number, no face data. The application calls it at most once per counted
// attempt, after the format, age, daily-attempt and occupied-ID checks.
// - match / mismatch: a definite answer of the vendor (counts one attempt); `provider` names the
//   vendor (non-blank, stored in realname.provider).
// - timeout / unavailable: no definite answer (released, not counted; 50401 / 50301). A rejection
//   is treated as unavailable; its error is never logged or echoed (it may carry the submitted
//   values).
// The adapter owns its own timeout. Only the fake adapter exists (local / test); staging / prod
// inject none until a vendor is chosen (50301).
//
// Also compiled by the `test` project: erasable syntax only.

/** BR-ID-25: two elements only; no face data. Provider errors contain no submitted PII. */
export interface RealnameVerificationInput {
  readonly app_id: string;
  readonly user_id: string;
  readonly name: string;
  readonly id_no: string;
}

export type RealnameVerificationResult =
  | { readonly outcome: 'match' | 'mismatch'; readonly provider: string }
  | { readonly outcome: 'timeout' | 'unavailable' };

export interface RealnameVerifierPort {
  verify(input: RealnameVerificationInput): Promise<RealnameVerificationResult>;
}
