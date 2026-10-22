import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { PushDeliveryChannel } from '../ports/push-delivery.ts';

export type PushCategory = 'service' | 'subscription' | 'marketing';

export interface PushSendInput {
  readonly app_id: string;
  readonly user_id: string;
  readonly code: string;
  readonly variant: string;
  readonly eventKey: string;
  readonly title: string;
  readonly body: string;
  readonly route: Readonly<Record<string, unknown>> | null;
  /** Code registry fallback, used only when this app/code/variant has no template row. */
  readonly category: PushCategory;
}

/** Lookup information only; dispatch reads the committed message for its payload. */
export type PushEvent = Pick<
  PushSendInput,
  'app_id' | 'user_id' | 'code' | 'variant' | 'eventKey' | 'category'
>;

export type PushDispatchOutcome = 'skipped' | 'suppressed' | 'success' | 'failed' | 'unknown';

export interface PushSendOptions {
  readonly clock: Clock;
  readonly channel: PushDeliveryChannel;
  /** Structural read port; app composition supplies identity's public reader. */
  readonly sessionValidity: (
    executor: Kysely<DB> | Transaction<DB>,
    query: { readonly app_id: string; readonly user_id: string; readonly sids: readonly string[] },
  ) => Promise<ReadonlySet<string>>;
}

export interface PushSendCore {
  /**
   * Caller transaction: dedupe by (app_id,eventKey), insert inbox + successful inbox log and
   * push log (eventKey + ':push', queued, row_version=0; disabled => suppressed(push_disabled)).
   * Never calls the channel. All three writes commit or roll back together.
   */
  record(transaction: Transaction<DB>, input: PushSendInput): Promise<void>;
  /**
   * Root handle only, after record commits; reject transaction handles. Own transactions lock
   * and recheck settings and eligible registrations. Disabled => suppressed(push_disabled);
   * no eligible registration => failed. Invalid bindings are cleared using
   * unbindPushTokensForSession with the observed user_id and bound_sid.
   * Commit claim (queued row_version 0→1) before calling the channel once for all valid devices.
   * Then persist accepted→success / rejected→failed. Unknown result or result-write failure
   * leaves queued row_version>=1, never resent. Unclaimed queued rows may be dispatched again.
   */
  dispatch(db: Kysely<DB>, event: PushEvent): Promise<PushDispatchOutcome>;
}

export function createPushSendCore(options: PushSendOptions): PushSendCore {
  void options;
  throw new Error('NotImplemented: createPushSendCore');
}
