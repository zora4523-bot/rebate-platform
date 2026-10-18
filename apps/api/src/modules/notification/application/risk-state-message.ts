import type { RiskReasonCategory, RiskState } from '@couli/contracts-ts';
import type { Clock, EventHandler, JobPayload } from '../../platform/index.ts';

/** B1-03y event snapshot; never read user_risk_state to reconstruct this payload. */
export interface RiskStateMessagePayload extends JobPayload {
  readonly app_id: string;
  readonly user_id: string;
  readonly from: RiskState;
  readonly to: RiskState;
  readonly reason_category: RiskReasonCategory | null;
  readonly frozen_until: string | null;
}

export type RiskMessageVariant = 'frozen' | 'frozen_until' | 'unfrozen' | 'banned' | 'unbanned';

export interface RiskMessageOverride {
  readonly title_override: string | null;
  readonly body_override: string | null;
}

export interface RiskStateMessage {
  readonly code: 'RISK_STATE_CHANGED';
  readonly variant: RiskMessageVariant;
  readonly category: 'service';
  readonly channels: readonly ['inbox'];
  readonly title: string;
  readonly body: string;
  readonly route: null;
}

/** BR-TEXT-23 defaults; format expiry against clock in Asia/Shanghai; unmatched transitions return null. */
export function renderRiskStateMessage(
  payload: RiskStateMessagePayload,
  override: RiskMessageOverride | null,
  clock: Clock,
): RiskStateMessage | null {
  void payload;
  void override;
  void clock;
  throw new Error('NotImplemented: renderRiskStateMessage');
}

/**
 * Uses the event consumer's transaction for template lookup and both inserts.
 * notify_logs (app_id, dedupe_key) is the final deduplication boundary; a duplicate
 * resolves successfully without a new inbox row and leaves the transaction usable.
 * All delivery timestamps come from clock, never occurredAt or database time.
 */
export function createRiskStateMessageHandler(options: { readonly clock: Clock }): EventHandler {
  void options;
  throw new Error('NotImplemented: createRiskStateMessageHandler');
}
