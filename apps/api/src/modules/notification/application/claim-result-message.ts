import type { Clock, EventHandler, JobPayload } from '../../platform/index.ts';

export interface ClaimResultMessagePayload extends JobPayload {
  readonly app_id: string;
  readonly claim_id: string;
  readonly user_id: string;
  readonly status: string;
}

export interface ClaimResultOverride {
  readonly title_override: string | null;
  readonly body_override: string | null;
}

export interface ClaimResultMessage {
  readonly code: 'CLAIM_RESULT';
  readonly variant: 'approved' | 'rejected';
  readonly category: 'service';
  readonly channels: readonly ['inbox'];
  readonly title: string;
  readonly body: string;
  readonly route: null;
}

/** BR-TEXT-09: amount is the applicant's summed current-version shares, in integer fen. */
export function renderClaimResultMessage(
  input: {
    readonly status: string;
    readonly rebate_fen: bigint;
    readonly reject_reason: string | null;
  },
  override: ClaimResultOverride | null,
): ClaimResultMessage | null {
  void input;
  void override;
  throw new Error('NotImplemented: renderClaimResultMessage');
}

/** Reads orders/commission through their public ports and writes in the supplied event transaction. */
export function createClaimResultMessageHandler(options: { readonly clock: Clock }): EventHandler {
  void options;
  throw new Error('NotImplemented: createClaimResultMessageHandler');
}
