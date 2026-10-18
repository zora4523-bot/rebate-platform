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
