import type { AppealStatus, AppealTargetType } from '@couli/contracts-ts';
import type { Clock, EventHandler, JobPayload } from '../../platform/index.ts';

/** B1-12p / BR-ID-36: resolved event snapshot, including the reauthorization decision. */
export interface AppealResultMessagePayload extends JobPayload {
  readonly app_id: string;
  readonly appeal_id: string;
  readonly user_id: string | null;
  readonly target_type: AppealTargetType;
  readonly target_id: string;
  readonly status: Extract<AppealStatus, 'revoked' | 'upheld'>;
  readonly need_reauth: boolean;
}

export type AppealResultVariant = 'account_revoked' | 'order_revoked' | 'upheld';

export interface AppealResultOverride {
  readonly title_override: string | null;
  readonly body_override: string | null;
}

export interface AppealResultMessage {
  readonly code: 'APPEAL_RESULT';
  readonly variant: AppealResultVariant;
  readonly category: 'service';
  readonly channels: readonly ['inbox'];
  readonly title: string;
  readonly body: string;
  readonly route: null;
}

/** BR-TEXT-23 defaults and independent overrides; blocked_request yields no message. */
export function renderAppealResultMessage(
  payload: AppealResultMessagePayload,
  override: AppealResultOverride | null,
): AppealResultMessage | null {
  void payload;
  void override;
  throw new Error('NotImplemented: renderAppealResultMessage');
}

/** Uses the consumer transaction for both inserts, deduplicated by app_id and event_id. */
export function createAppealResultMessageHandler(options: { readonly clock: Clock }): EventHandler {
  void options;
  throw new Error('NotImplemented: createAppealResultMessageHandler');
}
