// Content-safety text review of a nickname (BR-ID-39; shares the review service and word bank of
// BR-AI-18). The adapter owns its own timeout and answers 'unavailable' for a timeout or an
// outage; the use case refuses to save on anything but 'pass' (fail-close, task B1-20d §9.3 #6).

export type NicknameReviewVerdict = 'pass' | 'hit' | 'unavailable';

export interface NicknameReviewInput {
  readonly appId: string;
  /** The trimmed nickname to review. */
  readonly text: string;
}

export interface NicknameReviewPort {
  review(input: NicknameReviewInput): Promise<NicknameReviewVerdict>;
}
