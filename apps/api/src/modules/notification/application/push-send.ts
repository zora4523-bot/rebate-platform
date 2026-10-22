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
   * Caller transaction: dedupe by (app_id,eventKey), insert inbox + successful inbox log before
   * push; push log uses eventKey + ':push'. Disabled category => suppressed(push_disabled).
   * No eligible registration => failed, never suppressed. Invalid bindings are cleared using
   * unbindPushTokensForSession with the observed user_id and bound_sid. All valid devices receive
   * the same minimal payload in one channel call. Duplicate events never call the channel again.
   */
  send(transaction: Transaction<DB>, input: PushSendInput): Promise<void>;
}

export function createPushSendCore(options: PushSendOptions): PushSendCore {
  void options;
  throw new Error('NotImplemented: createPushSendCore');
}
