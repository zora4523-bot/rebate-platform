import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/clock/index.ts';

export type InviteRelationHitRuleId =
  'inv_08_self' | 'inv_08_descendant' | 'inv_08_same_device' | 'inv_09_same_device';

export interface InviteRelationHitInput {
  readonly app_id: string;
  /** 被邀请人；同时用作 risk_hits.ref_id。 */
  readonly user_id: string;
  readonly rule_id: InviteRelationHitRuleId;
  readonly dimension: 'user_id' | 'device_id_hash';
  /** 调用方已计算的 HMAC，原样保存。 */
  readonly value_hmac: string;
}

export interface InviteRelationHitWriter {
  /** 在调用方事务内登记规则并追加命中，risk_action 固定为 block。 */
  record(trx: Transaction<DB>, input: InviteRelationHitInput): Promise<void>;
}

export interface InviteRelationHitWriterOptions {
  readonly clock: Clock;
}

export function createInviteRelationHitWriter(
  options: InviteRelationHitWriterOptions,
): InviteRelationHitWriter {
  void options;
  throw new Error('NotImplemented: createInviteRelationHitWriter');
}
