import type { ClaimEntryFacts, ClaimEntryScope } from '../../linking/index.ts';

export interface ClaimEntryInput extends ClaimEntryFacts, ClaimEntryScope {
  readonly now: Date;
  /** Latest attr_at among this App's orders owned by this user, without list filters. */
  readonly latest_order_attr_at: Date | null;
}

/** BR-ATTR-17 / AC-S1-25②: latest eligible jump, then [30 minutes,72 hours], then any order. */
export function claimEntryPinned(input: ClaimEntryInput): boolean {
  void input;
  throw new Error('NotImplemented: claimEntryPinned');
}
