import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { BlockedHitTarget } from './blocklist.ts';

/** BR-ID-36 / BR-WDR-29 ⑨: a decided hit, recorded on the decision's transaction. */
export interface WithdrawalReviewHit extends BlockedHitTarget {
  readonly app_id: string;
  readonly user_id: string;
  readonly withdrawal_id: string;
}

export interface WithdrawalReviewHits {
  record(trx: Transaction<DB>, input: WithdrawalReviewHit): Promise<void>;
}

/** No rule-status reader: the caller already decided that this rule was in force. */
export function createWithdrawalReviewHits(options: { clock: Clock }): WithdrawalReviewHits {
  void options;
  throw new Error('NotImplemented: createWithdrawalReviewHits');
}
