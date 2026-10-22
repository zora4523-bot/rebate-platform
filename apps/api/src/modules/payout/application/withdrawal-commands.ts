import type { DB } from '@couli/db';
import type { WithdrawalState } from '@couli/domain';
import type { Transaction } from 'kysely';
import type { Ledger } from '../../ledger/index.ts';
import type { Clock, EventBus } from '../../platform/index.ts';
import type { WithdrawApplyOptions } from './withdraw-apply.ts';

export type WithdrawalAttemptResult = 'pending' | 'success' | 'unknown' | 'fail';
export interface WithdrawalAttemptsPort {
  /** Omitted results means ANY transfer attempt, including a definite failure. */
  hasAttempt(
    trx: Transaction<DB>,
    withdrawalId: string,
    kinds: readonly ('transfer' | 'query')[],
    results?: readonly WithdrawalAttemptResult[],
  ): Promise<boolean>;
}
export interface WithdrawalCommandsOptions {
  clock: Clock;
  ledger: Ledger;
  lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  attempts: WithdrawalAttemptsPort;
  eventBus: EventBus;
}
export interface WithdrawalCommand {
  appId: string;
  withdrawalId: string;
  expectedStatus: WithdrawalState;
  expectedRowVersion: number;
  reviewerId: string | null;
}
export type WithdrawalRejectReason =
  | 'RISK_SUSPECT'
  | 'ORDER_ABNORMAL'
  | 'PAYEE_INFO_INVALID'
  | 'USER_REQUEST'
  | 'OTHER'
  | 'NEGATIVE_BALANCE';
export interface RejectWithdrawalCommand extends WithdrawalCommand {
  reasonCode: WithdrawalRejectReason;
  note: string | null;
}
export type WithdrawalCommandResult =
  | { kind: 'changed'; status: WithdrawalState }
  | {
      kind: 'refused';
      reason:
        'negative_balance' | 'blocked' | 'reason_required' | 'attempt_exists' | 'invalid_state';
    };
export interface WithdrawalCommands {
  approve(trx: Transaction<DB>, input: WithdrawalCommand): Promise<WithdrawalCommandResult>;
  reject(trx: Transaction<DB>, input: RejectWithdrawalCommand): Promise<WithdrawalCommandResult>;
  systemRejectNegative(
    trx: Transaction<DB>,
    input: WithdrawalCommand,
  ): Promise<WithdrawalCommandResult>;
}
export class WithdrawalConflictError extends Error {
  declare readonly code: 20902;
  declare readonly data: { resource: 'withdrawal' };
  constructor() {
    super('NotImplemented: WithdrawalConflictError');
    throw new Error('NotImplemented: WithdrawalConflictError');
  }
}
export function createWithdrawalCommands(options: WithdrawalCommandsOptions): WithdrawalCommands {
  void options;
  throw new Error('NotImplemented: createWithdrawalCommands');
}
