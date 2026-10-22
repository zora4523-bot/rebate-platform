import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface PendingSnapshotInput {
  readonly appId: string;
  readonly orderId: string;
  readonly commissionVersion: number;
}

/** B2-04i 返回值的结构化子集；由公开的 readCommissionSnapshot 注入。 */
export interface PendingSnapshot {
  readonly reserveBp: number;
  readonly beneficiaries: readonly {
    readonly userId: string;
    readonly role: 'self' | 'share' | 'direct' | 'indirect';
    readonly ratioBp: number;
    readonly initialStatus: 'active' | 'forfeited';
  }[];
  readonly forfeitedEvents: readonly {
    readonly userId: string;
    readonly role: 'self' | 'share' | 'direct' | 'indirect';
  }[];
}

/** B2-04w 尚未提供 ledger 类型；合并后由编排对齐此临时端口。金额均为整数分。 */
export interface UserPendingEarnings {
  readonly estimated_total_fen: bigint;
  readonly estimated_fen: bigint;
  readonly pending_credit_fen: bigint;
  readonly pending_credit_paused_fen: bigint;
  readonly next_credit_period: string | null;
  readonly credit_overdue: boolean;
}

export interface AppPendingEarnings {
  readonly total_waiting_fen: bigint;
  readonly total_estimated_fen: bigint;
}

export interface PendingEarningsSource {
  forUser(
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly userId: string },
  ): Promise<UserPendingEarnings>;
  forApp(trx: Transaction<DB>, input: { readonly appId: string }): Promise<AppPendingEarnings>;
}

export interface PendingEarningsDependencies {
  readonly clock: Clock;
  readonly config: { get(appId: string, key: string): Promise<unknown> };
  readonly readSnapshot: (
    trx: Transaction<DB>,
    input: PendingSnapshotInput,
  ) => Promise<PendingSnapshot | null>;
  /**
   * 与快照读取共用调用方事务，返回不可变的 commission_splits.tlj_deduct_fen。
   * TODO(规划/11 §7.1): 由 commission 公开端口接线 — blocked on B2-04i 未暴露淘礼金扣减额。
   * 不允许因端口缺失默认返回零，settlement 不跨模块直读 commission 表。
   */
  readonly readTljDeductFen: (trx: Transaction<DB>, input: PendingSnapshotInput) => Promise<bigint>;
}

/** BR-FUND-18：只读调用方事务，时间取 Clock，日期计算交给 domain。 */
export function createPendingEarningsSource(
  deps: PendingEarningsDependencies,
): PendingEarningsSource {
  void deps;
  throw new Error('NotImplemented: createPendingEarningsSource');
}
