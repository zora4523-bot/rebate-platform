import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { AuditPort, Clock } from '../../platform/index.ts';
import type { WithdrawApplyOptions } from './withdraw-apply.ts';

export interface WithdrawHoldsOptions {
  clock: Clock;
  lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  audit: AuditPort;
}
export interface AddWithdrawHold {
  appId: string;
  userId: string;
  reason: 'manual' | 'recon_diff' | 'ledger_mismatch' | 'manual_failed_watch';
  sourceRef: string | null;
  createdBy: string;
  holdUntil: Date | null;
}
export interface WithdrawHolds {
  add(trx: Transaction<DB>, input: AddWithdrawHold): Promise<{ id: string }>;
  release(trx: Transaction<DB>, input: { holdId: string; releasedBy: string }): Promise<void>;
}
export function createWithdrawHolds(options: WithdrawHoldsOptions): WithdrawHolds {
  void options;
  throw new Error('NotImplemented: createWithdrawHolds');
}
