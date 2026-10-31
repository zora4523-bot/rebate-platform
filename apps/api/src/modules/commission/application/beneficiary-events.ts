// B2-04zd (D10-443): the writer of commission_split_beneficiary_events (BR-CALC-13; commission is
// the table's single writer). Same input shape as settlement credit-order's BeneficiaryEventInput.
// Appends one row on the caller's transaction (created_at from the injected Clock); never updates
// or deletes an event.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export type BeneficiaryEventRole = 'self' | 'share' | 'direct' | 'indirect';

export type BeneficiaryEventForfeitReason = 'banned' | 'deleted' | 'minor';

export interface BeneficiaryEventInput {
  readonly appId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly role: BeneficiaryEventRole;
  /** active: B2-09g, an appeal restore of the share (BR-FUND-22 ③, BR-CALC-09). */
  readonly status: 'active' | 'held' | 'forfeited';
  /** forfeited: banned | deleted | minor; held and active: null. */
  readonly reason: BeneficiaryEventForfeitReason | null;
}

export interface BeneficiaryEventDependencies {
  readonly clock: Clock;
}

export async function appendBeneficiaryEvent(
  trx: Transaction<DB>,
  input: BeneficiaryEventInput,
  dependencies: BeneficiaryEventDependencies,
): Promise<void> {
  if (input.status === 'forfeited' ? input.reason === null : input.reason !== null) {
    throw new Error('commission beneficiary event: reason does not match status');
  }
  await trx
    .withSchema('app')
    .insertInto('commission_split_beneficiary_events')
    .values({
      app_id: input.appId,
      order_id: input.orderId,
      user_id: input.userId,
      role: input.role,
      status: input.status,
      reason: input.reason,
      created_at: dependencies.clock.now(),
    })
    .execute();
}
